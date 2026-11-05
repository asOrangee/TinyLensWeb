from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from skimage import measure
from skimage.morphology import dilation, erosion, mirror_footprint, pad_footprint


@dataclass(frozen=True)
class ArcMaskConstruction:
    """One mask and the exact intermediate evidence that produced it."""

    threshold_island_labels: np.ndarray
    threshold_island_sizes: dict[int, int]
    surviving_threshold_island_ids: tuple[int, ...]
    filtered_signal: np.ndarray
    closed_signal: np.ndarray
    arc_region: np.ndarray
    feature_mask: np.ndarray
    excluded_above_threshold_pixel_count: int


def _retain_seed_connected_regions(
    candidate: np.ndarray, seeds: np.ndarray, valid: np.ndarray
) -> np.ndarray:
    """Keep only valid candidate regions connected to an original Arc Seed."""
    constrained = np.asarray(candidate, dtype=bool) & valid
    labels = measure.label(constrained)
    seed_labels = np.unique(labels[np.asarray(seeds, dtype=bool)])
    seed_labels = seed_labels[seed_labels > 0]
    return np.isin(labels, seed_labels)


def _constrained_square_dilation(
    signal: np.ndarray, valid: np.ndarray, footprint_size: int
) -> np.ndarray:
    """Dilate through valid neighboring pixels without crossing an exclusion.

    Repeated one-pixel propagation is identical to one square-footprint dilation
    away from exclusions.  Applying the valid-domain constraint after every step
    makes even a finite excluded segment a true propagation barrier.
    """
    result = np.asarray(signal, dtype=bool) & valid
    if footprint_size <= 1:
        return result
    symmetric_steps = (footprint_size - 1) // 2
    for _ in range(symmetric_steps):
        result = dilation(result, footprint=np.ones((3, 3), dtype=bool)) & valid
    if footprint_size % 2 == 0:
        result = dilation(result, footprint=np.ones((2, 2), dtype=bool)) & valid
    return result


def construct_arc_mask(
    snr_map: np.ndarray,
    *,
    modeling_mask: np.ndarray | None = None,
    threshold: float,
    ignor_size: int,
    ext_size: int,
    close_size: int,
) -> ArcMaskConstruction:
    """Construct an arc mask once while retaining its morphology trace."""
    snr = np.asarray(snr_map)
    excluded = (
        np.zeros_like(snr, dtype=bool)
        if modeling_mask is None
        else np.asarray(modeling_mask, dtype=bool)
    )
    if excluded.shape != snr.shape:
        raise ValueError("modeling_mask must match the S/N map shape")
    valid = ~excluded
    above_threshold = snr > threshold
    threshold_signal = above_threshold & valid
    labels = measure.label(threshold_signal)
    counts = np.bincount(labels.ravel())
    sizes = {
        int(label): int(size)
        for label, size in enumerate(counts)
        if label > 0
    }
    surviving_ids = tuple(
        label for label, size in sizes.items() if size >= ignor_size
    )
    filtered = np.isin(labels, surviving_ids)
    closing_dilation = _constrained_square_dilation(filtered, valid, close_size)
    closed_candidate = (
        erosion(
            closing_dilation,
            footprint=mirror_footprint(
                pad_footprint(
                    np.ones((close_size, close_size)), pad_end=False
                )
            ),
        )
        if close_size > 1
        else closing_dilation
    )
    closed_candidate = (closed_candidate | filtered) & valid
    closed = _retain_seed_connected_regions(closed_candidate, filtered, valid)
    arc_candidate = _constrained_square_dilation(closed, valid, ext_size)
    arc_region = _retain_seed_connected_regions(arc_candidate, filtered, valid)
    return ArcMaskConstruction(
        threshold_island_labels=np.asarray(labels, dtype=np.int32),
        threshold_island_sizes=sizes,
        surviving_threshold_island_ids=surviving_ids,
        filtered_signal=np.asarray(filtered, dtype=bool),
        closed_signal=np.asarray(closed, dtype=bool),
        arc_region=arc_region,
        feature_mask=~arc_region,
        excluded_above_threshold_pixel_count=int((above_threshold & excluded).sum()),
    )
