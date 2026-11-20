"""Publish numerical display artifacts from the completed stage, beside its evidence."""

from __future__ import annotations

import logging
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

import numpy as np
from astropy.io import fits

CONTRACT = json.loads(Path(__file__).with_name("display_contract.json").read_text(encoding="utf-8"))
SCHEMA = CONTRACT["schema"]
PREVIOUS_NAMED_SCHEMA = CONTRACT["previousNamedSchema"]
LEGACY_SCHEMA = "tinylens.stage-display.v1"
DISPLAY_DIRECTORY = CONTRACT["directory"]
DISPLAY_REFERENCE = {"schema": SCHEMA, "path": DISPLAY_DIRECTORY}
PARAMETER_FILE = CONTRACT["parameterFile"]
MAPPING_FILE = CONTRACT["mappingFile"]
MODEL_STAGES = ("a", "m0", "m1", "m2", "m3")
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


def record_prediction(capture, image, rms, lens_light, lensed_source, *, valid=None):
    source = np.asarray(lensed_source, dtype=float)
    total = np.asarray(lens_light, dtype=float) + source
    residual = (np.asarray(image, dtype=float) - total) / np.asarray(rms, dtype=float)
    capture["planes"].update({
        "model": total, "source-lensed": source,
        "residual": residual, "chi-square": np.square(residual),
    })
    if valid is not None:
        capture["valid_domain"] = np.asarray(valid, dtype=bool).copy()


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


def display_filename(stage, role):
    return f'{CONTRACT["stagePrefixes"][stage]}_{CONTRACT["imageNames"][role]}.fits'


def _stage_a_source(upstream, input_sha, shape, pixel):
    base = Path(upstream["a"]).parent
    manifest_path = base / "display-manifest.json"
    if not manifest_path.is_file():
        return None
    _reference(manifest_path, base)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest["stage"], manifest["attempt"], manifest["input"]["sha256"], manifest["summary"]) != (
        "a", int(base.name), input_sha, _reference(base / "stage-result.json", base)
    ):
        raise ValueError("Stage A display does not match Stage B's input")
    plane = manifest["planes"].get("source-lensed")
    if not plane:
        return None
    if manifest["schema"] in (SCHEMA, PREVIOUS_NAMED_SCHEMA):
        path = base / DISPLAY_DIRECTORY / display_filename("a", "source-lensed")
        reference = plane
        extension = 0
    elif manifest["schema"] == LEGACY_SCHEMA:
        path = base / "display.fits"
        reference = manifest["fits"]
        extension = "LENSED_SOURCE"
    else:
        raise ValueError("Unknown Stage A display format")
    if _reference(path, base) != {key: reference[key] for key in ("path", "sha256")}:
        raise ValueError("Stage A source display checksum mismatch")
    if plane["shape"] != list(shape) or plane["bounds_arcsec"] != image_bounds(shape, pixel):
        raise ValueError("Stage A source display does not match Stage B's pixel grid")
    return fits.getdata(path, extension)


def _publish_sidecar(prepared, manifest, contract, key, payload):
    name = f'{CONTRACT["stagePrefixes"][manifest["stage"]]}_{contract["suffix"]}'
    path = prepared / name
    _json(path, payload)
    manifest[key] = {"path": f"{DISPLAY_DIRECTORY}/{name}", "sha256": file_sha256(path)}


def _mapping_packet(manifest, mapping):
    frames = {}
    for frame, role in (("image", "observation"), ("source", "source")):
        plane = manifest["planes"][role]
        bounds = plane["bounds_arcsec"]
        frames[frame] = {"shape": plane["shape"], "bounds_arcsec": bounds, "fits_sha256": plane["sha256"],
                         "half_extent_arcsec": (bounds[3] - bounds[2]) / 2}
    if mapping["curve_sampling"]["bounds_arcsec"] != frames["image"]["bounds_arcsec"]:
        raise ValueError("Critical curve sampling does not match the image FITS frame")
    return {
        **mapping, **{key: manifest[key] for key in ("run", "run_id", "lens_id", "stage", "attempt") if key in manifest},
        "schema": MAPPING_FILE["schema"], "synthetic": False, "frames": frames,
        "coordinates": {"unit": "arcsec", "origin": "geometric-center", "x": "right", "y": "up"},
        "summary_sha256": manifest["summary"]["sha256"], "fits_sha256": manifest["input"]["sha256"],
    }


def _publish_files(directory, manifest, planes, parameters, mapping):
    display = directory / DISPLAY_DIRECTORY
    with tempfile.TemporaryDirectory(prefix=".display-", dir=directory) as staging:
        prepared = Path(staging) / DISPLAY_DIRECTORY
        prepared.mkdir()
        for role, hdu in planes.items():
            name = display_filename(manifest["stage"], role)
            hdu.writeto(prepared / name)
            manifest["planes"][role].update(
                path=f"{DISPLAY_DIRECTORY}/{name}", sha256=file_sha256(prepared / name)
            )
        if parameters is not None:
            try:
                _publish_sidecar(prepared, manifest, PARAMETER_FILE, "parameters", parameters)
            except (OSError, TypeError, ValueError) as error:
                logging.getLogger(__name__).warning("Workbench parameter file unavailable: %s", error)
        if mapping is not None and "source" in planes:
            try:
                _publish_sidecar(prepared, manifest, MAPPING_FILE, "mapping_file", _mapping_packet(manifest, mapping))
            except (OSError, KeyError, TypeError, ValueError) as error:
                logging.getLogger(__name__).warning("Workbench lens mapping file unavailable: %s", error)
        try:
            prepared.rename(display)
        except OSError:
            if display.is_symlink() or not display.is_dir():
                raise
            files = list(manifest["planes"].values())
            files.extend(manifest[key] for key in ("parameters", "mapping_file") if key in manifest)
            for item in files:
                path = directory / item["path"]
                if _reference(path, directory) != {key: item[key] for key in ("path", "sha256")}:
                    raise ValueError(f"Refusing to replace existing {path.name}")


def _posterior(stage, payload):
    """Export the same weighted quantiles and histogram definition as the legacy reader."""
    extra = payload.get("extra", {})
    if stage == "m0":
        scan = {"log_lambda_best": float(extra["log_lambda_best"])}
        if not np.isfinite(scan["log_lambda_best"]):
            raise ValueError("Invalid saved evidence optimum")
        for level in ("coarse", "fine"):
            x = np.asarray(extra["lambda_grid_" + level], dtype=float)
            y = np.asarray(extra["log_ev_" + level], dtype=float)
            if (x.ndim != 1 or x.shape != y.shape or not 1 <= x.size <= 100_000
                or not np.isfinite(x).all() or not np.isfinite(y).any()):
                raise ValueError("Invalid saved evidence scan")
            scan[level] = {"log_lambda": x.tolist(),
                           "log_evidence": [float(v) if np.isfinite(v) else None for v in y]}
        return {"kind": "evidence_scan", "scan": scan}

    names = payload["param_names"]
    samples = np.asarray(payload["samples"], dtype=float)
    weights = np.asarray(payload["weights"], dtype=float)
    if (not names or len(set(names)) != len(names) or weights.ndim != 1 or samples.shape != (len(weights), len(names))
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
            "error_minus": float(q50 - q16), "error_plus": float(q84 - q50),
            "edges": edges.tolist(), "density": (hist / np.diff(edges)).tolist(),
            "shown_probability": float(hist.sum()),
        })
    return {"kind": "weighted_posterior", "parameters": parameters,
            "estimate": "weighted_median", "quantile_levels": [.16, .50, .84],
            "sample_count": len(samples), "effective_sample_size": float(1 / np.square(weights).sum())}


def _parameter_packet(directory, manifest, result, capture, posterior_payload):
    stage = manifest["stage"]
    packet = {key: manifest[key] for key in ("run", "lens_id", "stage", "attempt")}
    packet.update(schema=PARAMETER_FILE["schema"], input_sha256=manifest["input"]["sha256"])
    if stage == "preflight":
        inspection = json.loads((directory / "inspection.json").read_bytes())
        detection = inspection.get("segmentation_detection", {})
        settings = {
            name: detection[key] for name, key in (
                ("detection_threshold", "threshold_sigma"),
                ("minimum_connected_pixels", "min_connected_pixels"),
            ) if key in detection
        }
        packet.update(config={"settings": settings}, metrics={
            "input_geometry": inspection["input_geometry"], "image_shape": inspection["image_shape"],
            "segment_count": inspection.get("segment_count"),
        })
        return packet

    metrics = result["metrics"].copy()
    if stage == "b" and "modeling_radius_arcsec" in manifest:
        metrics["modeling_radius_arcsec"] = manifest["modeling_radius_arcsec"]
    packet.update(config=json.loads((directory / "effective-config.json").read_bytes()), metrics=metrics)
    if stage not in MODEL_STAGES:
        return packet

    extra = (posterior_payload or {}).get("extra", {})
    mass = capture.get("mass_parameters", {})
    mass_keys = ("theta_E", "e1_mass", "e2_mass", "center_x_mass", "center_y_mass", "gamma1", "gamma2")
    fixed = {}
    if stage in ("m0", "m2"):
        fixed = {key: value for key, value in {**mass, **extra.get("mass_medians_fixed", {})}.items() if key in mass_keys}
    elif stage in ("m1", "m3"):
        fixed = {key: mass[key] for key in ("center_x_mass", "center_y_mass") if key in mass}
    if stage == "m3":
        fixed.update({key: value for key, value in extra.get("reg_hyperparams_fixed", {}).items()
                      if key in ("log_lambda_reg", "adaptive_reg_rho")})
    packet["fixed_parameters"] = {key: float(value) for key, value in fixed.items() if np.isfinite(value)}
    linear = capture.get("linear_parameters", {}).copy()
    if "source" in manifest["planes"] and stage != "a":
        linear["source_brightness"] = {"fits": display_filename(stage, "source"), "shape": manifest["planes"]["source"]["shape"]}
    packet["linear_parameters"] = linear
    if posterior_payload is not None:
        try:
            packet["distribution"] = _posterior(stage, posterior_payload)
            metrics.pop("posterior_quantiles", None)
        except (KeyError, TypeError, ValueError) as error:
            logging.getLogger(__name__).warning("Workbench parameter distribution unavailable: %s", error)
    return packet


def _image_hdus(arrays, stage, pixel, observation_shape, capture, units):
    if stage == "preflight":
        from astropy.visualization import ZScaleInterval

    hdus = {}
    metadata_by_role = {}
    for role, array in arrays.items():
        value = np.asarray(array, dtype=np.uint8 if role in ("mask", "domain") else np.float64)
        if value.ndim != 2 or not 1 <= min(value.shape) <= max(value.shape) <= 512 or not np.isfinite(value).all():
            raise ValueError(f"Invalid numerical display plane {role}")
        if role not in ("source", "psf") and value.shape != observation_shape:
            raise ValueError(f"Unaligned image plane {role}")
        bounds = capture["source_bounds"] if role == "source" else image_bounds(value.shape, pixel)
        if len(bounds) != 4 or not np.isfinite(bounds).all() or bounds[0] >= bounds[1] or bounds[2] >= bounds[3]:
            raise ValueError(f"Invalid bounds for {role}")
        metadata = {"shape": list(value.shape), "bounds_arcsec": list(bounds)}
        header = fits.Header()
        ny, nx = value.shape
        dx, dy = (bounds[1] - bounds[0]) / nx, (bounds[3] - bounds[2]) / ny
        for axis, step, edge in ((1, dx, bounds[0]), (2, dy, bounds[2])):
            header[f"CTYPE{axis}"] = "LINEAR"
            header[f"CUNIT{axis}"] = "arcsec"
            header[f"CDELT{axis}"] = step
            header[f"CRPIX{axis}"] = 1.0
            header[f"CRVAL{axis}"] = edge + step / 2
        if units.get(role):
            metadata["unit"] = header["BUNIT"] = units[role]
        if stage == "preflight":
            limits = list(map(float, ZScaleInterval(n_samples=1000, contrast=.25).get_limits(value[::-1])))
            metadata["zscale"] = limits if np.isfinite(limits).all() and limits[0] <= limits[1] else [
                float(value.min()), float(value.max()),
            ]
        metadata_by_role[role] = metadata
        hdus[role] = fits.PrimaryHDU(value, header=header)
    return hdus, metadata_by_role


def publish_display(run, directory, stage, attempt, data, *, upstream=None, capture=None,
                    domain_mask=None, result=None, posterior_payload=None, input_sha256=None):
    """Publish one FITS per plane and then its immutable manifest."""
    lens_id = data.lens_id
    if run.name != lens_id:
        raise ValueError("Display run does not match its input lens")
    expected = run / "preflight" if stage == "preflight" else run / "attempts" / stage / str(attempt)
    if directory != expected or directory.resolve(strict=True) != directory:
        raise ValueError("Display output is outside its stage")
    target = directory / "display-manifest.json"
    if target.is_file():
        _reference(target, directory)
        existing = json.loads(target.read_text(encoding="utf-8"))
        if existing.get("schema") in (LEGACY_SCHEMA, PREVIOUS_NAMED_SCHEMA):
            return target
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
    run_id = json.loads((run / "run-manifest.json").read_bytes()).get("run_id")
    if run_id is not None:
        manifest["run_id"] = run_id
    for name, artifact_dir in (upstream or {}).items():
        base = Path(artifact_dir).parent
        if base != run / "attempts" / name / base.name or not base.name.isdecimal():
            raise ValueError("Upstream attempt does not belong to the display run")
        manifest["upstream"].append({"stage": name, "attempt": int(base.name),
                                     **_reference(base / "stage-result.json", run)})

    capture = capture or {}
    if stage == "preflight":
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
            radius = fits.getheader(domain_path).get("MODELRAD")
            if radius is not None and np.isfinite(radius) and radius > 0:
                manifest["modeling_radius_arcsec"] = float(radius)
            stored_mask = np.asarray(fits.getdata(mask_path))
            if not np.isin(stored_mask, [0, 1]).all():
                raise ValueError("Invalid saved arc mask")
            arrays = {"observation": data.image, "mask": stored_mask == 0, "domain": ~np.asarray(domain_mask, dtype=bool)}
            if np.any(arrays["mask"] & ~arrays["domain"]):
                raise ValueError("Arc mask leaves the modeling domain")
            if upstream and "a" in upstream:
                try:
                    lensed = _stage_a_source(upstream, source_sha, data.image.shape, pixel)
                    if lensed is not None:
                        arrays["source-lensed"] = lensed
                except (OSError, KeyError, TypeError, ValueError) as error:
                    logging.getLogger(__name__).warning("Stage B Lensed source unavailable: %s", error)
        elif stage in MODEL_STAGES:
            arrays = {"observation": data.image, **capture.get("planes", {})}
            if domain_mask is not None:
                valid = np.asarray(capture.get("valid_domain"))
                exclusion = np.asarray(domain_mask, dtype=bool)
                fitted_count = result["metrics"].get("residual_diagnostics", {}).get("pixel_count")
                if (valid.shape != data.image.shape or exclusion.shape != valid.shape
                        or valid.dtype != np.bool_ or not valid.any() or np.any(valid & exclusion)
                        or (stage == "a" and not np.array_equal(valid, ~exclusion))
                        or (fitted_count is not None and int(valid.sum()) != fitted_count)):
                    logging.getLogger(__name__).warning("Workbench fit mask disagrees with %s", stage)
                    arrays = {}
                else:
                    domain_path = run / "preflight" / "modeling_mask.fits"
                    manifest["modeling_mask"] = _reference(domain_path, run)
                    arrays["domain"] = valid
        else:
            raise ValueError("Stage has no workbench display")

    kind = stage if stage in ("preflight", "b") else "model"
    required = set(CONTRACT["required"][kind])
    allowed = required | set(CONTRACT["optional"].get(kind, ()))
    if not required <= arrays.keys() <= allowed:
        logging.getLogger(__name__).warning("Missing or unexpected display planes for %s", stage)
        arrays = {}

    try:
        hdus, manifest["planes"] = _image_hdus(arrays, stage, pixel, data.image.shape, capture, units)
    except (KeyError, TypeError, ValueError) as error:
        logging.getLogger(__name__).warning("Workbench images unavailable: %s", error)
        hdus = {}
    parameters = None
    try:
        parameters = _parameter_packet(directory, manifest, result, capture, posterior_payload)
    except (OSError, KeyError, TypeError, ValueError) as error:
        logging.getLogger(__name__).warning("Workbench parameters unavailable: %s", error)
    _publish_files(directory, manifest, hdus, parameters, capture.get("mapping"))
    _json(target, manifest)
    return target
