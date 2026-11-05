from __future__ import annotations

import re
from typing import Any

import numpy as np

from .artifact_validation import finite_number, nonnegative_int, positive_int


SCHEMA_VERSION = "stage_b_arc_components.v2"
MASK_CONVENTION = (
    "feature_mask True excludes pixels; component labels identify pre-selection "
    "candidate arc islands"
)

_TOP_LEVEL_FIELDS = {
    "schema_version", "stage_attempt", "image_shape", "mask_convention", "connectivity",
    "parameters", "selection", "component_labels", "morphology_audit",
    "candidate_component_count", "all_components_have_arc_seed",
    "excluded_above_threshold_pixel_count", "components",
}
_COMPONENT_FIELDS = {
    "id", "status", "pixel_count", "bbox_rows", "bbox_cols",
    "centroid_pixel", "centroid_arcsec", "peak_snr", "mean_snr",
    "arc_seed_ids", "arc_seed_pixel_count", "has_arc_seed",
}


def validate_stage_b_arc_components(
    catalog: Any, *, component_labels: np.ndarray | None = None
) -> dict[str, Any]:
    """Validate the sealed component catalog and optionally its label image."""
    if not isinstance(catalog, dict) or set(catalog) != _TOP_LEVEL_FIELDS:
        raise ValueError("invalid Stage-B Arc Component Catalog fields")
    if catalog["schema_version"] != SCHEMA_VERSION:
        raise ValueError("invalid Stage-B Arc Component Catalog schema version")
    if not isinstance(catalog["stage_attempt"], str) or not re.fullmatch(
        r"attempts/b/[0-9]+", catalog["stage_attempt"]
    ):
        raise ValueError("invalid Stage-B Arc Component Catalog stage attempt")
    image_shape = catalog["image_shape"]
    if (
        not isinstance(image_shape, list)
        or len(image_shape) != 2
        or any(not positive_int(value) for value in image_shape)
    ):
        raise ValueError("invalid Stage-B Arc Component Catalog image shape")
    if catalog["mask_convention"] != MASK_CONVENTION or catalog["connectivity"] != 8:
        raise ValueError("invalid Stage-B Arc Component Catalog mask metadata")
    _validate_parameters(catalog["parameters"])
    labels_reference = _validate_artifact_reference(
        catalog["component_labels"], "stage_b_component_labels.fits"
    )
    audit_reference = _validate_artifact_reference(
        catalog["morphology_audit"], "stage_b_morphology_audit.json"
    )
    if labels_reference == audit_reference:
        raise ValueError("Stage-B component evidence references are not distinct")
    count = catalog["candidate_component_count"]
    if not nonnegative_int(count):
        raise ValueError("invalid Stage-B candidate component count")
    components = catalog["components"]
    if not isinstance(components, list) or len(components) != count:
        raise ValueError("inconsistent Stage-B candidate component count")
    ids = list(range(1, count + 1))
    selection = catalog["selection"]
    if not isinstance(selection, dict) or set(selection) != {
        "effective_keep_component_ids", "drop_component_ids"
    }:
        raise ValueError("invalid Stage-B component selection fields")
    kept = selection["effective_keep_component_ids"]
    dropped = selection["drop_component_ids"]
    if not _sorted_unique_positive_ints(kept) or not _sorted_unique_positive_ints(dropped):
        raise ValueError("invalid Stage-B component selection IDs")
    if sorted(kept + dropped) != ids or set(kept) & set(dropped):
        raise ValueError("Stage-B component selection does not partition the catalog")
    for expected_id, component in zip(ids, components):
        _validate_component(component, expected_id, set(kept))
    if catalog["all_components_have_arc_seed"] is not True or any(
        not component["has_arc_seed"] for component in components
    ):
        raise ValueError("Stage-B Arc Component is missing Arc Seed lineage")
    if not nonnegative_int(catalog["excluded_above_threshold_pixel_count"]):
        raise ValueError("invalid excluded above-threshold pixel count")
    if component_labels is not None:
        labels = np.asarray(component_labels)
        if list(labels.shape) != image_shape:
            raise ValueError("Stage-B component label image has the wrong shape")
        _validate_component_label_image(labels, components)
    return catalog


def _validate_parameters(parameters: Any) -> None:
    if not isinstance(parameters, dict) or set(parameters) != {
        "threshold", "ignor_size", "ext_size", "close_size"
    }:
        raise ValueError("invalid Stage-B Arc Component Catalog parameters")
    threshold = parameters["threshold"]
    if not finite_number(threshold) or threshold <= 0:
        raise ValueError("invalid Stage-B arc threshold")
    if any(not positive_int(parameters[name]) for name in ("ignor_size", "ext_size", "close_size")):
        raise ValueError("invalid Stage-B morphology parameter")


def _validate_artifact_reference(value: Any, expected: str) -> str:
    if not isinstance(value, dict) or set(value) != {"reference", "sha256"}:
        raise ValueError("invalid Stage-B component evidence reference")
    if value["reference"] != expected or not isinstance(value["sha256"], str) or not re.fullmatch(
        r"[0-9a-f]{64}", value["sha256"]
    ):
        raise ValueError("invalid Stage-B component evidence reference")
    return value["reference"]


def _validate_component(component: Any, expected_id: int, kept: set[int]) -> None:
    if not isinstance(component, dict) or set(component) != _COMPONENT_FIELDS:
        raise ValueError("invalid Stage-B Arc Component fields")
    if component["id"] != expected_id:
        raise ValueError("invalid Stage-B Arc Component IDs")
    expected_status = "kept" if expected_id in kept else "dropped"
    if component["status"] != expected_status:
        raise ValueError("inconsistent Stage-B Arc Component status")
    if not positive_int(component["pixel_count"]):
        raise ValueError("invalid Stage-B Arc Component pixel count")
    for name in ("bbox_rows", "bbox_cols"):
        pair = component[name]
        if not isinstance(pair, list) or len(pair) != 2 or any(not nonnegative_int(value) for value in pair) or pair[0] > pair[1]:
            raise ValueError(f"invalid Stage-B Arc Component {name}")
    for name in ("centroid_pixel", "centroid_arcsec"):
        pair = component[name]
        if not isinstance(pair, list) or len(pair) != 2 or any(not finite_number(value) for value in pair):
            raise ValueError(f"invalid Stage-B Arc Component {name}")
    if any(not finite_number(component[name]) for name in ("peak_snr", "mean_snr")):
        raise ValueError("invalid Stage-B Arc Component S/N summary")
    if not component["arc_seed_ids"] or not _sorted_unique_positive_ints(
        component["arc_seed_ids"]
    ):
        raise ValueError("invalid Stage-B Arc Seed lineage")
    if not positive_int(component["arc_seed_pixel_count"]) or component["has_arc_seed"] is not True:
        raise ValueError("invalid Stage-B Arc Seed lineage")


def _validate_component_label_image(labels: np.ndarray, components: list[dict[str, Any]]) -> None:
    if labels.ndim != 2 or labels.dtype.kind not in "iu" or np.any(labels < 0):
        raise ValueError("invalid Stage-B component label image")
    actual_ids = sorted(int(value) for value in np.unique(labels) if value > 0)
    expected_ids = [component["id"] for component in components]
    if actual_ids != expected_ids:
        raise ValueError("Stage-B component labels do not match the catalog IDs")
    for component in components:
        rows, cols = np.nonzero(labels == component["id"])
        if (
            rows.size != component["pixel_count"]
            or [int(rows.min()), int(rows.max())] != component["bbox_rows"]
            or [int(cols.min()), int(cols.max())] != component["bbox_cols"]
        ):
            raise ValueError("Stage-B component labels do not match catalog geometry")


def _sorted_unique_positive_ints(value: Any) -> bool:
    return isinstance(value, list) and value == sorted(set(value)) and all(
        positive_int(item) for item in value
    )
