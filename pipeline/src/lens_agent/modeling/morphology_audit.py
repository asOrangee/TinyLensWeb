from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np

from .arc_mask import ArcMaskConstruction
from .artifact_validation import finite_number, nonnegative_int, positive_int
from .predicted_image_family import validate_predicted_image_family


SCHEMA_VERSION = "stage_b_morphology_audit.v2"
LOCAL_RADIUS_ARCSEC = 0.3

_TOP_LEVEL_FIELDS = {
    "schema_version", "stage_attempt", "predicted_image_family", "parameters",
    "pixel_scale_arcsec", "local_radius_arcsec", "mask_convention",
    "valid_modeling_domain", "images",
}
_DOMAIN_FIELDS = {
    "mask_convention", "valid_pixel_count", "excluded_pixel_count",
    "excluded_above_threshold_pixel_count",
}
_IMAGE_FIELDS = {
    "image_id", "position_arcsec", "nearest_pixel", "nearest_pixel_covered",
    "nearest_arc_pixel_distance_arcsec", "local_peak_snr",
    "local_peak_position_arcsec", "local_above_threshold_pixel_count",
    "threshold_islands", "candidate_component_ids", "selected_component_ids",
    "local_selected_arc_pixel_count", "local_valid_pixel_count",
    "local_selected_arc_fraction",
}
_ISLAND_FIELDS = {
    "threshold_island_id", "total_pixel_count", "local_pixel_count", "peak_snr",
    "survives_ignor_size",
}


def validate_stage_b_morphology_audit(audit: Any) -> dict[str, Any]:
    """Validate the sealed Stage-B audit without silently accepting extensions."""
    if not isinstance(audit, dict) or set(audit) != _TOP_LEVEL_FIELDS:
        raise ValueError("invalid Stage-B Morphology Audit fields")
    if audit["schema_version"] != SCHEMA_VERSION:
        raise ValueError("invalid Stage-B Morphology Audit schema version")
    if not isinstance(audit["stage_attempt"], str) or not re.fullmatch(
        r"attempts/b/[0-9]+", audit["stage_attempt"]
    ):
        raise ValueError("invalid Stage-B Morphology Audit stage attempt")
    family = audit["predicted_image_family"]
    if not isinstance(family, dict) or set(family) != {"reference", "sha256"}:
        raise ValueError("invalid predicted image family reference fields")
    if not isinstance(family["reference"], str) or not re.fullmatch(
        r"attempts/a/[0-9]+/artifacts/stage_a_predicted_image_family\.json",
        family["reference"],
    ) or not isinstance(family["sha256"], str) or not re.fullmatch(
        r"[0-9a-f]{64}", family["sha256"]
    ):
        raise ValueError("invalid predicted image family reference")
    parameters = audit["parameters"]
    if not isinstance(parameters, dict) or set(parameters) != {
        "threshold", "ignor_size", "ext_size", "close_size"
    }:
        raise ValueError("invalid Stage-B Morphology Audit parameter fields")
    if any(
        isinstance(parameters[name], bool) or not isinstance(parameters[name], int)
        or parameters[name] < 0
        for name in ("ignor_size", "ext_size", "close_size")
    ):
        raise ValueError("invalid Stage-B Morphology Audit integer parameter")
    if not finite_number(parameters["threshold"]):
        raise ValueError("invalid Stage-B Morphology Audit threshold")
    if (
        not finite_number(audit["pixel_scale_arcsec"])
        or audit["pixel_scale_arcsec"] <= 0
        or not finite_number(audit["local_radius_arcsec"])
        or audit["local_radius_arcsec"] != LOCAL_RADIUS_ARCSEC
        or audit["mask_convention"] != "selected_arc_region True includes pixels"
    ):
        raise ValueError("invalid Stage-B Morphology Audit coordinate metadata")
    domain = audit["valid_modeling_domain"]
    if (
        not isinstance(domain, dict)
        or set(domain) != _DOMAIN_FIELDS
        or domain["mask_convention"] != "modeling_mask True excludes pixels"
        or any(
            not nonnegative_int(domain[name])
            for name in (
                "valid_pixel_count", "excluded_pixel_count",
                "excluded_above_threshold_pixel_count",
            )
        )
        or domain["excluded_above_threshold_pixel_count"]
        > domain["excluded_pixel_count"]
    ):
        raise ValueError("invalid Stage-B Morphology Audit modeling domain")
    images = audit["images"]
    if not isinstance(images, list) or len(images) < 2:
        raise ValueError("invalid Stage-B Morphology Audit images")
    ids = []
    for image in images:
        _validate_image_audit(image)
        ids.append(image["image_id"])
    if ids != [f"image_{index}" for index in range(1, len(ids) + 1)]:
        raise ValueError("invalid Stage-B Morphology Audit image IDs")
    return audit


def _validate_image_audit(image: Any) -> None:
    if not isinstance(image, dict) or set(image) != _IMAGE_FIELDS:
        raise ValueError("invalid Stage-B Morphology Audit image fields")
    if not isinstance(image["image_id"], str):
        raise ValueError("invalid Stage-B Morphology Audit image ID")
    for name in ("position_arcsec", "local_peak_position_arcsec"):
        if not _pair(image[name], finite_number):
            raise ValueError(f"invalid Stage-B Morphology Audit {name}")
    if not _pair(image["nearest_pixel"], nonnegative_int):
        raise ValueError("invalid Stage-B Morphology Audit nearest pixel")
    if not isinstance(image["nearest_pixel_covered"], bool):
        raise ValueError("invalid Stage-B Morphology Audit coverage flag")
    distance = image["nearest_arc_pixel_distance_arcsec"]
    if distance is not None and (not finite_number(distance) or distance < 0):
        raise ValueError("invalid Stage-B Morphology Audit arc distance")
    if not finite_number(image["local_peak_snr"]):
        raise ValueError("invalid Stage-B Morphology Audit peak S/N")
    for name in (
        "local_above_threshold_pixel_count", "local_selected_arc_pixel_count",
        "local_valid_pixel_count",
    ):
        if not nonnegative_int(image[name]):
            raise ValueError(f"invalid Stage-B Morphology Audit {name}")
    fraction = image["local_selected_arc_fraction"]
    if not finite_number(fraction) or not 0 <= fraction <= 1:
        raise ValueError("invalid Stage-B Morphology Audit selected fraction")
    selected_count = image["local_selected_arc_pixel_count"]
    valid_count = image["local_valid_pixel_count"]
    above_threshold_count = image["local_above_threshold_pixel_count"]
    if (
        valid_count <= 0
        or selected_count > valid_count
        or above_threshold_count > valid_count
        or not math.isclose(
            fraction, selected_count / valid_count, rel_tol=0.0, abs_tol=1.0e-12
        )
    ):
        raise ValueError("inconsistent Stage-B Morphology Audit local pixel counts")
    for name in ("candidate_component_ids", "selected_component_ids"):
        values = image[name]
        if not isinstance(values, list) or values != sorted(set(values)) or any(
            not positive_int(value) for value in values
        ):
            raise ValueError(f"invalid Stage-B Morphology Audit {name}")
    if not set(image["selected_component_ids"]) <= set(image["candidate_component_ids"]):
        raise ValueError("selected Stage-B components are absent from the local candidates")
    islands = image["threshold_islands"]
    if not isinstance(islands, list):
        raise ValueError("invalid Stage-B Morphology Audit threshold islands")
    island_ids = []
    for island in islands:
        if not isinstance(island, dict) or set(island) != _ISLAND_FIELDS:
            raise ValueError("invalid Stage-B Morphology Audit threshold-island fields")
        island_ids.append(island["threshold_island_id"])
        if any(
            not positive_int(island[name])
            for name in ("threshold_island_id", "total_pixel_count", "local_pixel_count")
        ) or not finite_number(island["peak_snr"]) or not isinstance(
            island["survives_ignor_size"], bool
        ):
            raise ValueError("invalid Stage-B Morphology Audit threshold island")
    if island_ids != sorted(set(island_ids)):
        raise ValueError("invalid Stage-B Morphology Audit threshold-island IDs")
    if any(
        island["local_pixel_count"] > island["total_pixel_count"]
        for island in islands
    ) or sum(island["local_pixel_count"] for island in islands) != above_threshold_count:
        raise ValueError("inconsistent Stage-B Morphology Audit threshold-island counts")


def _pair(value: Any, predicate) -> bool:
    return isinstance(value, list) and len(value) == 2 and all(predicate(item) for item in value)


def build_stage_b_morphology_audit(
    family: dict[str, Any],
    *,
    construction: ArcMaskConstruction,
    snr: np.ndarray,
    modeling_mask: np.ndarray,
    candidate_component_labels: np.ndarray,
    selected_arc_region: np.ndarray,
    stage_attempt: str,
    family_reference: str,
    family_sha256: str,
    threshold: float,
    ignor_size: int,
    ext_size: int,
    close_size: int,
) -> dict[str, Any]:
    """Compare every Stage-A predicted image with one Stage-B mask attempt."""
    family = validate_predicted_image_family(family)
    snr = np.asarray(snr, dtype=float)
    modeling_mask = np.asarray(modeling_mask, dtype=bool)
    candidate_labels = np.asarray(candidate_component_labels, dtype=int)
    selected = np.asarray(selected_arc_region, dtype=bool)
    if not (
        snr.shape
        == modeling_mask.shape
        == candidate_labels.shape
        == selected.shape
        == construction.feature_mask.shape
    ):
        raise ValueError("Stage-B Morphology Audit arrays must share one image shape")
    coordinate = family["coordinate_system"]
    if coordinate["image_shape"] != list(snr.shape):
        raise ValueError("predicted image family does not match the Stage-B image shape")
    dpix = float(coordinate["pixel_scale_arcsec"])
    y_axis = (np.arange(snr.shape[0]) - (snr.shape[0] - 1) / 2) * dpix
    x_axis = (np.arange(snr.shape[1]) - (snr.shape[1] - 1) / 2) * dpix
    valid = ~modeling_mask
    selected_rows, selected_cols = np.nonzero(selected)
    images = [
        _image_audit(
            item,
            snr=snr,
            valid=valid,
            x_axis=x_axis,
            y_axis=y_axis,
            candidate_labels=candidate_labels,
            selected=selected,
            selected_rows=selected_rows,
            selected_cols=selected_cols,
            construction=construction,
            dpix=dpix,
        )
        for item in family["images"]
    ]
    audit = {
        "schema_version": SCHEMA_VERSION,
        "stage_attempt": stage_attempt,
        "predicted_image_family": {
            "reference": family_reference,
            "sha256": family_sha256,
        },
        "parameters": {
            "threshold": threshold,
            "ignor_size": ignor_size,
            "ext_size": ext_size,
            "close_size": close_size,
        },
        "pixel_scale_arcsec": dpix,
        "local_radius_arcsec": LOCAL_RADIUS_ARCSEC,
        "mask_convention": "selected_arc_region True includes pixels",
        "valid_modeling_domain": {
            "mask_convention": "modeling_mask True excludes pixels",
            "valid_pixel_count": int(valid.sum()),
            "excluded_pixel_count": int(modeling_mask.sum()),
            "excluded_above_threshold_pixel_count": (
                construction.excluded_above_threshold_pixel_count
            ),
        },
        "images": images,
    }
    return validate_stage_b_morphology_audit(audit)


def plot_stage_b_morphology_audit(
    audit: dict[str, Any],
    *,
    snr: np.ndarray,
    threshold_island_labels: np.ndarray,
    selected_arc_region: np.ndarray,
    modeling_mask: np.ndarray,
    target: Path,
) -> None:
    """Render one global topology view and one cutout for every predicted image."""
    images = audit["images"]
    panel_count = 1 + len(images)
    ncols = min(3, panel_count)
    nrows = int(math.ceil(panel_count / ncols))
    figure, axes = plt.subplots(nrows, ncols, figsize=(5.0 * ncols, 4.5 * nrows))
    flat = np.atleast_1d(axes).ravel()
    snr = np.asarray(snr, dtype=float)
    selected = np.asarray(selected_arc_region, dtype=bool)
    modeling_mask_array = np.asarray(modeling_mask, dtype=bool)
    threshold_pixels = np.asarray(threshold_island_labels) > 0
    dpix = float(audit["pixel_scale_arcsec"])
    ny, nx = snr.shape
    extent = (-nx * dpix / 2, nx * dpix / 2, -ny * dpix / 2, ny * dpix / 2)
    shown = np.ma.array(snr, mask=modeling_mask_array)

    global_axis = flat[0]
    global_axis.imshow(shown, origin="lower", extent=extent, cmap="inferno", vmin=-3, vmax=5)
    plot_valid_modeling_domain_boundary(
        global_axis, modeling_mask_array, extent, annotate=True
    )
    if selected.any():
        global_axis.contour(
            selected.astype(float), levels=[0.5], origin="lower", extent=extent,
            colors="cyan", linewidths=1.2,
        )
    for item in images:
        x, y = item["position_arcsec"]
        color = "lime" if item["nearest_pixel_covered"] else "red"
        global_axis.scatter([x], [y], marker="x", s=70, linewidths=2, color=color)
        global_axis.text(x, y, item["image_id"], color=color, fontsize=8, clip_on=True)
    global_axis.set_title("Stage-A predicted image family + selected Stage-B mask")
    global_axis.set_aspect("equal", adjustable="box")
    global_axis.set_xlim(-4.0, 4.0)
    global_axis.set_ylim(-4.0, 4.0)
    global_axis.set_xlabel("x (arcsec)")
    global_axis.set_ylabel("y (arcsec)")

    radius = float(audit["local_radius_arcsec"])
    for axis, item in zip(flat[1:], images):
        x, y = item["position_arcsec"]
        axis.imshow(shown, origin="lower", extent=extent, cmap="inferno", vmin=-3, vmax=5)
        plot_valid_modeling_domain_boundary(axis, modeling_mask_array, extent)
        if threshold_pixels.any():
            axis.contour(
                threshold_pixels.astype(float), levels=[0.5], origin="lower", extent=extent,
                colors="orange", linewidths=1.0,
            )
        if selected.any():
            axis.contour(
                selected.astype(float), levels=[0.5], origin="lower", extent=extent,
                colors="cyan", linewidths=1.2,
            )
        color = "lime" if item["nearest_pixel_covered"] else "red"
        axis.scatter([x], [y], marker="x", s=80, linewidths=2, color=color)
        axis.set_xlim(x - radius, x + radius)
        axis.set_ylim(y - radius, y + radius)
        axis.set_aspect("equal", adjustable="box")
        axis.set_title(
            f"{item['image_id']}: covered={item['nearest_pixel_covered']}, "
            f"peak S/N={item['local_peak_snr']:.2f}"
        )
    for axis in flat[panel_count:]:
        axis.axis("off")
    figure.tight_layout()
    figure.savefig(target, dpi=120, bbox_inches="tight")
    plt.close(figure)


def plot_valid_modeling_domain_boundary(
    axis: Any,
    modeling_mask: np.ndarray,
    extent: tuple[float, float, float, float],
    *,
    annotate: bool = False,
) -> None:
    """Plot a black boundary with white dashes on any diagnostic background."""
    excluded = np.asarray(modeling_mask, dtype=bool)
    if not excluded.any():
        return
    for color, style in (("black", "-"), ("white", "--")):
        axis.contour(
            (~excluded).astype(float), levels=[0.5], origin="lower", extent=extent,
            colors=color, linewidths=1.0, linestyles=style,
        )
    if annotate:
        axis.text(
            0.0, -0.18, "black/white dashed: valid modeling domain boundary",
            transform=axis.transAxes, ha="left", va="top", fontsize=8,
        )


def _image_audit(
    item: dict[str, Any],
    *,
    snr: np.ndarray,
    valid: np.ndarray,
    x_axis: np.ndarray,
    y_axis: np.ndarray,
    candidate_labels: np.ndarray,
    selected: np.ndarray,
    selected_rows: np.ndarray,
    selected_cols: np.ndarray,
    construction: ArcMaskConstruction,
    dpix: float,
) -> dict[str, Any]:
    x, y = (float(value) for value in item["position_arcsec"])
    row = _nearest_pixel_index(y / dpix + (snr.shape[0] - 1) / 2)
    col = _nearest_pixel_index(x / dpix + (snr.shape[1] - 1) / 2)
    distance = np.hypot(y_axis[:, None] - y, x_axis[None, :] - x)
    local = (distance <= LOCAL_RADIUS_ARCSEC) & valid
    local_rows, local_cols = np.nonzero(local)
    if not local_rows.size:
        raise ValueError("predicted image has no valid local audit pixels")
    local_values = snr[local_rows, local_cols]
    peak_offset = int(np.argmax(local_values))
    peak_row = int(local_rows[peak_offset])
    peak_col = int(local_cols[peak_offset])
    threshold_ids = sorted(
        int(value)
        for value in np.unique(construction.threshold_island_labels[local])
        if value > 0
    )
    surviving = set(construction.surviving_threshold_island_ids)
    threshold_islands = []
    for island_id in threshold_ids:
        island = construction.threshold_island_labels == island_id
        threshold_islands.append(
            {
                "threshold_island_id": island_id,
                "total_pixel_count": construction.threshold_island_sizes[island_id],
                "local_pixel_count": int((island & local).sum()),
                "peak_snr": float(np.max(snr[island])),
                "survives_ignor_size": island_id in surviving,
            }
        )
    candidate_ids = _positive_ids(candidate_labels[local])
    selected_ids = _positive_ids(candidate_labels[local & selected])
    selected_count = int((local & selected).sum())
    denominator = int(local.sum())
    nearest_distance = None
    if selected_rows.size:
        nearest_distance = float(
            np.min(
                np.hypot(
                    y_axis[selected_rows] - y,
                    x_axis[selected_cols] - x,
                )
            )
        )
    return {
        "image_id": item["image_id"],
        "position_arcsec": [x, y],
        "nearest_pixel": [row, col],
        "nearest_pixel_covered": bool(selected[row, col]),
        "nearest_arc_pixel_distance_arcsec": nearest_distance,
        "local_peak_snr": float(snr[peak_row, peak_col]),
        "local_peak_position_arcsec": [float(x_axis[peak_col]), float(y_axis[peak_row])],
        "local_above_threshold_pixel_count": int(
            (local & (construction.threshold_island_labels > 0)).sum()
        ),
        "threshold_islands": threshold_islands,
        "candidate_component_ids": candidate_ids,
        "selected_component_ids": selected_ids,
        "local_selected_arc_pixel_count": selected_count,
        "local_valid_pixel_count": denominator,
        "local_selected_arc_fraction": selected_count / denominator,
    }


def _nearest_pixel_index(value: float) -> int:
    """Round to nearest integer and choose the smaller index on an exact tie."""
    return int(math.ceil(value - 0.5))


def _positive_ids(values: np.ndarray) -> list[int]:
    return sorted(int(value) for value in np.unique(values) if value > 0)
