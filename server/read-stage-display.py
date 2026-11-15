"""Read one reported display manifest and its exact, checked dependencies over SSH."""

import base64
import hashlib
import json
import math
import sys
from pathlib import Path

META = 2 * 1024 * 1024
FITS = 16 * 1024 * 1024
STAGES = ("a", "b", "m0", "m1", "m2", "m3")


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


def verified_file(ref, base, relative, limit=META):
    if ref["path"] != relative:
        raise ValueError("Unexpected display dependency")
    value = read_file(base / relative, base, limit)
    if digest(value) != ref["sha256"]:
        raise ValueError("Display dependency checksum mismatch")
    return value


def read_display(request):
    root = Path(request["root"]).resolve(strict=True) / "output"
    run = Path(request["run"])
    report = Path(request["path"])
    stage, attempt = request["stage"], request["attempt"]
    if stage == "preflight" and attempt is None:
        folder = run / "preflight"
    elif stage in STAGES and type(attempt) is int and attempt >= 0:
        folder = run / "attempts" / stage / str(attempt)
    else:
        raise ValueError("Invalid stage display identity")
    if report != folder / "display-manifest.json":
        raise ValueError("Not an explicitly reported display manifest")

    raw = read_file(report, root)
    manifest = json.loads(raw)
    if (
        manifest.get("schema") != "tinylens.stage-display.v1"
        or manifest["run"] != str(run)
        or manifest["lens_id"] != run.name
        or manifest["stage"] != stage
        or manifest["attempt"] != attempt
    ):
        raise ValueError("Published display identity mismatch")
    frozen = json.loads(verified_file(manifest["run_manifest"], run, "run-manifest.json"))
    lens = Path(frozen["lens_dir"])
    pixel = manifest["input"]["pixel_scale_arcsec"]
    input_path = Path(manifest["input"]["path"])
    if (
        frozen["schema_version"] != "lens_run_manifest.v1"
        or lens.name != run.name or not lens.is_absolute()
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
        if upstream["lens_id"] != run.name or upstream["stage"] != name or upstream["attempt"] != index:
            raise ValueError("Upstream attempt identity mismatch")

    exact_fits = verified_file(manifest["fits"], folder, "display.fits", FITS)
    result = {"manifest": manifest, "manifest_sha256": digest(raw),
              "fits_base64": base64.b64encode(exact_fits).decode()}
    if stage == "preflight":
        packet = json.loads(verified_file(manifest["inspection"], folder, "inspection.json"))
        if packet["schema_version"] != "inspection_packet.v5" or (
            packet["lens_id"], packet["lens_dir"], packet["input_geometry"]
        ) != (run.name, str(lens), frozen["input_geometry"]):
            raise ValueError("Published preflight input mismatch")
        result["image_shape"] = packet["image_shape"]
    else:
        result["summary"] = json.loads(verified_file(manifest["summary"], folder, "stage-result.json"))
        result["configuration"] = json.loads(
            verified_file(manifest["configuration"], folder, "effective-config.json")
        )
        summary = result["summary"]
        if (summary["lens_id"], summary["stage"], summary["attempt"], summary["status"]) != (
            run.name, stage, attempt, "success"
        ) or any(result["configuration"]["settings"].get(key) != value
                 for key, value in frozen["input_geometry"].items()):
            raise ValueError("Published stage summary or geometry mismatch")
        if stage == "b":
            if summary["artifacts"].get("feature_mask_fits") != "artifacts/feature_mask.fits":
                raise ValueError("Unknown feature mask file")
            verified_file(manifest["feature_mask"], run, f"attempts/b/{attempt}/artifacts/feature_mask.fits", FITS)
            verified_file(manifest["modeling_mask"], run, "preflight/modeling_mask.fits", FITS)
        elif "parameters" in manifest:
            result["parameters"] = json.loads(verified_file(manifest["parameters"], folder, "display-parameters.json"))
    return result


if __name__ == "__main__":
    print(json.dumps(read_display(json.loads(sys.stdin.readline())), allow_nan=False, separators=(",", ":")))
