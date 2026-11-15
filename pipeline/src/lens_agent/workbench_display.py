"""Publish numerical display artifacts from the completed stage, beside its evidence."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

import numpy as np
from astropy.io import fits

SCHEMA = "tinylens.stage-display.v1"
MODEL_STAGES = ("a", "m0", "m1", "m2", "m3")
MODEL_PLANES = ("observation", "model", "source-lensed", "source", "residual", "chi-square")
EXTENSIONS = {
    "data": "DATA", "noise": "RMS", "snr": "SNR", "psf": "PSF",
    "observation": "DATA", "mask": "ARC_MASK", "domain": "VALID_DOMAIN",
    "model": "MODEL", "source-lensed": "LENSED_SOURCE", "source": "SOURCE",
    "residual": "RESIDUAL", "chi-square": "CHI_SQUARE",
}
_CAPTURE: ContextVar[dict | None] = ContextVar("tinylens_display", default=None)


@contextmanager
def capture_model_planes():
    display = {}
    token = _CAPTURE.set(display)
    try:
        yield display
    finally:
        _CAPTURE.reset(token)


def active_capture():
    return _CAPTURE.get()


def image_bounds(shape, pixel):
    ny, nx = shape
    return [-nx * pixel / 2, nx * pixel / 2, -ny * pixel / 2, ny * pixel / 2]


def record_prediction(capture, image, rms, lens_light, lensed_source):
    source = np.asarray(lensed_source, dtype=float)
    total = np.asarray(lens_light, dtype=float) + source
    residual = (np.asarray(image, dtype=float) - total) / np.asarray(rms, dtype=float)
    capture["planes"].update({
        "model": total, "source-lensed": source,
        "residual": residual, "chi-square": np.square(residual),
    })


def file_sha256(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _reference(path, base):
    if not path.is_file() or path.resolve(strict=True) != path:
        raise ValueError(f"Invalid display dependency {path.name}")
    return {"path": path.relative_to(base).as_posix(), "sha256": file_sha256(path)}


def _atomic_write(path, write):
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    os.close(descriptor)
    try:
        write(Path(temporary))
        # An existing artifact can be reused byte for byte. Never replace an
        # immutable display with a different result for the same attempt.
        try:
            os.link(temporary, path)
        except FileExistsError:
            if path.is_symlink() or file_sha256(path) != file_sha256(Path(temporary)):
                raise ValueError(f"Refusing to replace existing {path.name}")
    finally:
        Path(temporary).unlink(missing_ok=True)


def _json(path, payload):
    _atomic_write(path, lambda out: out.write_text(
        json.dumps(payload, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    ))


def _posterior(stage, payload):
    """Export the same weighted quantiles and histogram definition as the legacy reader."""
    extra = payload.get("extra", {})
    fixed = extra.get("mass_medians_fixed", {})
    output = {
        "fixed_parameters": {name: float(fixed[name]) for name in (
            "theta_E", "e1_mass", "e2_mass", "center_x_mass", "center_y_mass", "gamma1", "gamma2",
        ) if name in fixed and np.isfinite(fixed[name])},
    }
    if stage == "m0":
        output["kind"] = "evidence_scan"
        scan = {"log_lambda_best": float(extra["log_lambda_best"])}
        for level in ("coarse", "fine"):
            x = np.asarray(extra["lambda_grid_" + level], dtype=float)
            y = np.asarray(extra["log_ev_" + level], dtype=float)
            if x.ndim != 1 or x.shape != y.shape or not x.size or not np.isfinite(x).all() or not np.isfinite(y).all():
                raise ValueError("Invalid saved evidence scan")
            scan[level] = {"log_lambda": x.tolist(), "log_evidence": y.tolist()}
        output["scan"] = scan
        return output

    names = payload["param_names"]
    samples = np.asarray(payload["samples"], dtype=float)
    weights = np.asarray(payload["weights"], dtype=float)
    if (not names or len(set(names)) != len(names) or samples.shape != (len(weights), len(names))
        or not np.isfinite(samples).all() or not np.isfinite(weights).all()
        or np.any(weights < 0) or not 0 < weights.sum() < np.inf):
        raise ValueError("Invalid saved weighted posterior")
    weights = weights / weights.sum()
    parameters = []
    for name, values in zip(names, samples.T):
        order = np.argsort(values)
        cumulative = np.cumsum(weights[order])
        q16, q50, q84 = np.interp([.16, .50, .84], cumulative, values[order])
        lower, upper = np.minimum(np.searchsorted(cumulative, [.001, .999]), len(order) - 1)
        lo, hi = float(values[order[lower]]), float(values[order[upper]])
        if lo == hi:
            lo, hi = float(values.min()), float(values.max())
        if lo == hi:
            margin = max(abs(lo) * 1e-6, 1e-9)
            lo, hi = lo - margin, hi + margin
        hist, edges = np.histogram(values, bins=64, range=(lo, hi), weights=weights)
        parameters.append({
            "name": name, "q16": float(q16), "q50": float(q50), "q84": float(q84),
            "edges": edges.tolist(), "density": (hist / np.diff(edges)).tolist(),
            "shown_probability": float(hist.sum()),
        })
    return {**output, "kind": "weighted_posterior", "parameters": parameters,
            "sample_count": len(samples), "effective_sample_size": float(1 / np.square(weights).sum())}


def publish_display(run, directory, stage, attempt, data, *, upstream=None, capture=None,
                    domain_mask=None, result=None, posterior_payload=None, input_sha256=None):
    """Write FITS and its manifest, published last. Source arrays use canonical x/y."""
    lens_id = data.lens_id
    if run.name != lens_id:
        raise ValueError("Display run does not match its input lens")
    expected = run / "preflight" if stage == "preflight" else run / "attempts" / stage / str(attempt)
    if directory != expected or directory.resolve(strict=True) != directory:
        raise ValueError("Display output is outside its stage")
    pixel = data.pixel_scale_arcsec
    input_path = data.fits_path
    source_sha = file_sha256(input_path)
    if input_sha256 is not None and source_sha != input_sha256:
        raise ValueError("Input FITS changed during display capture")
    with fits.open(input_path, memmap=True) as hdus:
        units = {name: hdus[ext].header.get("BUNIT") for name, ext in
                 (("observation", "VIS_FLUX"), ("noise", "VIS_RMS"), ("psf", "VIS_PSF"))}
    units["data"] = units["observation"]
    units["snr"] = units["residual"] = units["chi-square"] = "1"
    units["model"] = units["source-lensed"] = units["observation"]
    manifest = {
        "schema": SCHEMA, "run": str(run), "lens_id": lens_id, "stage": stage, "attempt": attempt,
        "input": {"path": str(input_path), "sha256": source_sha, "pixel_scale_arcsec": pixel},
        "run_manifest": _reference(run / "run-manifest.json", run),
        "upstream": [],
        "planes": {},
    }
    for name, artifact_dir in (upstream or {}).items():
        base = Path(artifact_dir).parent
        if base != run / "attempts" / name / base.name or not base.name.isdecimal():
            raise ValueError("Upstream attempt does not belong to the display run")
        manifest["upstream"].append({"stage": name, "attempt": int(base.name),
                                     **_reference(base / "stage-result.json", run)})

    if stage == "preflight":
        from astropy.visualization import ZScaleInterval

        arrays = {"data": data.image, "noise": data.noise, "snr": data.image / data.noise, "psf": data.psf}
        manifest["inspection"] = _reference(directory / "inspection.json", directory)
    else:
        manifest["summary"] = _reference(directory / "stage-result.json", directory)
        manifest["configuration"] = _reference(directory / "effective-config.json", directory)
        if stage == "b":
            mask_path = directory / result["artifacts"]["feature_mask_fits"]
            domain_path = run / "preflight" / "modeling_mask.fits"
            manifest["feature_mask"] = _reference(mask_path, run)
            manifest["modeling_mask"] = _reference(domain_path, run)
            stored_mask = np.asarray(fits.getdata(mask_path))
            if not np.isin(stored_mask, [0, 1]).all():
                raise ValueError("Invalid saved arc mask")
            arrays = {"observation": data.image, "mask": stored_mask == 0, "domain": ~domain_mask}
            if np.any(arrays["mask"] & ~arrays["domain"]):
                raise ValueError("Arc mask leaves the modeling domain")
        elif stage in MODEL_STAGES:
            capture = capture or {}
            arrays = {"observation": data.image, **capture.get("planes", {})}
            if capture.get("mapping"):
                manifest["mapping"] = capture["mapping"]
            if posterior_payload is not None:
                parameters = directory / "display-parameters.json"
                try:
                    _json(parameters, _posterior(stage, posterior_payload))
                    manifest["parameters"] = _reference(parameters, directory)
                except (OSError, KeyError, TypeError, ValueError) as error:
                    logging.getLogger(__name__).warning(f"Workbench parameters unavailable: {error}")
        else:
            raise ValueError("Stage has no workbench display")

    hdus = [fits.PrimaryHDU()]
    for role, array in arrays.items():
        value = np.asarray(array, dtype=np.uint8 if role in ("mask", "domain") else np.float64)
        if value.ndim != 2 or not 1 <= min(value.shape) <= max(value.shape) <= 512 or not np.isfinite(value).all():
            raise ValueError(f"Invalid numerical display plane {role}")
        bounds = capture["source_bounds"] if role == "source" else image_bounds(value.shape, pixel)
        name = EXTENSIONS[role]
        metadata = {"extension": name, "shape": list(value.shape), "bounds_arcsec": list(bounds)}
        header = fits.Header()
        ny, nx = value.shape
        dx, dy = (bounds[1] - bounds[0]) / nx, (bounds[3] - bounds[2]) / ny
        for axis, step, edge in ((1, dx, bounds[0]), (2, dy, bounds[2])):
            header[f"CUNIT{axis}"] = "arcsec"
            header[f"CDELT{axis}"] = step
            header[f"CRPIX{axis}"] = 1.0
            header[f"CRVAL{axis}"] = edge + step / 2
        if units.get(role):
            metadata["unit"] = header["BUNIT"] = units[role]
        if stage == "preflight":
            metadata["zscale"] = list(map(float, ZScaleInterval(n_samples=1000, contrast=.25).get_limits(value[::-1])))
        manifest["planes"][role] = metadata
        hdus.append(fits.ImageHDU(value, header=header, name=name))
    path = directory / "display.fits"
    _atomic_write(path, lambda out: fits.HDUList(hdus).writeto(out, overwrite=True))
    manifest["fits"] = _reference(path, directory)
    target = directory / "display-manifest.json"
    _json(target, manifest)
    return target
