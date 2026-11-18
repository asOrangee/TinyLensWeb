"""Read verified numerical inputs for one explicitly reported preflight artifact."""

import base64
import hashlib
import io
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.visualization import ZScaleInterval
from astropy.wcs import WCS


MAX_METADATA = 1024 * 1024
MAX_FILE = 16 * MAX_METADATA
AUDIT_ROLES = {
    "preflight_2panel.png": "inspector_prompt_png",
    "preflight_6panel.png": "human_audit_png",
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_exact(path, base, limit, *, prefix=None):
    if not path.is_absolute() or not path.is_relative_to(base) or path.resolve(strict=True) != path:
        raise ValueError("Input reference leaves the canonical output directory")
    if not path.is_file() or path.stat().st_size > limit:
        raise ValueError("Input reference is not an available file of the expected size")
    with path.open("rb") as handle:
        raw = handle.read(limit + 1 if prefix is None else prefix)
    if len(raw) > limit:
        raise ValueError("Input file exceeds preview limit")
    return raw


def resolve_report(report, output):
    if report.name == "input-provenance.json":
        return report, None
    role = AUDIT_ROLES.get(report.name)
    if report.parent.name != "preflight" or (report.name != "inspection.json" and role is None):
        raise ValueError("Unsupported preflight report")
    if role and read_exact(report, output, MAX_FILE, prefix=8) != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Invalid reported preflight image")

    run = report.parent.parent
    packet = json.loads(read_exact(report.parent / "inspection.json", output, MAX_METADATA))
    if packet.get("display", {}).get("schema") in ("tinylens.stage-display.v2", "tinylens.stage-display.v3"):
        raise ValueError("Preflight declares the named FITS display")
    manifest = json.loads(read_exact(run / "run-manifest.json", output, MAX_METADATA))
    lens_dir = Path(manifest["lens_dir"])
    if (
        packet.get("schema_version") != "inspection_packet.v5"
        or manifest.get("schema_version") != "lens_run_manifest.v1"
        or packet.get("lens_id") != run.name
        or lens_dir.name != run.name
        or packet.get("lens_dir") != str(lens_dir)
        or packet.get("input_geometry") != manifest.get("input_geometry")
        or (role and packet.get("artifacts", {}).get(role) != str(report))
    ):
        raise ValueError("Reported artifact does not match the frozen preflight input")
    return lens_dir / "input-provenance.json", packet


def linear_geometry(header, shape, steps):
    for axis, expected in enumerate(steps, 1):
        step = header.get(f"CDELT{axis}")
        if step is not None and (
            str(header.get(f"CUNIT{axis}", "arcsec")).lower() != "arcsec"
            or not math.isclose(float(step), expected, rel_tol=1e-6)
        ):
            raise ValueError("Input axis disagrees with provenance")
        center = header.get(f"CRPIX{axis}", (shape[2 - axis] + 1) / 2)
        if not math.isclose(float(center), (shape[2 - axis] + 1) / 2, rel_tol=1e-6):
            raise ValueError("Unsupported local input center")
        if not abs(float(header.get(f"CRVAL{axis}", 0))) <= 1e-10:
            raise ValueError("Unsupported local input reference")


def sky_geometry(header, steps):
    wcs = WCS(header, naxis=2)
    # Check the tangent plane scale and orientation. The sky reference pixel
    # need not be at the centre of the cutout used by the lens model.
    expected = np.diag(steps)
    if (
        list(wcs.wcs.ctype) != ["RA---TAN", "DEC--TAN"]
        or wcs.has_distortion
        or not np.allclose(wcs.pixel_scale_matrix * 3600, expected, rtol=1e-6, atol=1e-12)
        or (wcs.wcs.has_cd() and not np.allclose(wcs.wcs.cd * 3600, expected, rtol=1e-6, atol=1e-12))
        or not np.isfinite([*wcs.wcs.crval, *wcs.wcs.crpix]).all()
    ):
        raise ValueError("Unsupported sky WCS or WCS disagrees with the frozen geometry")
    return (*wcs.wcs.crval, *wcs.wcs.crpix, wcs.wcs.radesys, wcs.wcs.lonpole, wcs.wcs.latpole)


def input_display(request):
    output = Path(request["root"]).resolve() / "output"
    report = Path(request["path"])
    provenance_path, packet = resolve_report(report, output)
    provenance_raw = read_exact(provenance_path, output, MAX_METADATA)
    provenance = json.loads(provenance_raw)
    if provenance.get("schema_version") == "mock_input_provenance.v1":
        fits_path, expected_sha = map(provenance.__getitem__, ("packaged_fits_path", "packaged_fits_sha256"))
        alias = None
    elif "schema_version" not in provenance and provenance.get("aliases", {}).get("VIS_FLUX") == "VIS_BGSUB":
        fits_path, expected_sha = map(provenance.__getitem__, ("adapted_fits", "adapted_sha256"))
        alias = "VIS_BGSUB"
    else:
        raise ValueError("Unsupported input provenance")
    fits_path = Path(fits_path)
    if fits_path.parent != provenance_path.parent or fits_path.suffix.lower() != ".fits" or (
        packet is not None and fits_path.name != packet["lens_id"] + ".fits"
    ):
        raise ValueError("FITS is not the declared adjacent input")

    geometry = provenance["input_geometry"]
    pixel = geometry["pixel_scale_arcsec"]
    x, y = geometry["input_x_direction"], geometry["input_y_direction"]
    if type(pixel) not in (float, int) or not math.isfinite(pixel) or pixel <= 0 or any(
        axis not in ("increasing", "decreasing") for axis in (x, y)
    ):
        raise ValueError("Invalid input axes or pixel scale")
    if packet is not None and packet["input_geometry"] != geometry:
        raise ValueError("Provenance geometry disagrees with preflight")

    raw = read_exact(fits_path, output, MAX_FILE)
    fits_sha = sha(raw)
    if fits_sha != expected_sha:
        raise ValueError("FITS checksum does not match provenance")
    arrays, array_hashes, units, sky_frames = {}, {}, {}, []
    steps = [pixel if axis == "increasing" else -pixel for axis in (x, y)]
    with fits.open(io.BytesIO(raw), memmap=False) as hdus:
        for name, ext, key in (("data", "VIS_FLUX", "image"), ("noise", "VIS_RMS", "noise"), ("psf", "VIS_PSF", "psf")):
            hdu = hdus[ext]
            a = np.asarray(hdu.data)
            if a.ndim != 2 or not 1 <= min(a.shape) <= max(a.shape) <= 512 or not np.isfinite(a).all():
                raise ValueError("Invalid FITS preview array")
            array_hashes[name] = sha(a.tobytes())
            if alias:
                source_ext = alias if name == "data" else ext
                check = provenance["checks"][ext]
                if (
                    check["source_extension"] != source_ext
                    or check["array_sha256"] != array_hashes[name]
                    or check["shape"] != list(a.shape)
                    or check["dtype"] != str(a.dtype)
                    or (source_ext != ext and sha(hdus[source_ext].data.tobytes()) != array_hashes[name])
                ):
                    raise ValueError("FITS extension does not match the prepared input")
            if alias and name in ("data", "noise"):
                sky_frames.append(sky_geometry(hdu.header, steps))
            else:
                linear_geometry(provenance.get("geometry_headers", {}).get(key, {}), a.shape, steps)
                linear_geometry(hdu.header, a.shape, steps)
            a = a.astype(float)
            if name == "psf" and (a.sum() <= 0 or (x == "decreasing" and a.shape[1] % 2 == 0) or (y == "decreasing" and a.shape[0] % 2 == 0)):
                raise ValueError("Unsupported PSF centering or total flux")
            if x == "decreasing":
                a = np.fliplr(a)
            if y == "increasing":
                a = np.flipud(a)
            arrays[name] = a
            units[name] = hdu.header.get("BUNIT", provenance.get("geometry_headers", {}).get(key, {}).get("BUNIT", "未提供"))
    if sky_frames and sky_frames[0] != sky_frames[1]:
        raise ValueError("FITS Data and RMS have different sky origins")
    shape = arrays["data"].shape
    if arrays["noise"].shape != shape or np.any(arrays["noise"] <= 0):
        raise ValueError("Invalid aligned RMS map")
    if packet is not None:
        frame = packet["coordinate_frame"]
        if packet["image_shape"] != list(shape) or frame != {
            "origin": "image_center",
            "center_pixel_zero_based": [(shape[1] - 1) / 2, (shape[0] - 1) / 2],
            "x_direction": "increasing_with_column",
            "y_direction": "increasing_with_row",
            "units": "arcsec",
        }:
            raise ValueError("FITS grid does not match the preflight coordinate frame")
    arrays["snr"] = arrays["data"] / arrays["noise"]
    if not np.isfinite(arrays["snr"]).all():
        raise ValueError("Invalid signal-to-noise map")

    planes = []
    for name in ("data", "noise", "snr", "psf"):
        a = arrays[name]
        lo, hi = float(a.min()), float(a.max())
        zlo, zhi = map(float, ZScaleInterval(n_samples=1000, contrast=.25).get_limits(a))
        target = a.shape[1] * pixel / 4
        base = 10 ** math.floor(math.log10(target))
        bar = base * max(v for v in (1, 2, 5) if v <= target / base)
        ranges = {"linear": (lo, hi), "log": (lo, hi), "zscale": (zlo, zhi)}
        planes.append({
            "id": name, "shape": list(a.shape), "constant": lo == hi, "unit": units.get(name, "1"),
            "half_extent_arcsec": a.shape[0] * pixel / 2, "half_extent_x_arcsec": a.shape[1] * pixel / 2,
            "scale_bar_arcsec": bar, "data_min": lo, "data_max": hi,
            "variants": {scale: {"src": "", "vmin": bounds[0], "vmax": bounds[1]} for scale, bounds in ranges.items()},
        })
    display = {
        "schema": "tinylens.input-display.v1",
        "source": {"report_path": str(report), "provenance_path": str(provenance_path), "provenance_sha256": sha(provenance_raw),
                   "fits_path": str(fits_path), "fits_sha256": fits_sha, "array_sha256": array_hashes},
        "pixel_scale_arcsec": pixel, "x_direction": "increasing", "y_direction": "decreasing", "input_geometry": geometry,
        "log_a": 1000, "zscale": {"n_samples": 1000, "contrast": .25}, "noise_definition": "1-sigma RMS",
        "snr_definition": "data / noise_rms", "psf_sum": float(arrays["psf"].sum()), "planes": planes,
    }
    return {"display": display, "fits_base64": base64.b64encode(raw).decode("ascii")}


if __name__ == "__main__":
    print(json.dumps(input_display(json.loads(sys.stdin.readline())), allow_nan=False, separators=(",", ":")))
