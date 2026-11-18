"""Validate the frozen numerical input shared by preview and stage displays."""

import hashlib
import io
import json
import math
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS


MAX_METADATA = 1024 * 1024
MAX_FILE = 16 * MAX_METADATA
EUCLID_SOURCE_EXTENSIONS = {"VIS_FLUX": "VIS_BGSUB", "VIS_RMS": "VIS_RMS", "VIS_PSF": "VIS_PSF"}


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


def euclid_wrapper_checks(provenance):
    checks = {}
    for entry in provenance["arrays"]:
        extension = entry["wrapper_extension"]
        source = EUCLID_SOURCE_EXTENSIONS.get(extension)
        if source is None:
            continue
        if extension in checks or entry["original_extension"] != source or entry["array_bytes_equal"] is not True:
            raise ValueError("Invalid Euclid wrapper extension provenance")
        checks[extension] = entry
    if checks.keys() != EUCLID_SOURCE_EXTENSIONS.keys():
        raise ValueError("Missing Euclid wrapper extension provenance")
    return checks


def load_frozen_input(provenance_path, output, *, lens_id=None, expected_geometry=None, file_limit=MAX_FILE):
    """Read the verified VIS image, RMS and PSF in their original array order."""
    provenance_raw = read_exact(provenance_path, output, MAX_METADATA)
    provenance = json.loads(provenance_raw)
    aliased = False
    wrapper_checks = None
    if provenance.get("schema_version") == "mock_input_provenance.v1":
        fits_path, expected_sha = map(provenance.__getitem__, ("packaged_fits_path", "packaged_fits_sha256"))
    elif "schema_version" not in provenance and provenance.get("aliases", {}).get("VIS_FLUX") == "VIS_BGSUB":
        fits_path, expected_sha = map(provenance.__getitem__, ("adapted_fits", "adapted_sha256"))
        aliased = True
    elif "schema_version" not in provenance and provenance.get("extension_name_mapping", {}).get("VIS_BGSUB") == "VIS_FLUX":
        fits_path, expected_sha = map(provenance.__getitem__, ("wrapper_fits", "wrapper_sha256"))
        wrapper_checks = euclid_wrapper_checks(provenance)
    else:
        raise ValueError("Unsupported input provenance")
    fits_path = Path(fits_path)
    if fits_path.parent != provenance_path.parent or fits_path.suffix.lower() != ".fits" or (
        lens_id is not None and fits_path.name != lens_id + ".fits"
    ):
        raise ValueError("FITS is not the declared adjacent input")

    geometry = provenance["input_geometry"]
    pixel = geometry["pixel_scale_arcsec"]
    x, y = geometry["input_x_direction"], geometry["input_y_direction"]
    if type(pixel) not in (float, int) or not math.isfinite(pixel) or pixel <= 0 or any(
        axis not in ("increasing", "decreasing") for axis in (x, y)
    ):
        raise ValueError("Invalid input axes or pixel scale")
    if expected_geometry is not None and expected_geometry != geometry:
        raise ValueError("Provenance geometry disagrees with the frozen run")

    raw = read_exact(fits_path, output, file_limit)
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
            if aliased or wrapper_checks is not None:
                if wrapper_checks is not None:
                    check = wrapper_checks[ext]
                    if type(check["index"]) is not int or check["index"] != hdus.index_of(ext):
                        raise ValueError("FITS extension index does not match the Euclid wrapper")
                else:
                    source_ext = EUCLID_SOURCE_EXTENSIONS[ext]
                    check = provenance["checks"][ext]
                    if check["source_extension"] != source_ext or (
                        source_ext != ext and sha(hdus[source_ext].data.tobytes()) != array_hashes[name]
                    ):
                        raise ValueError("FITS extension does not match the declared alias")
                if (
                    check["array_sha256"] != array_hashes[name]
                    or check["shape"] != list(a.shape)
                    or check["dtype"] != str(a.dtype)
                ):
                    raise ValueError("FITS extension does not match the prepared input")
            if (aliased or wrapper_checks is not None) and name in ("data", "noise"):
                sky_frames.append(sky_geometry(hdu.header, steps))
            else:
                linear_geometry(provenance.get("geometry_headers", {}).get(key, {}), a.shape, steps)
                linear_geometry(hdu.header, a.shape, steps)
            a = a.astype(float)
            if name == "psf" and (a.sum() <= 0 or (x == "decreasing" and a.shape[1] % 2 == 0) or (y == "decreasing" and a.shape[0] % 2 == 0)):
                raise ValueError("Unsupported PSF centering or total flux")
            arrays[name] = a
            units[name] = hdu.header.get("BUNIT", provenance.get("geometry_headers", {}).get(key, {}).get("BUNIT", "未提供"))
    if sky_frames and sky_frames[0] != sky_frames[1]:
        raise ValueError("FITS Data and RMS have different sky origins")
    shape = arrays["data"].shape
    if arrays["noise"].shape != shape or np.any(arrays["noise"] <= 0):
        raise ValueError("Invalid aligned RMS map")
    return {
        "geometry": geometry, "arrays": arrays, "units": units,
        "array_hashes": array_hashes, "fits_raw": raw, "fits_path": fits_path,
        "fits_sha256": fits_sha, "provenance_sha256": sha(provenance_raw),
    }
