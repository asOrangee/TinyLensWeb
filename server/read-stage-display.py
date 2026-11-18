"""Read one reported display manifest and its exact, checked dependencies over SSH."""

import base64
import hashlib
import json
import math
import sys
from pathlib import Path

META = 2 * 1024 * 1024
FITS = 16 * 1024 * 1024
PARAMETERS = 12 * 1024 * 1024
MAPPING = 4 * 1024 * 1024
STAGES = ("a", "b", "m0", "m1", "m2", "m3")
LEGACY_SCHEMA = "tinylens.stage-display.v1"
CONTRACT = json.loads(
    DISPLAY_CONTRACT_JSON if "DISPLAY_CONTRACT_JSON" in globals()
    else (Path(__file__).resolve().parents[1] / "pipeline/src/lens_agent/display_contract.json").read_text(encoding="utf-8")
)
NAMED_SCHEMAS = (CONTRACT["schema"], CONTRACT["previousNamedSchema"])
DISPLAY_REFERENCES = tuple({"schema": name, "path": CONTRACT["directory"]} for name in NAMED_SCHEMAS)


def read_file(path, root, limit=META):
    if not path.is_relative_to(root) or path.resolve(strict=True) != path or not path.is_file():
        raise ValueError("Display dependency leaves its stage or run")
    if path.stat().st_size > limit:
        raise ValueError("Display dependency exceeds size limit")
    with path.open("rb") as handle:
        value = handle.read(limit + 1)
    if len(value) > limit:
        raise ValueError("Display dependency exceeds size limit")
    return value


def digest(value):
    return hashlib.sha256(value).hexdigest()


def reject_nonfinite(value):
    raise ValueError(f"Invalid JSON number {value}")


def verified_file(ref, base, relative, limit=META):
    if ref["path"] != relative:
        raise ValueError("Unexpected display dependency")
    value = read_file(base / relative, base, limit)
    if digest(value) != ref["sha256"]:
        raise ValueError("Display dependency checksum mismatch")
    return value


def named_fits(manifest, folder):
    stage = manifest["stage"]
    kind = stage if stage in ("preflight", "b") else "model"
    required = set(CONTRACT["required"][kind])
    allowed = required | set(CONTRACT["optional"].get(kind, ()))
    entries = manifest["planes"]
    if not required <= entries.keys() <= allowed:
        raise ValueError("Missing or unexpected named display image")
    prefix = CONTRACT["stagePrefixes"][stage]
    return {
        role: base64.b64encode(verified_file(
            entry, folder, f'{CONTRACT["directory"]}/{prefix}_{CONTRACT["imageNames"][role]}.fits', FITS
        )).decode()
        for role, entry in entries.items()
    }


def parameter_packet(manifest, folder, frozen):
    stage = manifest["stage"]
    file = CONTRACT["parameterFile"]
    name = f'{CONTRACT["directory"]}/{CONTRACT["stagePrefixes"][stage]}_{file["suffix"]}'
    packet = json.loads(verified_file(manifest["parameters"], folder, name, PARAMETERS), parse_constant=reject_nonfinite)
    if packet["schema"] != file["schema"] or any(
        packet[key] != manifest[key] for key in ("run", "lens_id", "stage", "attempt")
    ) or packet["input_sha256"] != manifest["input"]["sha256"]:
        raise ValueError("Published parameter identity mismatch")
    settings = packet["config"]["settings"]
    metrics = packet["metrics"]
    if not isinstance(settings, dict) or not isinstance(metrics, dict):
        raise ValueError("Invalid display parameter groups")
    geometry = frozen["input_geometry"]
    if (stage == "preflight" and metrics.get("input_geometry") != geometry) or (
        stage != "preflight" and any(settings.get(key) != value for key, value in geometry.items())
    ):
        raise ValueError("Published parameter geometry mismatch")
    fixed = packet.get("fixed_parameters", {})
    linear = packet.get("linear_parameters", {})
    if not isinstance(fixed, dict) or any(type(value) not in (int, float) for value in fixed.values()) or not isinstance(linear, dict):
        raise ValueError("Invalid fixed or linear parameters")
    for key, value in linear.items():
        if key == "source_brightness" and stage in ("m0", "m1", "m2", "m3"):
            source = manifest["planes"]["source"]
            if (value["fits"], value["shape"]) != (Path(source["path"]).name, source["shape"]):
                raise ValueError("Linear solution references a different source image")
        elif stage == "a" and key in ("lens_mge_amplitudes", "source_mge_amplitudes"):
            if not isinstance(value.get("values"), list) or any(type(item) not in (int, float) for item in value["values"]):
                raise ValueError("Invalid MGE linear solution")
        else:
            raise ValueError("Unexpected linear parameter")
    return packet


def mapping_packet(manifest, folder):
    stage = manifest["stage"]
    file = CONTRACT["mappingFile"]
    name = f'{CONTRACT["directory"]}/{CONTRACT["stagePrefixes"][stage]}_{file["suffix"]}'
    packet = json.loads(verified_file(manifest["mapping_file"], folder, name, MAPPING), parse_constant=reject_nonfinite)
    if (packet["schema"] != file["schema"] or packet["synthetic"] is not False
            or any(packet.get(key) != manifest.get(key) for key in ("run", "run_id", "lens_id", "stage", "attempt"))
            or packet["fits_sha256"] != manifest["input"]["sha256"] or packet["summary_sha256"] != manifest["summary"]["sha256"]):
        raise ValueError("Published lens mapping belongs to a different attempt")
    if packet["coordinates"] != {"unit": "arcsec", "origin": "geometric-center", "x": "right", "y": "up"}:
        raise ValueError("Invalid lens mapping coordinates")
    for frame, role in (("image", "observation"), ("source", "source")):
        plane = manifest["planes"][role]
        bounds = plane["bounds_arcsec"]
        if packet["frames"][frame] != {"shape": plane["shape"], "bounds_arcsec": bounds,
                                        "fits_sha256": plane["sha256"], "half_extent_arcsec": (bounds[3] - bounds[2]) / 2}:
            raise ValueError("Lens mapping frame does not match its FITS file")
    sampling = packet["curve_sampling"]
    if (sampling["bounds_arcsec"] != packet["frames"]["image"]["bounds_arcsec"]
            or type(sampling["n_grid"]) is not int or sampling["n_grid"] < 2):
        raise ValueError("Lens curve sampling does not match the image frame")
    curves = packet["curves"]
    if curves is not None:
        if not isinstance(curves, list):
            raise ValueError("Invalid published lens curves")
        for pair in curves:
            image, source = pair["critical"], pair["caustic"]
            if (not isinstance(image, list) or not isinstance(source, list)
                    or len(image) != len(source) or len(image) < 2 or type(pair["closed"]) is not bool
                    or any(type(point[key]) not in (int, float) or not math.isfinite(point[key])
                           for points in (image, source) for point in points for key in ("x", "y"))):
                raise ValueError("Invalid published critical curve and caustic pair")
    json.dumps(packet, allow_nan=False)
    return packet


def read_display(request):
    root = Path(request["root"]).resolve(strict=True) / "output"
    original_run = Path(request["run"])
    run = Path(request.get("storageRun", request["run"]))
    if run != original_run:
        prefix = original_run.name + "_old_"
        if (not request.get("runId") or run.parent != original_run.parent / "_archive"
                or not run.name.startswith(prefix) or not run.name[len(prefix):].isdecimal()):
            raise ValueError("Invalid reported archive")
    if not original_run.is_relative_to(root) or not run.is_relative_to(root):
        raise ValueError("Run leaves the output directory")
    report = Path(request["path"])
    stage, attempt = request["stage"], request["attempt"]
    if stage == "preflight" and attempt is None:
        folder = run / "preflight"
    elif stage in STAGES and type(attempt) is int and attempt >= 0:
        folder = run / "attempts" / stage / str(attempt)
    else:
        raise ValueError("Invalid stage display identity")
    manifest_path = folder / "display-manifest.json"
    display_dir = folder / CONTRACT["directory"]
    declaration = folder / ("inspection.json" if stage == "preflight" else "stage-result.json")
    declaration_sha = None
    declaration_schema = None
    if not report.is_relative_to(original_run):
        raise ValueError("Display report leaves the original run")
    anchor = run / report.relative_to(original_run)
    if anchor == declaration:
        declared = read_file(declaration, root)
        reference = json.loads(declared).get("display")
        if reference not in (
            *DISPLAY_REFERENCES, {"schema": LEGACY_SCHEMA, "path": "display-manifest.json"}
        ):
            raise ValueError("Reported stage does not declare a display package")
        declaration_sha = digest(declared)
        declaration_schema = reference["schema"]
    elif anchor not in (manifest_path, display_dir):
        raise ValueError("An explicit stage display report is required")

    raw = read_file(manifest_path, root)
    manifest = json.loads(raw)
    named = manifest.get("schema") in NAMED_SCHEMAS
    current = manifest.get("schema") == CONTRACT["schema"]
    if (
        (not named and manifest.get("schema") != LEGACY_SCHEMA)
        or (declaration_schema is not None and manifest["schema"] != declaration_schema)
        or (anchor == display_dir and (not named or display_dir.resolve(strict=True) != display_dir))
        or manifest["run"] != str(original_run)
        or manifest["lens_id"] != original_run.name
        or manifest["stage"] != stage
        or manifest["attempt"] != attempt
    ):
        raise ValueError("Published display identity mismatch")
    frozen = json.loads(verified_file(manifest["run_manifest"], run, "run-manifest.json"))
    if manifest.get("run_id") != frozen.get("run_id") or request.get("runId") != frozen.get("run_id"):
        raise ValueError("Manifest and reported run version disagree")
    lens = Path(frozen["lens_dir"])
    pixel = manifest["input"]["pixel_scale_arcsec"]
    input_path = Path(manifest["input"]["path"])
    if (
        frozen["schema_version"] != "lens_run_manifest.v1"
        or lens.name != original_run.name or not lens.is_absolute()
        or input_path != lens / (lens.name + ".fits")
        or not math.isfinite(pixel) or pixel <= 0
        or pixel != frozen["input_geometry"]["pixel_scale_arcsec"]
    ):
        raise ValueError("Published input does not match the frozen run")

    declared = manifest["upstream"]
    expected = [] if stage == "preflight" else list(STAGES[:STAGES.index(stage)])
    if sorted(entry["stage"] for entry in declared) != sorted(expected):
        raise ValueError("Missing or ambiguous upstream stage")
    for entry in declared:
        name, index = entry["stage"], entry["attempt"]
        if type(index) is not int or index < 0:
            raise ValueError("Invalid upstream attempt")
        upstream = json.loads(verified_file(entry, run, f"attempts/{name}/{index}/stage-result.json"))
        if upstream["lens_id"] != original_run.name or upstream["stage"] != name or upstream["attempt"] != index:
            raise ValueError("Upstream attempt identity mismatch")

    result = {"manifest": manifest, "manifest_sha256": digest(raw)}
    if named:
        try:
            result["fits_files"] = named_fits(manifest, folder)
        except (OSError, KeyError, TypeError, ValueError):
            if not current:
                raise
    else:
        result["fits_base64"] = base64.b64encode(verified_file(manifest["fits"], folder, "display.fits", FITS)).decode()
    if current and "parameters" in manifest:
        try:
            result["parameter_packet"] = parameter_packet(manifest, folder, frozen)
        except (OSError, KeyError, TypeError, ValueError):
            pass
    if stage == "preflight":
        packet_bytes = verified_file(manifest["inspection"], folder, "inspection.json")
        if declaration_sha is not None and declaration_sha != digest(packet_bytes):
            raise ValueError("The display declaration changed")
        packet = json.loads(packet_bytes)
        if packet["schema_version"] != "inspection_packet.v5" or (
            packet["lens_id"], packet["lens_dir"], packet["input_geometry"]
        ) != (original_run.name, str(lens), frozen["input_geometry"]):
            raise ValueError("Published preflight input mismatch")
        result["image_shape"] = packet["image_shape"]
    else:
        summary_bytes = verified_file(manifest["summary"], folder, "stage-result.json")
        if declaration_sha is not None and declaration_sha != digest(summary_bytes):
            raise ValueError("The display declaration changed")
        result["summary"] = json.loads(summary_bytes)
        if not current:
            result["configuration"] = json.loads(
                verified_file(manifest["configuration"], folder, "effective-config.json")
            )
        summary = result["summary"]
        if (summary["lens_id"], summary["stage"], summary["attempt"], summary["status"]) != (
            original_run.name, stage, attempt, "success"
        ) or (not current and any(result["configuration"]["settings"].get(key) != value
                                  for key, value in frozen["input_geometry"].items())):
            raise ValueError("Published stage summary or geometry mismatch")
        if stage == "b":
            if summary["artifacts"].get("feature_mask_fits") != "artifacts/feature_mask.fits":
                raise ValueError("Unknown feature mask file")
            try:
                verified_file(manifest["feature_mask"], run, f"attempts/b/{attempt}/artifacts/feature_mask.fits", FITS)
                verified_file(manifest["modeling_mask"], run, "preflight/modeling_mask.fits", FITS)
            except (OSError, KeyError, TypeError, ValueError):
                if not current:
                    raise
                result.pop("fits_files", None)
        elif not current and "parameters" in manifest:
            try:
                result["parameters"] = json.loads(verified_file(manifest["parameters"], folder, "display-parameters.json", PARAMETERS))
            except (OSError, KeyError, TypeError, ValueError):
                # A parameter-file failure does not affect the verified images.
                pass
        if current and stage in ("a", "m0", "m1", "m2", "m3") and "mapping_file" in manifest:
            try:
                result["mapping_packet"] = mapping_packet(manifest, folder)
            except (OSError, KeyError, TypeError, ValueError, OverflowError):
                # An unavailable overlay leaves this attempt's images and parameters visible.
                pass
    return result


if __name__ == "__main__":
    print(json.dumps(read_display(json.loads(sys.stdin.readline())), allow_nan=False, separators=(",", ":")))
