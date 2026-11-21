from __future__ import annotations

import math
from typing import Any


SOURCE_PIXEL_SCALE_ARCSEC = 0.010
SOURCE_GRID_SIZES_PIXELS = (100, 120, 140, 160, 180, 200)
MAX_SOURCE_GRID_LEVEL = len(SOURCE_GRID_SIZES_PIXELS) - 1
SOURCE_GRID_SPEC_SCHEMA_VERSION = "source_grid_spec.v1"
_LEGACY_SOURCE_PIXEL_SCALE_ARCSEC = 0.02
_LEGACY_SOURCE_GRID_SIZES_PIXELS = (80, 100, 120)


def next_source_grid_level(level: int) -> int | None:
    if type(level) is not int or not 0 <= level <= MAX_SOURCE_GRID_LEVEL:
        raise ValueError("source grid level is outside the fixed policy")
    return level + 1 if level < MAX_SOURCE_GRID_LEVEL else None


def source_grid_spec(*, center_x: float, center_y: float, level: int) -> dict[str, Any]:
    """Return the complete coordinate specification for one source-grid policy level."""
    return _grid_spec(center_x, center_y, level, SOURCE_PIXEL_SCALE_ARCSEC, SOURCE_GRID_SIZES_PIXELS)


def _grid_spec(
    center_x: float,
    center_y: float,
    level: int,
    pixel_scale: float,
    sizes: tuple[int, ...],
) -> dict[str, Any]:
    if type(level) is not int or not 0 <= level < len(sizes):
        raise ValueError("source grid level is outside the fixed policy")
    nsrc = sizes[level]
    half_width = 0.5 * nsrc * pixel_scale
    center_half_width = half_width - 0.5 * pixel_scale
    return {
        "schema_version": SOURCE_GRID_SPEC_SCHEMA_VERSION,
        "anchor_center": {"x": float(center_x), "y": float(center_y)},
        "grid_level": level,
        "half_width_arcsec": half_width,
        "pixel_scale_arcsec": pixel_scale,
        "nsrc": nsrc,
        "footprint_bbox": [
            float(center_x - half_width),
            float(center_x + half_width),
            float(center_y - half_width),
            float(center_y + half_width),
        ],
        "pixel_center_bbox": [
            float(center_x - center_half_width),
            float(center_x + center_half_width),
            float(center_y - center_half_width),
            float(center_y + center_half_width),
        ],
    }


def validate_source_grid_spec(
    raw: Any,
    *,
    source_shape: tuple[int, int] | None = None,
    expected_level: int | None = None,
    allow_legacy: bool = False,
) -> dict[str, Any]:
    """Validate source-grid provenance against the immutable release policy."""
    if not isinstance(raw, dict):
        raise TypeError("source grid specification must be a dictionary")
    required = {
        "schema_version",
        "anchor_center",
        "grid_level",
        "half_width_arcsec",
        "pixel_scale_arcsec",
        "nsrc",
        "footprint_bbox",
        "pixel_center_bbox",
    }
    if set(raw) != required:
        raise ValueError("source grid specification fields do not match its schema")
    center = raw.get("anchor_center")
    if not isinstance(center, dict) or set(center) != {"x", "y"}:
        raise ValueError("source grid anchor center is invalid")
    center_x = float(center["x"])
    center_y = float(center["y"])
    if not math.isfinite(center_x) or not math.isfinite(center_y):
        raise ValueError("source grid anchor center must be finite")
    level = raw.get("grid_level")
    if isinstance(level, bool) or not isinstance(level, int):
        raise ValueError("source grid level must be an integer")
    if expected_level is not None and level != expected_level:
        raise ValueError("source grid specification does not match its configuration")
    if allow_legacy and raw["pixel_scale_arcsec"] == _LEGACY_SOURCE_PIXEL_SCALE_ARCSEC:
        expected = _grid_spec(
            center_x, center_y, level,
            _LEGACY_SOURCE_PIXEL_SCALE_ARCSEC, _LEGACY_SOURCE_GRID_SIZES_PIXELS,
        )
    else:
        expected = source_grid_spec(center_x=center_x, center_y=center_y, level=level)
    for name in ("schema_version", "grid_level", "nsrc"):
        if raw[name] != expected[name]:
            raise ValueError(f"source grid specification has inconsistent {name}")
    for name in ("half_width_arcsec", "pixel_scale_arcsec"):
        if not math.isclose(float(raw[name]), expected[name], rel_tol=0.0, abs_tol=1.0e-12):
            raise ValueError(f"source grid specification has inconsistent {name}")
    for name in ("footprint_bbox", "pixel_center_bbox"):
        values = raw[name]
        if not isinstance(values, (list, tuple)) or len(values) != 4 or any(
            not math.isclose(float(value), target, rel_tol=0.0, abs_tol=1.0e-12)
            for value, target in zip(values, expected[name])
        ):
            raise ValueError(f"source grid specification has inconsistent {name}")
    if source_shape is not None and tuple(source_shape) != (expected["nsrc"], expected["nsrc"]):
        raise ValueError("source grid specification does not match source array shape")
    return expected
