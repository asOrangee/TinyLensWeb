"""Read the contamination plane paired with a Euclid DR1 ECLIPSE VIS cutout."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits

from ..configuration import InputGeometry
from ..data.loader import canonical_input_array
from ..workbench_display import file_sha256


EUCLID_MASK_TITLE = "Euclid DR1 contamination mask"
EUCLID_MASK_PATH = Path("segmentation/artefact_binary.fits")


@dataclass(frozen=True)
class EuclidContamination:
    pixels: np.ndarray
    provenance: dict[str, object]


def binary_mask_sha256(mask: np.ndarray) -> str:
    return hashlib.sha256(mask.astype(np.uint8, copy=False).tobytes()).hexdigest()


def find_euclid_dataset(lens_dir: Path, *, release_root: Path | None = None) -> Path | None:
    """Find the release sidecar through the lens layout or its input provenance."""
    candidates = [lens_dir / "dataset"]
    if release_root is not None:
        candidates.append(release_root / lens_dir.name / "dataset")
    candidates.append(lens_dir)
    for directory in candidates:
        mask = directory / EUCLID_MASK_PATH
        if mask.exists() or mask.is_symlink():
            return directory

    try:
        provenance = json.loads((lens_dir / "input-provenance.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(provenance, dict):
        return None
    source_files = provenance.get("source_files")
    image = source_files.get("image") if isinstance(source_files, dict) else None
    for source in (provenance.get("original_fits"), image.get("path") if isinstance(image, dict) else None):
        if isinstance(source, str):
            cutout = Path(source)
            if cutout.is_absolute() and cutout.name == f"{lens_dir.name}.fits":
                mask = cutout.parent / EUCLID_MASK_PATH
                if mask.exists() or mask.is_symlink():
                    return cutout.parent
    return None


def load_euclid_contamination(
    lens_dir: Path, dataset_dir: Path, geometry: InputGeometry
) -> EuclidContamination:
    dataset_dir = dataset_dir.resolve(strict=True)
    input_fits = lens_dir / f"{lens_dir.name}.fits"
    published_fits = dataset_dir / input_fits.name
    published_mask = dataset_dir / EUCLID_MASK_PATH
    files = {
        "input_fits_sha256": input_fits,
        "published_cutout_sha256": published_fits,
        "published_mask_sha256": published_mask,
    }
    fingerprints = {key: file_sha256(path) for key, path in files.items()}

    # The release mask has no independent WCS. Its grid is defined by the
    # paired VIS image in the same published dataset, in the original order.
    image = fits.getdata(input_fits, "VIS_FLUX", memmap=False)
    release_image = fits.getdata(published_fits, "VIS_BGSUB", memmap=False)
    if image.ndim != 2 or not np.array_equal(image, release_image):
        raise ValueError("Euclid VIS_BGSUB pixels do not match the input VIS_FLUX in FITS order")
    with fits.open(published_mask, memmap=False) as hdus:
        mask = np.asarray(hdus[0].data)
    if mask.shape != image.shape or not np.isin(mask, [0, 1]).all():
        raise ValueError("Euclid artefact_binary.fits must be binary and match the VIS image shape")
    if any(file_sha256(path) != fingerprints[key] for key, path in files.items()):
        raise ValueError("A Euclid input or mask changed while validating the dataset")

    canonical = canonical_input_array(mask == 1, geometry)
    return EuclidContamination(canonical, {
        "dataset_dir": str(dataset_dir),
        "image_shape": list(image.shape),
        "canonical_mask_sha256": binary_mask_sha256(canonical),
        **fingerprints,
    })
