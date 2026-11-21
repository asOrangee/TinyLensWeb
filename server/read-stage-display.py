"""Read one reported display manifest and its exact, checked dependencies over SSH."""

import base64
import hashlib
import io
import json
import math
import pickle
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

META = 2 * 1024 * 1024
FITS = 16 * 1024 * 1024
PARAMETERS = 12 * 1024 * 1024
MAPPING = 4 * 1024 * 1024
PNG = 8 * 1024 * 1024
PNG_TOTAL = 16 * 1024 * 1024
POSTERIOR = 64 * 1024 * 1024
JOINT = 36 * 1024 * 1024
MAX_DENSITY_BINS = 1024
MAX_CONTOUR_VERTICES = 36_000
JOINT_PROBABILITIES = (0.68, 0.95)
MAX_HISTORY_BATCH_SIZE = 32
STAGES = ("a", "b", "m0", "m1", "m2", "m3")
EXTRA_VIEWS = ("raw_artifacts", "mask_layers", "joint_posterior", "joint_parameters", "joint_density",
               "inherited_configuration", "history_lineage")
JOINT_DISPLAY_VIEWS = ("joint_parameters", "joint_density")
UNAVAILABLE = (OSError, KeyError, TypeError, ValueError, OverflowError)
LEGACY_SCHEMA = "tinylens.stage-display.v1"
CONTRACT = json.loads(
    DISPLAY_CONTRACT_JSON if "DISPLAY_CONTRACT_JSON" in globals()
    else (Path(__file__).resolve().parents[1] / "pipeline/src/lens_agent/display_contract.json").read_text(encoding="utf-8")
)
NAMED_SCHEMAS = (CONTRACT["schema"], CONTRACT["previousNamedSchema"])
DISPLAY_REFERENCES = tuple({"schema": name, "path": CONTRACT["directory"]} for name in NAMED_SCHEMAS)
PREFLIGHT_RAW_FILES = frozenset(CONTRACT["rawArtifacts"]["preflight"].values())


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


def attempt_artifact(manifest_reference, folder, summary, summary_sha, relative, limit):
    if manifest_reference is not None:
        return verified_file(manifest_reference, folder, relative, limit)
    # Older display packages did not identify the original artifact separately.
    # A decision may bind it only if it also binds this exact stage result.
    from read_attempt_evidence import decision_evidence, verify_decision_file

    decision = read_file(folder / "decision.json", folder)
    evidence = decision_evidence(decision, summary["stage"], summary["attempt"])
    if evidence.get("stage-result.json") != summary_sha:
        raise ValueError("Decision does not identify the reported stage result")
    return verify_decision_file(evidence, "artifact:" + relative, read_file(folder / relative, folder, limit))


def verify_png(raw):
    from PIL import Image

    if raw[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" or len(raw) < 33:
        raise ValueError("Original image is not a PNG")
    width, height = (int.from_bytes(raw[pos:pos + 4], "big") for pos in (16, 20))
    if width <= 0 or height <= 0 or width * height > 40_000_000:
        raise ValueError("Original PNG dimensions exceed the display limit")
    with Image.open(io.BytesIO(raw)) as image:
        image.verify()


def original_artifacts(manifest, folder, declaration, original_folder, reported_png=None):
    stage = manifest["stage"]
    references = manifest.get("raw_artifacts", {})
    artifacts = []
    remaining = PNG_TOTAL
    for key, relative in CONTRACT["rawArtifacts"][stage].items():
        if reported_png is not None and relative != reported_png:
            continue
        expected = str(original_folder / relative) if stage == "preflight" else relative
        if declaration.get("artifacts", {}).get(key) != expected:
            continue
        try:
            limit = min(PNG, remaining)
            if stage == "preflight":
                if "raw_artifacts" in manifest:
                    raw = verified_file(references[key], folder, relative, limit)
                else:
                    raw = read_file(folder / relative, folder, limit)
            else:
                raw = attempt_artifact(references.get(key), folder, declaration, manifest["summary"]["sha256"],
                                       relative, limit)
            verify_png(raw)
        except (*UNAVAILABLE, AttributeError, EOFError, SyntaxError):
            continue
        remaining -= len(raw)
        artifacts.append({"name": Path(relative).name,
                          "src": "data:image/png;base64," + base64.b64encode(raw).decode()})
    return artifacts


def preflight_packet(packet_bytes, frozen, original_run):
    packet = json.loads(packet_bytes)
    lens = Path(frozen["lens_dir"])
    geometry = frozen["input_geometry"]
    pixel = geometry["pixel_scale_arcsec"]
    if (frozen.get("schema_version") != "lens_run_manifest.v1" or not lens.is_absolute()
            or str(lens) != frozen["lens_dir"] or ".." in lens.parts or lens.name != original_run.name
            or type(pixel) not in (int, float) or not math.isfinite(pixel) or pixel <= 0
            or any(geometry.get(axis) not in ("increasing", "decreasing")
                   for axis in ("input_x_direction", "input_y_direction"))
            or packet.get("schema_version") != "inspection_packet.v5"
            or (packet["lens_id"], packet["lens_dir"], packet["input_geometry"])
            != (original_run.name, str(lens), geometry)):
        raise ValueError("Published preflight input mismatch")
    return packet


def read_unindexed_preflight_raw(request, root, run, original_run, folder, reported_png):
    manifest_path = run / "run-manifest.json"
    manifest_bytes = read_file(manifest_path, root)
    frozen = json.loads(manifest_bytes)
    if frozen.get("run_id") != request.get("runId"):
        raise ValueError("Frozen run and preflight report versions disagree")
    packet_path = folder / "inspection.json"
    packet_bytes = read_file(packet_path, root)
    packet = preflight_packet(packet_bytes, frozen, original_run)
    if "display" in packet:
        raise ValueError("Preflight declares a missing display package")
    artifacts = original_artifacts({"stage": "preflight"}, folder, packet, original_run / "preflight", reported_png)
    if read_file(manifest_path, root) != manifest_bytes or read_file(packet_path, root) != packet_bytes:
        raise ValueError("Preflight scope changed while reading the original images")
    scope = {"run": str(original_run), "stage": "preflight", "attempt": None,
             "run_sha256": digest(manifest_bytes), "inspection_sha256": digest(packet_bytes)}
    if frozen.get("run_id") is not None:
        scope["run_id"] = frozen["run_id"]
    return {"legacy_raw_scope": scope, "raw_artifacts": artifacts}


class ArraysOnly(pickle.Unpickler):
    def find_class(self, module, name):
        import numpy as np

        if (module, name) == ("numpy", "ndarray"):
            return np.ndarray
        if (module, name) == ("numpy", "dtype"):
            return np.dtype
        if module in ("numpy.core.multiarray", "numpy._core.multiarray") and name in ("_reconstruct", "scalar"):
            return getattr(np.core.multiarray, name)
        if module in ("numpy.core.numeric", "numpy._core.numeric") and name == "_frombuffer":
            return np.core.numeric._frombuffer
        raise ValueError("Unsupported stage pickle object")


def read_joint_samples(manifest, folder, summary, *, for_plot=False):
    stage = manifest["stage"]
    relative = f"artifacts/stage_{stage}.pkl"
    if stage not in ("a", "m1", "m2", "m3") or summary.get("artifacts", {}).get("stage_pickle") != relative:
        raise ValueError("The attempt does not declare weighted joint samples")
    import numpy as np

    contract = CONTRACT["jointPosteriorFile"]
    published = "joint_posterior" in manifest
    if published:
        name = f'{CONTRACT["directory"]}/{CONTRACT["stagePrefixes"][stage]}_{contract["suffix"]}'
        raw = verified_file(manifest["joint_posterior"], folder, name, JOINT)
        packet = json.loads(raw, parse_constant=reject_nonfinite)
        source = manifest["posterior_source"]
        if (packet["schema"] != contract["schema"]
                or any(packet.get(key) != manifest.get(key) for key in ("run", "run_id", "lens_id", "stage", "attempt"))
                or packet["input_sha256"] != manifest["input"]["sha256"]
                or packet["summary_sha256"] != manifest["summary"]["sha256"]
                or (source["path"], source["sha256"]) != (relative, packet["source_sha256"])):
            raise ValueError("Published joint posterior belongs to a different attempt")
        names = packet["names"]
    else:
        raw = attempt_artifact(manifest.get("posterior_source"), folder, summary, manifest["summary"]["sha256"],
                               relative, POSTERIOR)
        packet = ArraysOnly(io.BytesIO(raw)).load()
        names = packet["param_names"]

    samples = np.asarray(packet["samples"])
    weights = np.asarray(packet["weights"])
    # The full JSON transport has a lower cap than the already verified PKL.
    # A contour request projects only two columns and never serializes the matrix.
    oversized = (samples.nbytes + weights.nbytes > POSTERIOR if for_plot and not published
                 else samples.size + weights.size > contract["maxValues"])
    if (not isinstance(names, list) or not 1 <= len(names) <= 200
            or any(not isinstance(name, str) or not 1 <= len(name) <= 160 for name in names)
            or len(set(names)) != len(names) or samples.ndim != 2 or samples.shape[1] != len(names)
            or samples.shape[0] == 0 or weights.shape != (samples.shape[0],)
            or oversized
            or samples.dtype.kind not in "iuf" or weights.dtype.kind not in "iuf"
            or not np.isfinite(samples).all() or not np.isfinite(weights).all()
            or np.any(weights < 0)):
        raise ValueError("Invalid or oversized weighted joint samples")
    total = float(weights.sum(dtype=float))
    if not 0 < total < math.inf or (published and not math.isclose(total, 1, rel_tol=1e-12)):
        raise ValueError("Invalid joint sample weights")
    return names, samples, weights if published else weights / total


def joint_density(names, samples, weights, x_name, y_name):
    import numpy as np

    if not isinstance(x_name, str) or not isinstance(y_name, str) or x_name == y_name or x_name not in names or y_name not in names:
        raise ValueError("Choose two different sampled parameters")
    positive = weights > 0
    pair = np.asarray(samples[:, [names.index(x_name), names.index(y_name)]][positive], dtype=float)
    if len(pair) < 3:
        raise ValueError("Insufficient weighted samples for a joint density")
    spans = np.ptp(pair, axis=0)
    if not np.isfinite(spans).all() or np.any(spans <= 0):
        raise ValueError("The selected posterior axes have no valid variation")

    # GetDist may print progress while constructing the sample object. Keep
    # stdout reserved for the bridge protocol, including during imports.
    with redirect_stdout(sys.stderr):
        from contourpy import contour_generator
        from getdist import MCSamples
        from getdist.densities import DensitiesError
        from getdist.mcsamples import MCSamplesError

        try:
            model = MCSamples(samples=pair, weights=weights[positive], names=["x", "y"], sampler="nested",
                              settings={"ignore_rows": 0, "min_weight_ratio": 0})
            grid = model.get2DDensity("x", "y", normalized=True)
            x, y, density = grid.x, grid.y, grid.P
            if (not all(axis.ndim == 1 and 2 <= len(axis) <= MAX_DENSITY_BINS
                        and np.isfinite(axis).all() and np.all(np.diff(axis) > 0) for axis in (x, y))
                    or density.shape != (len(y), len(x)) or not np.isfinite(density).all()):
                raise ValueError("Invalid GetDist density grid")
            peak = float(density.max())
            # FFT smoothing leaves numerical noise slightly below zero in the tails.
            if peak <= 0 or float(density.min()) < -1e-12 * peak:
                raise ValueError("Invalid GetDist density values")
            levels = grid.getContourLevels(JOINT_PROBABILITIES)
        except (DensitiesError, MCSamplesError, np.linalg.LinAlgError) as error:
            raise ValueError("GetDist could not estimate this joint posterior") from error

        upper = math.nextafter(peak, math.inf)
        if not math.isfinite(upper) or not 0 <= levels[1] <= levels[0] < upper:
            raise ValueError("Invalid GetDist contour levels")
        generator = contour_generator(x=x, y=y, z=density, fill_type="OuterOffset")
        contours = []
        vertex_count = 0
        for probability, level in zip(JOINT_PROBABILITIES, levels, strict=True):
            points, offsets = generator.filled(float(level), upper)
            vertex_count += sum(len(polygon) for polygon in points)
            if vertex_count > MAX_CONTOUR_VERTICES or not points:
                raise ValueError("Invalid or oversized posterior contour geometry")
            polygons = [[polygon[start:end].tolist() for start, end in zip(rings[:-1], rings[1:], strict=True)]
                        for polygon, rings in zip(points, offsets, strict=True)]
            contours.append({"probability": probability, "level": float(level), "polygons": polygons})

    return {"method": "getdist", "parameters": [x_name, y_name],
            "bounds": [float(x[0]), float(x[-1]), float(y[0]), float(y[-1])],
            "contours": contours, "sample_count": len(weights)}


def read_joint_view(view, manifest, folder, summary, request):
    names, samples, weights = read_joint_samples(manifest, folder, summary, for_plot=view != "joint_posterior")
    if view == "joint_parameters":
        return {"names": names, "sample_count": len(weights)}
    if view == "joint_density":
        return joint_density(names, samples, weights, request.get("x"), request.get("y"))
    return {"names": names, "samples": samples.tolist(), "weights": weights.tolist()}


def read_legacy_joint(request, root, run, folder, summary_bytes):
    from read_attempt_evidence import decision_evidence

    stage, attempt = request["stage"], request["attempt"]
    view = request["view"]
    summary = json.loads(summary_bytes)
    summary_sha = digest(summary_bytes)
    manifest_path = run / "run-manifest.json"
    manifest_bytes = read_file(manifest_path, root)
    manifest = json.loads(manifest_bytes)
    lens = Path(manifest["lens_dir"])
    geometry = manifest["input_geometry"]
    pixel = geometry["pixel_scale_arcsec"]
    if (manifest.get("schema_version") != "lens_run_manifest.v1" or "run_id" in manifest
            or manifest.get("pipeline_release_id") != "input-geometry.v1"
            or not lens.is_absolute() or lens.name != run.name or type(pixel) not in (int, float)
            or not math.isfinite(pixel) or pixel <= 0
            or any(geometry.get(key) not in ("increasing", "decreasing") for key in ("input_x_direction", "input_y_direction"))):
        raise ValueError("Not an unversioned frozen lens run")
    if ("display" in summary or type(summary.get("attempt")) is not int
            or (summary.get("lens_id"), summary.get("stage"), summary.get("attempt"), summary.get("status"))
            != (run.name, stage, attempt, "success") or summary.get("eligible_for_review") is not True
            or summary.get("gate_failures") != []):
        raise ValueError("Not an eligible legacy stage result")

    head_path = run / "accepted" / f"{stage}.json"
    head_bytes = read_file(head_path, root)
    head = json.loads(head_bytes)
    if type(head.get("accepted_attempt")) is not int or (
            head.get("schema_version"), head.get("stage"), head.get("accepted_attempt"), head.get("attempt_path")
    ) != ("accepted_stage_head.v1", stage, attempt, f"../attempts/{stage}/{attempt}"):
        raise ValueError("The accepted head does not identify the reported attempt")
    decision_bytes = read_file(folder / "decision.json", root)
    if json.loads(decision_bytes).get("decision") != "accept":
        raise ValueError("The reported legacy stage was not accepted")
    evidence = decision_evidence(decision_bytes, stage, attempt)
    relative = f"artifacts/stage_{stage}.pkl"
    source_sha = evidence.get("artifact:" + relative)
    if evidence.get("stage-result.json") != summary_sha or not isinstance(source_sha, str):
        raise ValueError("The accepted decision does not bind this result and posterior")
    dependency = {"stage": stage, "summary": {"sha256": summary_sha},
                  "posterior_source": {"path": relative, "sha256": source_sha}}
    result = {"legacy_joint_scope": {"run": str(run), "stage": stage, "attempt": attempt,
                                     "run_sha256": digest(manifest_bytes), "summary_sha256": summary_sha,
                                     "posterior_sha256": source_sha}}
    try:
        result[view] = read_joint_view(view, dependency, folder, summary, request)
    except (*UNAVAILABLE, ImportError, ArithmeticError, AttributeError, EOFError, IndexError, pickle.UnpicklingError):
        return result
    if read_file(head_path, root) != head_bytes or read_file(manifest_path, root) != manifest_bytes:
        raise ValueError("The legacy acceptance scope changed while reading the samples")
    return result


def decode_mask_fits(raw, shape, frozen):
    from astropy.io import fits

    with fits.open(io.BytesIO(raw), memmap=False) as hdus:
        array = hdus[0].data
        header = hdus[0].header
    geometry = frozen["input_geometry"]
    if list(array.shape) != shape or any(header.get(key) != value for key, value in {
        "CDELT1": geometry["pixel_scale_arcsec"], "CDELT2": geometry["pixel_scale_arcsec"],
        "CRPIX1": (shape[1] + 1) / 2, "CRPIX2": (shape[0] + 1) / 2,
        "CRVAL1": 0, "CRVAL2": 0, "CUNIT1": "arcsec", "CUNIT2": "arcsec",
        "INPXDIR": geometry["input_x_direction"], "INPYDIR": geometry["input_y_direction"],
    }.items()):
        raise ValueError("Mask array does not match the frozen input frame")
    return array, header


def decode_named_image_frame(raw, shape, bounds):
    from astropy.io import fits

    with fits.open(io.BytesIO(raw), memmap=False) as hdus:
        if len(hdus) != 1 or hdus[0].shape != tuple(shape):
            raise ValueError("Named FITS shape does not match the display frame")
        hdu = hdus[0]
        header = hdu.header
        steps = ((bounds[1] - bounds[0]) / shape[1], (bounds[3] - bounds[2]) / shape[0])
        for axis, (step, edge) in enumerate(zip(steps, (bounds[0], bounds[2]), strict=True), start=1):
            if (header.get(f"CTYPE{axis}") != "LINEAR" or header.get(f"CUNIT{axis}") != "arcsec"
                    or header.get(f"CRPIX{axis}") != 1
                    or not math.isclose(header[f"CDELT{axis}"], step, rel_tol=1e-10, abs_tol=1e-10)
                    or not math.isclose(header[f"CRVAL{axis}"], edge + step / 2, rel_tol=1e-10, abs_tol=1e-10)):
                raise ValueError("Named FITS calibration does not match the display frame")
        return hdu.data


def fixed_mask_layers(manifest, folder, frame, frame_role):
    import numpy as np
    from astropy.io.fits.verify import VerifyError

    sources = manifest["mask_layers"]
    if manifest["schema"] not in NAMED_SCHEMAS or not isinstance(sources, dict) or not sources:
        return {}
    stage = manifest["stage"]
    prefix = f'{CONTRACT["directory"]}/{CONTRACT["stagePrefixes"][stage]}_'
    image = verified_file(frame, folder, prefix + CONTRACT["imageNames"][frame_role] + ".fits", FITS)
    shape, bounds = frame["shape"], frame["bounds_arcsec"]
    try:
        decode_named_image_frame(image, shape, bounds)
    except VerifyError as error:
        raise ValueError("Invalid observation FITS frame") from error

    layers = {}
    for name, suffix in CONTRACT["maskLayerFiles"].items():
        if name == "arc" and stage in ("preflight", "a"):
            continue
        try:
            reference = sources[name]
            if stage == "b" and name == "arc":
                plane = manifest["planes"]["mask"]
                if (reference != {key: plane[key] for key in ("path", "sha256")}
                        or plane["shape"] != shape or plane["bounds_arcsec"] != bounds):
                    raise ValueError("Stage B arc layer differs from the displayed arc mask")
            raw = verified_file(reference, folder, prefix + suffix + ".fits", FITS)
            mask = decode_named_image_frame(raw, shape, bounds)
            if mask.dtype.kind not in "iu" or not np.isin(mask, (0, 1)).all():
                raise ValueError("Published mask layer is not binary")
            layers[name] = mask
        except (*UNAVAILABLE, VerifyError):
            pass
    return layers


def mask_layer_payload(shape, bounds, layers):
    return ({"shape": shape, "bounds_arcsec": bounds, "array_y_direction": "decreasing",
             **{name: base64.b64encode(array[::-1].astype("uint8").tobytes()).decode()
                for name, array in layers.items()}} if layers else None)


def image_mask_layers(manifest, folder, run, frozen, declaration, upstream_summaries):
    import numpy as np

    stage = manifest["stage"]
    frame_role = "data" if stage == "preflight" else "observation"
    frame = manifest["planes"][frame_role]
    shape, bounds = frame["shape"], frame["bounds_arcsec"]
    pixel = frozen["input_geometry"]["pixel_scale_arcsec"]
    if (len(shape) != 2 or any(type(size) is not int or not 1 <= size <= 512 for size in shape)
            or bounds != [-shape[1] * pixel / 2, shape[1] * pixel / 2, -shape[0] * pixel / 2, shape[0] * pixel / 2]):
        raise ValueError("Mask display does not match the frozen image frame")
    if "mask_layers" in manifest:
        return mask_layer_payload(shape, bounds, fixed_mask_layers(manifest, folder, frame, frame_role))

    sources = manifest.get("mask_sources", {})
    layers = {}
    modeling = None
    if "modeling_mask" in manifest and "modeling_mask.fits" in sources and manifest["modeling_mask"] != sources["modeling_mask.fits"]:
        raise ValueError("Display layers disagree on the frozen modeling mask")
    modeling_ref = sources.get("modeling_mask.fits", manifest.get("modeling_mask"))
    if modeling_ref is not None:
        try:
            modeling_raw = verified_file(modeling_ref, run, "preflight/modeling_mask.fits", FITS)
            mask, header = decode_mask_fits(modeling_raw, shape, frozen)
            radius = header["MODELRAD"]
            if not np.isin(mask, (0, 1)).all() or not math.isfinite(radius) or radius <= 0:
                raise ValueError("Invalid frozen aperture mask")
            yy, xx = np.indices(shape)
            aperture = np.hypot(xx - (shape[1] - 1) / 2, yy - (shape[0] - 1) / 2) <= radius / pixel
            modeling = mask > 0
            if np.any(~aperture & ~modeling):
                raise ValueError("Frozen modeling mask contains pixels outside the aperture")
            layers["aperture"] = aperture
        except UNAVAILABLE:
            modeling = None

    try:
        packet = declaration if stage == "preflight" else json.loads(
            verified_file(sources["inspection.json"], run, "preflight/inspection.json"))
        if (packet["lens_id"] != manifest["lens_id"] or packet["image_shape"] != shape
                or packet["input_geometry"] != frozen["input_geometry"]
                or packet.get("euclid_contamination") != frozen.get("euclid_contamination")):
            raise ValueError("Contamination mask belongs to a different input")
        seg_raw = verified_file(sources["segmentation.fits"], run, "preflight/segmentation.fits", FITS)
        labels, _ = decode_mask_fits(seg_raw, shape, frozen)
        if labels.dtype.kind not in "iu" or np.any(labels < 0):
            raise ValueError("Invalid contamination segmentation labels")
        euclid = frozen.get("euclid_contamination")
        if euclid is not None:
            contamination = labels > 0
            if (euclid["image_shape"] != shape or euclid["input_fits_sha256"] != manifest["input"]["sha256"]
                    or euclid["canonical_mask_sha256"] != digest(contamination.astype(np.uint8).tobytes())):
                raise ValueError("The published segmentation differs from the verified Euclid mask")
        else:
            inspector = json.loads(verified_file(sources["inspector.json"], run, "preflight/inspector.json"))
            ids = inspector["contaminant_ids"]
            if (inspector["lens_id"] != manifest["lens_id"] or inspector["disposition"] != "model"
                    or not isinstance(ids, list) or any(type(value) is not int or value <= 0 for value in ids)
                    or not np.isin(ids, labels).all()):
                raise ValueError("Contaminant IDs do not belong to the saved segmentation")
            contamination = np.isin(labels, ids)
        if modeling is not None and not np.array_equal(modeling, ~layers["aperture"] | contamination):
            raise ValueError("Independent contamination does not reproduce the frozen modeling mask")
        layers["contamination"] = contamination
    except UNAVAILABLE:
        pass

    b = declaration if stage == "b" else upstream_summaries.get("b")
    if b is not None and modeling is not None:
        try:
            relative = "artifacts/feature_mask.fits"
            if b["artifacts"]["feature_mask_fits"] != relative:
                raise ValueError("The attempt does not declare the arc mask")
            b_folder = f"attempts/b/{b['attempt']}"
            reference = manifest.get("feature_mask") if stage == "b" else sources.get("arc")
            if reference is not None:
                raw = verified_file(reference, run, f"{b_folder}/{relative}", FITS)
            else:
                summary_sha = next(entry["sha256"] for entry in manifest["upstream"] if entry["stage"] == "b")
                raw = attempt_artifact(None, run / b_folder, b, summary_sha, relative, FITS)
            mask, _ = decode_mask_fits(raw, shape, frozen)
            arc = mask == 0
            if (not np.isin(mask, (0, 1)).all() or np.any(arc & modeling)
                    or int(arc.sum()) != b["metrics"]["included_arc_pixels"]):
                raise ValueError("The arc mask differs from the bound Stage B attempt")
            layers["arc"] = arc
        except UNAVAILABLE:
            pass

    return mask_layer_payload(shape, bounds, layers)


def named_fits(manifest, folder):
    stage = manifest["stage"]
    kind = stage if stage in ("preflight", "b") else "model"
    required = set(CONTRACT["required"][kind])
    allowed = required | set(CONTRACT["optional"].get(kind, ()))
    entries = manifest["planes"]
    if not required <= entries.keys() <= allowed:
        raise ValueError("Missing or unexpected named display image")
    prefix = CONTRACT["stagePrefixes"][stage]
    encoded = {}
    for role, entry in entries.items():
        try:
            name = f'{CONTRACT["directory"]}/{prefix}_{CONTRACT["imageNames"][role]}.fits'
            encoded[role] = base64.b64encode(verified_file(entry, folder, name, FITS)).decode()
        except UNAVAILABLE:
            if role != "lens-light":
                raise
    return encoded


def legacy_lens_light(manifest, folder, run, frozen, summary, upstream_summaries):
    """Read the saved Stage A plane that these older displays used in the total model."""
    import numpy as np

    if manifest["stage"] == "a":
        a_folder, a_summary = folder, summary
        a_sha, source = manifest["summary"]["sha256"], manifest.get("posterior_source")
    else:
        a = next(entry for entry in manifest["upstream"] if entry["stage"] == "a")
        a_folder, a_summary = run / "attempts" / "a" / str(a["attempt"]), upstream_summaries["a"]
        a_sha, source = a["sha256"], None
    relative = "artifacts/stage_a.pkl"
    if a_summary["artifacts"].get("stage_pickle") != relative:
        raise ValueError("Stage A does not declare its saved lens light")
    raw = attempt_artifact(source, a_folder, a_summary, a_sha, relative, POSTERIOR)
    extra = ArraysOnly(io.BytesIO(raw)).load()["extra"]
    values = np.asarray(extra["lens_light_model"])
    shape = tuple(manifest["planes"]["observation"]["shape"])
    geometry = extra["input_geometry"]
    if (geometry.get("array_frame") != "canonical" or geometry.get("x_direction") != "increasing"
            or geometry.get("y_direction") != "increasing"
            or any(geometry.get(key) != frozen["input_geometry"][key]
                   for key in ("pixel_scale_arcsec", "input_x_direction", "input_y_direction"))
            or values.ndim != 2 or values.shape != shape or values.size > 512 * 512
            or values.dtype.kind not in "iuf" or not np.isfinite(values).all()):
        raise ValueError("Saved lens light does not match the observed image")
    return base64.b64encode(values.astype("<f8", copy=False).tobytes()).decode()


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


def inherited_receipt(run, original_run, frozen):
    reference = frozen.get("inherited_ab")
    if not isinstance(reference, dict):
        raise ValueError("This run has no reported A/B inheritance")
    receipt = json.loads(verified_file(reference, run, "inherited-ab.json"))
    run_id = frozen["run_id"]
    if receipt["schema_version"] != "inherited_ab.v1" or receipt["target"] != {
        "run": str(original_run), "run_id": run_id, "pipeline_release_id": frozen["pipeline_release_id"],
    }:
        raise ValueError("The inheritance receipt belongs to a different run")
    source = receipt["source"]
    previous = json.loads(verified_file(
        {"path": "inherited-ab-source-manifest.json", "sha256": source["manifest_sha256"]},
        run, "inherited-ab-source-manifest.json",
    ))
    source_id = source["run_id"]
    if (not isinstance(source_id, str) or not source_id or source_id == run_id
            or previous.get("schema_version") != "lens_run_manifest.v1"
            or previous.get("run_id") != source_id
            or previous.get("pipeline_release_id") != source["pipeline_release_id"]
            or any(previous.get(key) != frozen.get(key) for key in ("lens_dir", "input_geometry"))):
        raise ValueError("The inheritance receipt has a different source run or input")
    return receipt, previous


def inherited_stage_evidence(run, entry, snapshot):
    from read_attempt_evidence import decision_evidence

    stage, attempt = entry["stage"], entry["attempt"]
    relative = f"attempts/{stage}/{attempt}"
    head_path = f"accepted/{stage}.json"
    head = json.loads(verified_file({"path": head_path, "sha256": snapshot["head_sha256"]}, run, head_path))
    if type(snapshot["attempt"]) is not int or snapshot["attempt"] != attempt or head != {
        "schema_version": "accepted_stage_head.v1", "stage": stage, "accepted_attempt": attempt,
        "attempt_path": "../" + relative, "effective_config": "../" + relative + "/effective-config.json",
    }:
        raise ValueError("The inherited attempt differs from the reported upstream stage")
    decision_path = relative + "/decision.json"
    decision = verified_file({"path": decision_path, "sha256": snapshot["decision_sha256"]}, run, decision_path)
    evidence = decision_evidence(decision, stage, attempt)
    if json.loads(decision).get("decision") != "accept" or evidence.get("stage-result.json") != entry["sha256"]:
        raise ValueError("The inherited stage result is not bound to its acceptance decision")
    return relative, evidence


def inherited_configuration(manifest, run, original_run, frozen, upstream_summaries):
    """Read the accepted Stage A configuration inherited by this reported run."""
    from read_attempt_evidence import verify_decision_file

    if manifest["stage"] not in STAGES[2:]:
        raise ValueError("A reported downstream attempt is required")
    receipt, previous = inherited_receipt(run, original_run, frozen)
    entry = next(item for item in manifest["upstream"] if item["stage"] == "a")
    relative, evidence = inherited_stage_evidence(run, entry, receipt["stages"]["a"])
    config = json.loads(verify_decision_file(evidence, "effective-config.json",
                        read_file(run / relative / "effective-config.json", run)), parse_constant=reject_nonfinite)
    if (config["pipeline_release_id"] != previous["pipeline_release_id"]
            or any(config["settings"].get(key) != value for key, value in frozen["input_geometry"].items())):
        raise ValueError("The inherited configuration has a different release or input geometry")
    result = {"run_id": frozen["run_id"], "source_run_id": receipt["source"]["run_id"], "stage": "a", "attempt": entry["attempt"],
              "summary_sha256": entry["sha256"], "config": config}
    mass_model = upstream_summaries["a"].get("metrics", {}).get("a_mass_model")
    if isinstance(mass_model, str):
        result["mass_model"] = mass_model
    return result


def inherited_lineage_source(manifest, run, original_run, root, frozen, upstream_summaries):
    receipt, previous = inherited_receipt(run, original_run, frozen)
    source = receipt["source"]
    source_path = Path(source["run"])
    if (not source_path.is_relative_to(root) or source_path == root or source_path == original_run
            or str(source_path) != source["run"] or source_path.name != original_run.name
            or any(part in ("..", "_archive") for part in source_path.relative_to(root).parts)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", source["run_id"])
            or receipt["input"] != {key: manifest["input"][key] for key in ("path", "sha256")}):
        raise ValueError("The inheritance source does not match the reported lens and input")
    entries = {entry["stage"]: entry for entry in manifest["upstream"]}
    for stage in ("a", "b"):
        entry, snapshot = entries[stage], receipt["stages"][stage]
        relative, evidence = inherited_stage_evidence(run, entry, snapshot)
        path = relative + "/display-manifest.json"
        copied = json.loads(verified_file({"path": path, "sha256": snapshot["display_manifest_sha256"]}, run, path))
        summary = upstream_summaries[stage]
        if ((copied["run"], copied["run_id"], copied["lens_id"], copied["stage"], copied["attempt"]) != (
                str(source_path), source["run_id"], original_run.name, stage, entry["attempt"])
                or copied["schema"] not in NAMED_SCHEMAS
                or copied["summary"] != {"path": "stage-result.json", "sha256": entry["sha256"]}
                or copied["configuration"] != {"path": "effective-config.json", "sha256": evidence["effective-config.json"]}
                or copied["run_manifest"] != {"path": "run-manifest.json", "sha256": source["manifest_sha256"]}
                or copied["upstream"] != ([entries["a"]] if stage == "b" else [])
                or any(copied["input"].get(key) != manifest["input"].get(key) for key in ("path", "sha256", "pixel_scale_arcsec"))
                or summary.get("pipeline_release_id") != previous["pipeline_release_id"]
                or summary.get("status") != "success" or summary.get("eligible_for_review") is not True
                or summary.get("gate_failures") != []):
            raise ValueError("Inherited upstream display does not identify the source stage")
    return receipt


def preflight_lineage_reference(manifest, run, original_run):
    """Verify the one fixed preflight display slot of an older versioned run."""
    preflight = json.loads(read_file(run / "preflight/display-manifest.json", run))
    if (preflight["schema"] not in (*NAMED_SCHEMAS, LEGACY_SCHEMA)
            or (preflight["run"], preflight["run_id"], preflight["lens_id"], preflight["stage"], preflight["attempt"]) != (
                str(original_run), manifest["run_id"], original_run.name, "preflight", None)
            or preflight["run_manifest"] != manifest["run_manifest"]
            or preflight["upstream"] != []
            or any(preflight["input"][key] != manifest["input"][key] for key in ("path", "sha256", "pixel_scale_arcsec"))
            or preflight["inspection"]["path"] != "inspection.json"):
        raise ValueError("Preflight display does not match the reported run and input")
    return {"path": "preflight/inspection.json", "sha256": preflight["inspection"]["sha256"]}


def history_lineage(manifest, run, original_run, root, frozen, upstream_summaries):
    reference = {"run_id": frozen["run_id"], "run_path": str(original_run)}
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", reference["run_id"]):
        raise ValueError("A versioned run is required for history lineage")
    if manifest["stage"] == "preflight":
        return {"upstream": []}
    mask_sources = manifest.get("mask_sources")
    preflight = mask_sources.get("inspection.json") if isinstance(mask_sources, dict) else None
    inherited = "inherited_ab" in frozen
    source = None
    if inherited:
        preflight = None
        try:
            receipt = inherited_lineage_source(manifest, run, original_run, root, frozen, upstream_summaries)
            source = {"run_id": receipt["source"]["run_id"], "run_path": receipt["source"]["run"]}
            if (inspection_sha := receipt.get("preflight", {}).get("inspection.json")) is not None:
                preflight = {"path": "preflight/inspection.json", "sha256": inspection_sha}
        except (*UNAVAILABLE, AttributeError):
            pass  # The run's own downstream ancestors can still be verified independently.
    elif manifest["stage"] in ("a", "b") and "mask_sources" not in manifest:
        try:
            preflight = preflight_lineage_reference(manifest, run, original_run)
        except (*UNAVAILABLE, AttributeError):
            pass
    upstream = []
    if preflight is not None:
        try:
            preflight_packet(verified_file(preflight, run, "preflight/inspection.json"), frozen, original_run)
            upstream.append({"stage": "preflight", "attempt": None, **(source or reference)})
        except (*UNAVAILABLE, AttributeError):
            pass
    entries = {entry["stage"]: entry for entry in manifest["upstream"]}
    for stage in STAGES:
        if stage not in entries or upstream_summaries[stage].get("status") != "success":
            continue
        if inherited and stage in ("a", "b") and source is None:
            continue
        origin = source if inherited and stage in ("a", "b") else reference
        release = upstream_summaries[stage].get("pipeline_release_id")
        if origin is reference and release is not None and release != frozen.get("pipeline_release_id", release):
            continue
        upstream.append({"stage": stage, "attempt": entries[stage]["attempt"], **origin})
    return {"upstream": upstream}


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
    view = request.get("view")
    if view is not None and view not in EXTRA_VIEWS:
        raise ValueError("Unknown optional display view")
    if view == "history_lineage" and not request.get("runId"):
        raise ValueError("A versioned display report is required for history lineage")
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
    legacy_raw = (request.get("legacyRaw") is True and stage == "preflight" and view == "raw_artifacts"
                  and "_archive" not in original_run.relative_to(root).parts and anchor.parent == folder)
    reported_png = anchor.name if legacy_raw and anchor.name in PREFLIGHT_RAW_FILES else None
    if (legacy_raw and (anchor == declaration or reported_png) and not request.get("manifestSha256")
            and not manifest_path.exists() and not manifest_path.is_symlink()):
        return read_unindexed_preflight_raw(request, root, run, original_run, folder, reported_png)
    if anchor == declaration:
        declared = read_file(declaration, root)
        if (request.get("legacyJoint") is True and view in JOINT_DISPLAY_VIEWS and request.get("runId") is None
                and run == original_run and "_archive" not in run.relative_to(root).parts
                and stage in ("a", "m1", "m2", "m3") and not manifest_path.exists() and not manifest_path.is_symlink()):
            return read_legacy_joint(request, root, run, folder, declared)
        declared_packet = json.loads(declared)
        reference = declared_packet.get("display")
        if reference in (
            *DISPLAY_REFERENCES, {"schema": LEGACY_SCHEMA, "path": "display-manifest.json"}
        ):
            declaration_schema = reference["schema"]
        elif not (legacy_raw and "display" not in declared_packet):
            raise ValueError("Reported stage does not declare a display package")
        declaration_sha = digest(declared)
    elif anchor not in (manifest_path, display_dir) and reported_png is None:
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
    upstream_summaries = {}
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
        upstream_summaries[name] = upstream

    result = {"manifest": manifest, "manifest_sha256": digest(raw)}
    if view is None:
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
        packet = preflight_packet(packet_bytes, frozen, original_run)
        result["image_shape"] = packet["image_shape"]
        reported_stage = packet
    else:
        summary_bytes = verified_file(manifest["summary"], folder, "stage-result.json")
        if declaration_sha is not None and declaration_sha != digest(summary_bytes):
            raise ValueError("The display declaration changed")
        result["summary"] = json.loads(summary_bytes)
        if not current:
            result["configuration"] = json.loads(
                verified_file(manifest["configuration"], folder, "effective-config.json")
            )
        elif view is None:
            result["configuration"] = None
            try:
                configuration = json.loads(verified_file(
                    manifest["configuration"], folder, "effective-config.json"
                ), parse_constant=reject_nonfinite)
                settings = configuration["settings"]
                release = frozen.get("pipeline_release_id")
                if (not isinstance(settings, dict)
                        or any(settings.get(key) != value for key, value in frozen["input_geometry"].items())
                        or (release is not None and configuration.get("pipeline_release_id") != release)):
                    raise ValueError("Saved configuration does not match the frozen run")
                result["configuration"] = configuration
            except (OSError, KeyError, TypeError, ValueError):
                # Configuration and exported parameters are separately verified artifacts.
                pass
        summary = result["summary"]
        reported_stage = summary
        if (summary["lens_id"], summary["stage"], summary["attempt"], summary["status"]) != (
            original_run.name, stage, attempt, "success"
        ) or (not current and any(result["configuration"]["settings"].get(key) != value
                                  for key, value in frozen["input_geometry"].items())):
            raise ValueError("Published stage summary or geometry mismatch")
        if view is None and (stage == "b" or "domain" in manifest["planes"]):
            if stage == "b" and summary["artifacts"].get("feature_mask_fits") != "artifacts/feature_mask.fits":
                raise ValueError("Unknown feature mask file")
            try:
                if stage == "b":
                    verified_file(manifest["feature_mask"], run, f"attempts/b/{attempt}/artifacts/feature_mask.fits", FITS)
                verified_file(manifest["modeling_mask"], run, "preflight/modeling_mask.fits", FITS)
            except (OSError, KeyError, TypeError, ValueError):
                if not current:
                    raise
                result.pop("fits_files", None)
        elif view is None and not current and "parameters" in manifest:
            try:
                result["parameters"] = json.loads(verified_file(manifest["parameters"], folder, "display-parameters.json", PARAMETERS))
            except (OSError, KeyError, TypeError, ValueError):
                # A parameter-file failure does not affect the verified images.
                pass
        if view is None and current and stage in ("a", "m0", "m1", "m2", "m3") and "mapping_file" in manifest:
            try:
                result["mapping_packet"] = mapping_packet(manifest, folder)
            except (OSError, KeyError, TypeError, ValueError, OverflowError):
                # An unavailable overlay leaves this attempt's images and parameters visible.
                pass
        if (current and view is None and stage != "b" and result.get("fits_files")
                and "lens-light" not in manifest["planes"]):
            try:
                result["legacy_lens_light"] = legacy_lens_light(manifest, folder, run, frozen, summary, upstream_summaries)
            except (*UNAVAILABLE, ImportError, AttributeError, EOFError, pickle.UnpicklingError):
                pass
    if view is not None:
        try:
            if view == "raw_artifacts":
                result[view] = original_artifacts(manifest, folder, reported_stage, original_run / folder.relative_to(run), reported_png)
            elif view == "mask_layers":
                result[view] = image_mask_layers(manifest, folder, run, frozen, reported_stage, upstream_summaries)
            elif view == "inherited_configuration":
                result[view] = inherited_configuration(manifest, run, original_run, frozen, upstream_summaries)
            elif view == "history_lineage":
                result[view] = history_lineage(manifest, run, original_run, root, frozen, upstream_summaries)
            else:
                result[view] = read_joint_view(view, manifest, folder, reported_stage, request)
        except (*UNAVAILABLE, ImportError, ArithmeticError, AttributeError, EOFError, IndexError, pickle.UnpicklingError):
            pass
    return result


def read_history_batch(requests):
    if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_HISTORY_BATCH_SIZE:
        raise ValueError("Invalid stage history batch size")
    envelopes = []
    for request in requests:
        envelope = None
        try:
            if request["view"] != "history_lineage":
                raise ValueError("A batch may read stage history only")
            result = read_display(request)
            manifest = result["manifest"]
            envelope = {
                "manifest": {
                    **{key: manifest[key] for key in ("schema", "run", "run_id", "stage", "attempt")},
                    "input": {key: manifest["input"][key] for key in ("path", "sha256", "pixel_scale_arcsec")},
                    "upstream": [{key: entry[key] for key in ("stage", "attempt")} for entry in manifest["upstream"]],
                },
                "manifest_sha256": result["manifest_sha256"],
                "history_lineage": result["history_lineage"],
            }
        except (*UNAVAILABLE, AttributeError, IndexError, StopIteration):
            pass
        envelopes.append(envelope)
    return {"envelopes": envelopes}


if __name__ == "__main__":
    request = json.loads(sys.stdin.readline())
    result = (read_history_batch(request["historyLineageBatch"]) if "historyLineageBatch" in request else read_display(request))
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))
