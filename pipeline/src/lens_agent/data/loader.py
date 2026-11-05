from __future__ import annotations

from pathlib import Path

import numpy as np
from astropy.io import fits
from pydantic import BaseModel

from ..configuration import InputGeometry


class LensData(BaseModel):
    model_config = {"arbitrary_types_allowed": True}

    lens_id: str
    fits_path: Path
    image: np.ndarray
    noise: np.ndarray
    psf: np.ndarray
    image_y: np.ndarray | None = None
    image_j: np.ndarray | None = None
    pixel_scale_arcsec: float = 0.1
    input_x_direction: str = "increasing"
    input_y_direction: str = "increasing"


def load_lens_data(lens_dir: Path, *, geometry: InputGeometry | None = None) -> LensData:
    geometry = InputGeometry.from_settings(geometry) if geometry is not None else InputGeometry()
    lens_dir = lens_dir.resolve()
    lens_id = lens_dir.name
    fits_path = lens_dir / f"{lens_id}.fits"
    if not fits_path.is_file():
        raise FileNotFoundError(f"lens FITS not found: {fits_path}")
    with fits.open(fits_path, memmap=False) as hdul:
        missing = [name for name in ("VIS_FLUX", "VIS_RMS", "VIS_PSF") if name not in hdul]
        if missing:
            raise ValueError(f"missing FITS extensions: {', '.join(missing)}")
        image = np.asarray(hdul["VIS_FLUX"].data, dtype=np.float64)
        noise = np.asarray(hdul["VIS_RMS"].data, dtype=np.float64)
        psf = np.asarray(hdul["VIS_PSF"].data, dtype=np.float64)
        image_y = _optional_image(hdul, "NIR_Y_FLUX", image.shape)
        image_j = _optional_image(hdul, "NIR_J_FLUX", image.shape)
    if image.ndim != 2 or noise.shape != image.shape or psf.ndim != 2:
        raise ValueError(
            f"invalid VIS shapes: image={image.shape}, noise={noise.shape}, psf={psf.shape}"
        )
    if not np.isfinite(image).all() or not np.isfinite(noise).all() or not np.isfinite(psf).all():
        raise ValueError("VIS input contains non-finite values")
    if np.any(noise <= 0):
        raise ValueError("VIS_RMS must be strictly positive")
    if psf.sum() <= 0:
        raise ValueError("VIS_PSF must have positive total flux")
    for axis, direction in ((0, geometry.input_y_direction), (1, geometry.input_x_direction)):
        if direction == "decreasing" and psf.shape[axis] % 2 == 0:
            raise ValueError("Direction normalization requires an odd-sized PSF on each reflected axis; validate the kernel centre before modeling")
    # Change only array ordering, never pixel sampling, flux, noise or the input file.
    # All co-registered planes and the PSF use the same reflection. Model coordinates
    # remain centred on (nx-1)/2, (ny-1)/2, increasing with column/row respectively.
    def canonical(array):
        if array is None:
            return None
        if geometry.input_y_direction == "decreasing":
            array = np.flip(array, axis=0)
        if geometry.input_x_direction == "decreasing":
            array = np.flip(array, axis=1)
        return np.ascontiguousarray(array)

    return LensData(
        lens_id=lens_id,
        fits_path=fits_path,
        image=canonical(image),
        noise=canonical(noise),
        psf=canonical(psf),
        image_y=canonical(image_y),
        image_j=canonical(image_j),
        **geometry.model_dump(),
    )


def _optional_image(
    hdul: fits.HDUList, extension: str, expected_shape: tuple[int, int]
) -> np.ndarray | None:
    """Load an optional aligned science image used only for visual inspection."""
    if extension not in hdul:
        return None
    image = np.asarray(hdul[extension].data, dtype=np.float64)
    if image.shape != expected_shape or not np.isfinite(image).all():
        return None
    return image
