from pathlib import Path

import numpy as np
from astropy.io import fits


def model_inspector_decision(
    lens_id: str,
    *,
    estimate_arcsec: float = 1.35,
    confidence: str = "medium",
) -> dict[str, object]:
    return {
        "lens_id": lens_id,
        "disposition": "model",
        "contaminant_ids": [],
        "reason": "one coherent simple lens",
        "theta_E_hint": {
            "estimate_arcsec": estimate_arcsec,
            "plausible_range_arcsec": [
                max(0.1, estimate_arcsec - 0.3),
                estimate_arcsec + 0.3,
            ],
            "confidence": confidence,
            "deflector_center": {"dra_arcsec": 0.0, "ddec_arcsec": 0.0},
            "basis": "secure tangential image family",
        },
    }


def make_lens_dir(
    root: Path, lens_id: str = "lens-001", *, image_shape: tuple[int, int] = (32, 32)
) -> Path:
    lens_dir = root / lens_id
    lens_dir.mkdir()
    image = np.zeros(image_shape, dtype=float)
    yy, xx = np.indices(image.shape)
    centre_y, centre_x = image_shape[0] // 2, image_shape[1] // 2
    image += 10.0 * np.exp(-((xx - centre_x) ** 2 + (yy - centre_y) ** 2) / 8.0)
    image += 2.0 * np.exp(-((xx - (centre_x + 6)) ** 2 + (yy - centre_y) ** 2) / 3.0)
    noise = np.full_like(image, 0.1)
    psf = np.ones((5, 5), dtype=float)
    psf /= psf.sum()
    image_y = image * 0.8
    image_j = image * 0.6
    hdus = fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(image, name="VIS_FLUX"),
            fits.ImageHDU(noise, name="VIS_RMS"),
            fits.ImageHDU(psf, name="VIS_PSF"),
            fits.ImageHDU(image_y, name="NIR_Y_FLUX"),
            fits.ImageHDU(image_j, name="NIR_J_FLUX"),
        ]
    )
    hdus.writeto(lens_dir / f"{lens_id}.fits")
    return lens_dir
