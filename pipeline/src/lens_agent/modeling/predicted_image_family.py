from __future__ import annotations

import math
import re
from typing import Any, Sequence

from .artifact_validation import finite_number


SCHEMA_VERSION = "stage_a_predicted_image_family.v1"
MEDIAN_NAMES = (
    "theta_E",
    "e1_mass",
    "e2_mass",
    "center_x_mass",
    "center_y_mass",
    "gamma1",
    "gamma2",
    "center_x_src",
    "center_y_src",
)
SOLVER_CONFIG_FIELDS = {
    "initial_range", "n_x", "n_y", "k_keep", "num_iters", "tolerance",
    "cluster_tol",
}


def build_predicted_image_family(
    positions: Sequence[Sequence[float]],
    *,
    medians: dict[str, float],
    image_shape: tuple[int, int],
    pixel_scale_arcsec: float,
    stage_attempt: str,
    solver: str,
    solver_config: dict[str, Any],
    threshold_arcsec: float,
    min_log_like: float,
) -> dict[str, Any]:
    """Build the immutable Stage-A prediction shared by all downstream stages."""
    ny, nx = image_shape
    if ny <= 0 or nx <= 0 or not math.isfinite(pixel_scale_arcsec) or pixel_scale_arcsec <= 0:
        raise ValueError("predicted image family has invalid image geometry")
    if not isinstance(stage_attempt, str) or not re.fullmatch(
        r"attempts/a/[0-9]+", stage_attempt
    ):
        raise ValueError("predicted image family has an invalid Stage-A attempt")
    if not isinstance(solver, str) or solver != "optimization":
        raise ValueError("predicted image family has an unsupported solver")
    solver_config = _validated_solver_config(solver_config)
    normalized = [_position_pair(position) for position in positions]
    if len(normalized) < 2:
        raise ValueError("predicted image family requires at least two positions")
    normalized.sort(key=lambda position: (position[0], position[1]))
    cluster_tol = float(solver_config["cluster_tol"])
    for index, first in enumerate(normalized):
        if not _inside_image(first, image_shape, pixel_scale_arcsec):
            raise ValueError("predicted image position lies outside the image")
        for second in normalized[index + 1 :]:
            if math.dist(first, second) < cluster_tol:
                raise ValueError("predicted image positions are closer than solver cluster_tol")
    provenance_medians = {name: _finite_float(medians[name], name) for name in MEDIAN_NAMES}
    return {
        "schema_version": SCHEMA_VERSION,
        "stage_attempt": str(stage_attempt),
        "coordinate_system": {
            "name": "centered_image_plane_arcsec",
            "image_shape": [int(ny), int(nx)],
            "pixel_scale_arcsec": float(pixel_scale_arcsec),
            "x_axis": "column",
            "y_axis": "row",
            "origin_pixel": [(ny - 1) / 2, (nx - 1) / 2],
        },
        "image_count": len(normalized),
        "position_likelihood": {
            "threshold_arcsec": _finite_float(threshold_arcsec, "threshold_arcsec"),
            "min_log_like": _finite_float(min_log_like, "min_log_like"),
        },
        "provenance": {
            "medians": provenance_medians,
            "solver": solver,
            "solver_config": solver_config,
        },
        "images": [
            {"image_id": f"image_{index}", "position_arcsec": list(position)}
            for index, position in enumerate(normalized, start=1)
        ],
    }


def position_likelihood_from_family(family: dict[str, Any]) -> dict[str, Any]:
    """Return the sole downstream position-likelihood representation."""
    validated = validate_predicted_image_family(family)
    likelihood = validated["position_likelihood"]
    return {
        "positions": [item["position_arcsec"] for item in validated["images"]],
        "threshold_arcsec": likelihood["threshold_arcsec"],
        "min_log_like": likelihood["min_log_like"],
    }


def validate_predicted_image_family(family: dict[str, Any]) -> dict[str, Any]:
    """Strictly validate a persisted family and return it unchanged."""
    if not isinstance(family, dict) or set(family) != {
        "schema_version",
        "stage_attempt",
        "coordinate_system",
        "image_count",
        "position_likelihood",
        "provenance",
        "images",
    } or family.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("invalid Stage-A Predicted Image Family")
    coordinate = family.get("coordinate_system")
    provenance = family.get("provenance")
    likelihood = family.get("position_likelihood")
    if not isinstance(coordinate, dict) or set(coordinate) != {
        "name", "image_shape", "pixel_scale_arcsec", "x_axis", "y_axis", "origin_pixel"
    }:
        raise ValueError("invalid predicted image coordinate system")
    if not isinstance(provenance, dict) or set(provenance) != {
        "medians", "solver", "solver_config"
    }:
        raise ValueError("invalid predicted image provenance")
    if not isinstance(likelihood, dict) or set(likelihood) != {
        "threshold_arcsec", "min_log_like"
    }:
        raise ValueError("invalid predicted image position likelihood")
    images = family.get("images")
    shape = coordinate.get("image_shape")
    if (
        coordinate.get("name") != "centered_image_plane_arcsec"
        or coordinate.get("x_axis") != "column"
        or coordinate.get("y_axis") != "row"
        or not isinstance(shape, list)
        or len(shape) != 2
        or any(isinstance(value, bool) or not isinstance(value, int) for value in shape)
        or not isinstance(images, list)
        or family.get("image_count") != len(images)
    ):
        raise ValueError("invalid predicted image family geometry")
    rebuilt = build_predicted_image_family(
        [item.get("position_arcsec", []) for item in images if isinstance(item, dict)],
        medians=provenance.get("medians", {}),
        image_shape=(shape[0], shape[1]),
        pixel_scale_arcsec=coordinate.get("pixel_scale_arcsec"),
        stage_attempt=family.get("stage_attempt"),
        solver=provenance.get("solver"),
        solver_config=provenance.get("solver_config", {}),
        threshold_arcsec=likelihood.get("threshold_arcsec"),
        min_log_like=likelihood.get("min_log_like"),
    )
    if rebuilt != family:
        raise ValueError("Stage-A Predicted Image Family is not canonical")
    return family


def _position_pair(position: Sequence[float]) -> tuple[float, float]:
    if len(position) != 2:
        raise ValueError("predicted image position must contain x and y")
    return (_finite_float(position[0], "position x"), _finite_float(position[1], "position y"))


def _finite_float(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field} must be a finite number")
    return result


def _validated_solver_config(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict) or set(config) != SOLVER_CONFIG_FIELDS:
        raise ValueError("predicted image family has invalid solver configuration fields")
    result = dict(config)
    for name in ("n_x", "n_y", "k_keep", "num_iters"):
        if isinstance(result[name], bool) or not isinstance(result[name], int) or result[name] <= 0:
            raise ValueError(f"predicted image family solver {name} must be a positive integer")
    for name in ("initial_range", "tolerance", "cluster_tol"):
        if not finite_number(result[name]) or result[name] <= 0:
            raise ValueError(f"predicted image family solver {name} must be positive")
    return result


def _inside_image(
    position: tuple[float, float], image_shape: tuple[int, int], pixel_scale_arcsec: float,
) -> bool:
    ny, nx = image_shape
    x_limit = nx * pixel_scale_arcsec / 2
    y_limit = ny * pixel_scale_arcsec / 2
    return -x_limit < position[0] <= x_limit and -y_limit < position[1] <= y_limit
