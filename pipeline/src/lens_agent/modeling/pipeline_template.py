from __future__ import annotations

import json
import hashlib
import pickle
import time
from pathlib import Path
from typing import Any

import jax.numpy as jnp
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib.lines import Line2D
from matplotlib.legend_handler import HandlerTuple
import numpy as np
from astropy.io import fits
from nautilus import Sampler
from scipy import ndimage

from TinyLensGpu.Inference import ParamU, StagePosterior
from TinyLensGpu.Inference.build_likelihood import make_likelihood
from TinyLensGpu.Inference.build_prior import make_prior_transformation
from TinyLensGpu.ObservationModel.LensImage.parametric_image_model import ImageProbModel
from TinyLensGpu.ObservationModel import PointSourceProbModel
from TinyLensGpu.ObservationModel.LensImage.pixelized_image_model_operator import (
    PixelizedImageProbModelOperator,
)
from TinyLensGpu.PhysicalModel import PhysicalModel, PixelizedSourceModel, Shear
from TinyLensGpu.PhysicalModel.LensImage.Parametric.Light import GaussianEllipse
from TinyLensGpu.PhysicalModel.LensImage.Parametric.Mass import EPL, SIE
from TinyLensGpu.utils import generate_radial_basis_knots
from TinyLensGpu.visualizer import overlay_critical_and_caustics, plot_model_results
import caskade as ck

from ..configuration import PipelineConfig, PriorConfig
from .arc_mask import construct_arc_mask
from .arc_components import (
    MASK_CONVENTION as ARC_MASK_COMPONENT_CONVENTION,
    SCHEMA_VERSION as ARC_MASK_COMPONENT_SCHEMA_VERSION,
    validate_stage_b_arc_components,
)
from .morphology_audit import (
    build_stage_b_morphology_audit,
    plot_valid_modeling_domain_boundary,
    plot_stage_b_morphology_audit,
)
from .predicted_image_family import build_predicted_image_family
from .source_grid import source_grid_spec, validate_source_grid_spec


OUT_DIR = Path("output")
DIAGNOSTICS_DIR = OUT_DIR
_UPSTREAM_DIRS: dict[str, Path] = {}
_ARC_DROP_COMPONENT_IDS: tuple[int, ...] = ()
_STAGE_ATTEMPT_REFERENCE = "attempts/a/0"
NSUB = 4
MASK_RADIUS = 4.0
NSUB_PIX = 4
REGULARIZATION_TYPE = "first-order"
SOLVER_TYPE = "pcg"
PLOT_CMAP_IMAGE = "inferno"
PLOT_CMAP_RESIDUAL = "RdBu_r"
PARAMETRIC_SOURCE_NPIX = 200
PARAMETRIC_SOURCE_DPIX = 0.01
PARAMETRIC_SOURCE_DISPLAY_RANGE = (-1.0, 1.0)
RESIDUAL_SIGNIFICANCE_REFERENCE_SIGMA = 3.0
MODELED_SUPPORT_REFERENCE_FRACTION = 0.01
POSITION_SOLVER = "optimization"
POSITION_SOLVER_CONFIG = {
    "initial_range": 4.0,
    "n_x": 400,
    "n_y": 400,
    "k_keep": 30,
    "num_iters": 20,
    "tolerance": 5.0e-4,
    "cluster_tol": 0.08,
}
POSITION_THRESHOLD_ARCSEC = 0.1
POSITION_MIN_LOG_LIKE = -1.0e10


_CONFIG = PipelineConfig()
DPIX = _CONFIG.pixel_scale_arcsec


def configure_runtime(
    *,
    config: PipelineConfig,
    artifact_dir: Path,
    diagnostics_dir: Path,
    upstream_dirs: dict[str, Path],
    dropped_component_ids: tuple[int, ...] = (),
    stage_attempt_reference: str = "attempts/a/0",
) -> None:
    """Bind one validated attempt to this fixed packaged implementation."""
    global _CONFIG, OUT_DIR, DIAGNOSTICS_DIR, _UPSTREAM_DIRS, _ARC_DROP_COMPONENT_IDS
    global _STAGE_ATTEMPT_REFERENCE, DPIX
    _CONFIG = config
    DPIX = config.pixel_scale_arcsec
    OUT_DIR = Path(artifact_dir)
    DIAGNOSTICS_DIR = Path(diagnostics_dir)
    _UPSTREAM_DIRS = {str(stage): Path(path) for stage, path in upstream_dirs.items()}
    _ARC_DROP_COMPONENT_IDS = _component_id_tuple(
        dropped_component_ids, field="dropped_component_ids"
    )
    _STAGE_ATTEMPT_REFERENCE = str(stage_attempt_reference)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "input_geometry.json").write_text(
        json.dumps(_input_geometry_metadata(), indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def _input_geometry_metadata() -> dict[str, Any]:
    """Identify the observed-image geometry; source-plane grids stay independent."""
    return {
        "schema_version": "image_geometry.v1",
        "pixel_scale_arcsec": float(DPIX),
        "input_x_direction": _CONFIG.input_x_direction,
        "input_y_direction": _CONFIG.input_y_direction,
        "array_frame": "canonical",
        "x_direction": "increasing",
        "y_direction": "increasing",
        "origin": "geometric_image_center",
        "pixel_center_coordinates": {
            "x": "(column - (nx - 1) / 2) * pixel_scale_arcsec",
            "y": "(row - (ny - 1) / 2) * pixel_scale_arcsec",
        },
        "input_transform": "axis_reflections_only_no_resampling",
    }


def _image_geometry_header(shape: tuple[int, int]) -> fits.Header:
    """Describe a generated mask in the same local linear frame as the model."""
    ny, nx = shape
    return fits.Header({
        "CTYPE1": "LINEAR", "CTYPE2": "LINEAR",
        "CUNIT1": "arcsec", "CUNIT2": "arcsec",
        "CDELT1": float(DPIX), "CDELT2": float(DPIX),
        "CRPIX1": (nx + 1) / 2.0, "CRPIX2": (ny + 1) / 2.0,
        "CRVAL1": 0.0, "CRVAL2": 0.0,
        "GEOMFRM": "canonical",
        "INPXDIR": _CONFIG.input_x_direction,
        "INPYDIR": _CONFIG.input_y_direction,
    })


def stage_output_dir(tag: str) -> Path:
    return _UPSTREAM_DIRS.get(tag, OUT_DIR)


def get_config() -> PipelineConfig:
    return _CONFIG


def _arc_component_labels(arc_region: np.ndarray) -> tuple[np.ndarray, int]:
    """Label final-candidate arc islands with the Stage-B 8-connected convention."""
    return ndimage.label(
        np.asarray(arc_region, dtype=bool), structure=np.ones((3, 3), dtype=int)
    )


def _component_id_tuple(values: Any, *, field: str) -> tuple[int, ...]:
    """Validate a lens-local arc-component selection without coercing IDs."""
    if values is None:
        return ()
    try:
        result = tuple(values)
    except TypeError as error:
        raise ValueError(f"{field} must be a tuple of positive component IDs") from error
    if any(isinstance(value, bool) or not isinstance(value, (int, np.integer)) for value in result):
        raise ValueError(f"{field} must contain integer component IDs")
    result = tuple(int(value) for value in result)
    if any(value <= 0 for value in result) or len(set(result)) != len(result):
        raise ValueError(f"{field} must contain unique positive component IDs")
    return result


def _apply_arc_component_selection(
    candidate_arc_region: np.ndarray, component_labels: np.ndarray, component_count: int,
) -> tuple[np.ndarray, tuple[int, ...], tuple[int, ...]]:
    """Return the selected arc region and its explicit kept/dropped label partition.

    Component labels are deliberately created before applying the selection.  This
    lets an expert refer to IDs in a candidate diagnostic and rerun only the
    deterministic selection, without relabeling the surviving islands.
    """
    available = set(range(1, int(component_count) + 1))
    drop = _ARC_DROP_COMPONENT_IDS
    drop_set = set(drop)
    unknown = drop_set - available
    if unknown:
        raise ValueError(f"arc component selection references absent IDs: {sorted(unknown)}")
    keep_set = available - drop_set

    selected = np.asarray(candidate_arc_region, dtype=bool).copy()
    if drop_set:
        selected[np.isin(component_labels, list(drop_set))] = False
    return selected, tuple(sorted(keep_set)), tuple(sorted(drop_set))


def _arc_component_catalog(
    component_labels: np.ndarray,
    component_count: int,
    snr: np.ndarray,
    threshold_island_labels: np.ndarray,
    arc_seed_pixels: np.ndarray,
    *,
    kept_ids: tuple[int, ...],
    dropped_ids: tuple[int, ...],
) -> list[dict[str, Any]]:
    """Build JSON-safe, display-oriented metadata for one candidate's islands."""
    kept = set(kept_ids)
    dropped = set(dropped_ids)
    ny, nx = component_labels.shape
    catalog: list[dict[str, Any]] = []
    for component_id in range(1, int(component_count) + 1):
        rows, cols = np.nonzero(component_labels == component_id)
        values = np.asarray(snr)[rows, cols]
        component_seed_pixels = np.asarray(arc_seed_pixels)[rows, cols]
        seed_values = np.asarray(threshold_island_labels)[rows, cols][
            component_seed_pixels
        ]
        seed_ids = sorted(
            int(value) for value in np.unique(seed_values) if int(value) > 0
        )
        seed_pixel_count = int(component_seed_pixels.sum())
        row_centroid = float(rows.mean())
        col_centroid = float(cols.mean())
        catalog.append({
            "id": component_id,
            "status": "kept" if component_id in kept else "dropped",
            "pixel_count": int(rows.size),
            "bbox_rows": [int(rows.min()), int(rows.max())],
            "bbox_cols": [int(cols.min()), int(cols.max())],
            "centroid_pixel": [row_centroid, col_centroid],
            "centroid_arcsec": [
                float((col_centroid - (nx - 1) / 2) * DPIX),
                float((row_centroid - (ny - 1) / 2) * DPIX),
            ],
            "peak_snr": float(np.nanmax(values)),
            "mean_snr": float(np.nanmean(values)),
            "arc_seed_ids": seed_ids,
            "arc_seed_pixel_count": seed_pixel_count,
            "has_arc_seed": bool(seed_ids and seed_pixel_count > 0),
        })
    if kept | dropped != set(range(1, int(component_count) + 1)):
        raise RuntimeError("arc component catalog does not cover every candidate label")
    if any(not item["has_arc_seed"] for item in catalog):
        raise RuntimeError("every Arc Component must descend from an Arc Seed")
    return catalog


def _write_arc_component_metadata(
    catalog: list[dict[str, Any]],
    *,
    image_shape: tuple[int, int],
    kept_ids: tuple[int, ...],
    dropped_ids: tuple[int, ...],
    excluded_above_threshold_pixel_count: int,
    component_labels_sha256: str,
    morphology_audit_sha256: str,
) -> None:
    """Persist the machine-readable Stage-B component contract."""
    metadata = {
        "schema_version": ARC_MASK_COMPONENT_SCHEMA_VERSION,
        "stage_attempt": _STAGE_ATTEMPT_REFERENCE,
        "image_shape": list(image_shape),
        "mask_convention": ARC_MASK_COMPONENT_CONVENTION,
        "connectivity": 8,
        "parameters": {
            "threshold": float(_CONFIG.arc_snr_threshold),
            "ignor_size": int(_CONFIG.arc_ignor_size),
            "ext_size": int(_CONFIG.arc_ext_size),
            "close_size": int(_CONFIG.arc_close_size),
        },
        "selection": {
            "effective_keep_component_ids": list(kept_ids),
            "drop_component_ids": list(dropped_ids),
        },
        "component_labels": {
            "reference": "stage_b_component_labels.fits",
            "sha256": component_labels_sha256,
        },
        "morphology_audit": {
            "reference": "stage_b_morphology_audit.json",
            "sha256": morphology_audit_sha256,
        },
        "candidate_component_count": len(catalog),
        "all_components_have_arc_seed": all(
            item["has_arc_seed"] for item in catalog
        ),
        "excluded_above_threshold_pixel_count": int(
            excluded_above_threshold_pixel_count
        ),
        "components": catalog,
    }
    validate_stage_b_arc_components(metadata)
    (OUT_DIR / "stage_b_components.json").write_text(
        json.dumps(metadata, indent=2, allow_nan=False) + "\n", encoding="utf-8",
    )


def _plot_arc_components(
    component_labels: np.ndarray,
    catalog: list[dict[str, Any]],
    snr: np.ndarray,
    modeling_mask_array: np.ndarray,
    extent: tuple[float, float, float, float],
    display_extent: tuple[float, float, float, float],
) -> None:
    """Render the labelled component diagnostic reviewed by the expert."""
    snr_display = np.ma.array(snr, mask=modeling_mask_array)
    snr_visible = np.asarray(snr)[~modeling_mask_array]
    snr_vmax = 5.0
    if snr_visible.size and np.isfinite(snr_visible).any():
        snr_vmax = max(snr_vmax, float(np.nanpercentile(snr_visible, 99.5)))
    figure, axis = plt.subplots(figsize=(7.5, 6.5))
    image = axis.imshow(
        snr_display, origin="lower", extent=extent, cmap=PLOT_CMAP_IMAGE,
        vmin=-3, vmax=snr_vmax,
    )
    for component in catalog:
        component_id = component["id"]
        color = "lime" if component["status"] == "kept" else "red"
        contour = component_labels == component_id
        axis.contour(
            contour.astype(float), levels=[0.5], origin="lower", extent=extent,
            colors=color, linewidths=1.4,
        )
        x, y = component["centroid_arcsec"]
        axis.text(
            x, y, str(component_id), color="black", ha="center", va="center", fontsize=9,
            bbox=dict(facecolor=color, edgecolor="white", alpha=0.9, boxstyle="circle,pad=0.18"),
        )
    plot_valid_modeling_domain_boundary(
        axis, modeling_mask_array, extent, annotate=True
    )
    axis.set_title("Stage-B candidate arc components (green kept, red dropped)")
    axis.set_xlim(display_extent[0], display_extent[1])
    axis.set_ylim(display_extent[2], display_extent[3])
    axis.set_aspect("equal", adjustable="box")
    _set_equal_tick_count(axis, display_extent)
    figure.colorbar(image, ax=axis, fraction=0.046, pad=0.04, label="S/N")
    figure.tight_layout()
    figure.savefig(DIAGNOSTICS_DIR / "stage_b_components.png", dpi=120, bbox_inches="tight")
    plt.close(figure)


def _write_arc_component_label_artifacts(
    component_labels: np.ndarray,
    component_count: int,
    snr: np.ndarray,
    threshold_island_labels: np.ndarray,
    arc_seed_pixels: np.ndarray,
    modeling_mask_array: np.ndarray,
    extent: tuple[float, float, float, float],
    display_extent: tuple[float, float, float, float],
    *,
    kept_ids: tuple[int, ...],
    dropped_ids: tuple[int, ...],
) -> list[dict[str, Any]]:
    """Persist and render the candidate labels that the arc-mask expert may select."""
    catalog = _arc_component_catalog(
        component_labels,
        component_count,
        snr,
        threshold_island_labels,
        arc_seed_pixels,
        kept_ids=kept_ids, dropped_ids=dropped_ids,
    )
    fits.writeto(
        OUT_DIR / "stage_b_component_labels.fits",
        np.asarray(component_labels, dtype=np.int32),
        header=_image_geometry_header(component_labels.shape), overwrite=True,
    )
    _plot_arc_components(
        component_labels, catalog, snr, modeling_mask_array, extent, display_extent,
    )
    return catalog


def _prior(spec: PriorConfig) -> dict[str, Any]:
    return spec.model_dump(mode="json")


def _stage_a_theta_E_parameter(config: PipelineConfig) -> ParamU:
    return ParamU(
        "theta_E",
        config.stage_a_theta_E_initial,
        **_prior(config.stage_a_theta_E_prior),
    )


def _mge(
    prefix: str,
    count: int,
    radius: float,
    *,
    two_groups: bool,
    center_prior_spec: PriorConfig,
    shape_prior_spec: PriorConfig,
) -> list[GaussianEllipse]:
    center_prior = _prior(center_prior_spec)
    shape_prior = _prior(shape_prior_spec)
    groups = (1, 2) if two_groups else (1,)
    profiles: list[GaussianEllipse] = []
    sigmas = generate_radial_basis_knots(
        dpix=DPIX, n_sigmas=count, log_rmin=-2.0,
        log_rmax=np.log10(radius), mode="mge",
    )
    for group in groups:
        suffix = f"_{group}" if two_groups else ""
        cx = ParamU(f"center_x_{prefix}{suffix}", 0.0, **center_prior)
        cy = ParamU(f"center_y_{prefix}{suffix}", 0.0, **center_prior)
        e1 = ParamU(f"e1_{prefix}{suffix}", 0.0, **shape_prior)
        e2 = ParamU(f"e2_{prefix}{suffix}", 0.0, **shape_prior)
        for index, sigma in enumerate(sigmas):
            profile = GaussianEllipse(
                sigma=ParamU(f"sigma_{prefix}{suffix}_{index}", float(sigma)),
                center_x=cx, center_y=cy, e1=e1, e2=e2,
                flux=ParamU(f"flux_{prefix}{suffix}_{index}", 1.0),
            )
            profile.sigma.to_static(float(sigma))
            profile.flux.to_static(1.0)
            profiles.append(profile)
        for parameter in (cx, cy, e1, e2):
            parameter.to_dynamic()
    return profiles


def _normalize_source_bbox(
    source_bbox: Any, *, label: str = "Source bbox",
) -> tuple[float, float, float, float]:
    if source_bbox is None or len(source_bbox) != 4:
        raise ValueError(f"{label} must contain four values")
    bbox = tuple(float(value) for value in source_bbox)
    if not np.all(np.isfinite(bbox)):
        raise ValueError(f"{label} values must be finite")
    if not (bbox[0] < bbox[1] and bbox[2] < bbox[3]):
        raise ValueError(f"{label} must satisfy xmin < xmax and ymin < ymax")
    if not np.isclose(
        bbox[1] - bbox[0], bbox[3] - bbox[2], rtol=1.0e-6, atol=1.0e-7,
    ):
        raise ValueError(f"{label} must be square")
    return bbox


def _source_bboxes_match(left: Any, right: Any) -> bool:
    try:
        left_bbox = _normalize_source_bbox(left)
        right_bbox = _normalize_source_bbox(right)
    except (TypeError, ValueError):
        return False
    return bool(np.allclose(left_bbox, right_bbox, rtol=1.0e-6, atol=1.0e-7))


def _stage_a_source_grid_anchor(medians: dict[str, float]) -> dict[str, float]:
    """Return the sole Stage-A provenance used to construct the M0 source grid."""
    required = ("center_x_src", "center_y_src")
    missing = [name for name in required if name not in medians]
    if missing:
        raise KeyError("Stage-A medians missing required keys: " + ", ".join(missing))
    center_x = float(medians["center_x_src"])
    center_y = float(medians["center_y_src"])
    if not np.all(np.isfinite((center_x, center_y))):
        raise ValueError("Stage-A source grid anchor must be finite")
    return {
        "center_x": center_x,
        "center_y": center_y,
    }


def _sample(likelihood: ImageProbModel, *, n_live: int, n_eff: int) -> StagePosterior:
    transform, specs = make_prior_transformation(likelihood)
    loglike = make_likelihood(likelihood, vectorized=True)
    sampler = Sampler(
        transform, loglike, n_dim=len(specs), n_live=n_live,
        vectorized=True, n_batch=300,
    )
    sampler.run(verbose=True, n_eff=n_eff)
    samples, log_weights, _ = sampler.posterior()
    weights = np.exp(np.asarray(log_weights, dtype=np.float64))
    weights /= weights.sum()
    return StagePosterior.from_likelihood(
        likelihood, np.asarray(samples, dtype=np.float64), weights,
        log_z=float(sampler.log_z),
    )


def _save_stage(tag: str, stage: StagePosterior, extra: dict[str, Any]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cache = stage.cache_payload()
    payload = {
        "samples": cache["samples"],
        "weights": cache["weights"],
        "param_names": cache["param_names"],
        "log_z": cache["log_z"],
        "stage_schema": {
            key: cache[key] for key in ("param_names", "prior_specs") if key in cache
        },
        "extra": {**extra, "input_geometry": _input_geometry_metadata()},
    }
    with (OUT_DIR / f"stage_{tag}.pkl").open("wb") as handle:
        pickle.dump(payload, handle)


def _load_stage(tag: str) -> dict[str, Any]:
    with (stage_output_dir(tag) / f"stage_{tag}.pkl").open("rb") as handle:
        return pickle.load(handle)


def _unmasked_extent(mask: np.ndarray, dpix: float) -> tuple[float, float, float, float]:
    """Return pixel-edge bounds enclosing every pixel not excluded by ``mask``."""
    rows = np.where(~mask.all(axis=1))[0]
    cols = np.where(~mask.all(axis=0))[0]
    ny, nx = mask.shape
    if rows.size == 0 or cols.size == 0:
        return (-nx * dpix / 2, nx * dpix / 2, -ny * dpix / 2, ny * dpix / 2)
    return (
        float((int(cols.min()) - nx / 2) * dpix),
        float((int(cols.max()) + 1 - nx / 2) * dpix),
        float((int(rows.min()) - ny / 2) * dpix),
        float((int(rows.max()) + 1 - ny / 2) * dpix),
    )


def _square_extent(extent: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Expand an extent to the smallest square around its existing centre."""
    xmin, xmax, ymin, ymax = (float(value) for value in extent)
    half = max(xmax - xmin, ymax - ymin) / 2
    xmid = (xmin + xmax) / 2
    ymid = (ymin + ymax) / 2
    return (xmid - half, xmid + half, ymid - half, ymid + half)


def _centered_unmasked_square_extent(
    mask: np.ndarray, dpix: float, padding_pixels: int = 1,
) -> tuple[float, float, float, float]:
    """Return a centred square that contains every unmasked image pixel."""
    rows, cols = np.nonzero(~np.asarray(mask, dtype=bool))
    ny, nx = mask.shape
    if rows.size == 0 or cols.size == 0:
        half = max(nx, ny) * dpix / 2
        return (-half, half, -half, half)
    x = (cols - (nx - 1) / 2) * dpix
    y = (rows - (ny - 1) / 2) * dpix
    half = max(float(np.abs(x).max()), float(np.abs(y).max()))
    half += (int(padding_pixels) + 0.5) * dpix
    return (-half, half, -half, half)


def _set_equal_tick_count(axis, extent: tuple[float, float, float, float], nticks: int = 5) -> None:
    """Use matching x/y ticks for square image-plane diagnostic panels."""
    xmin, xmax, ymin, ymax = extent
    axis.set_xticks(np.linspace(xmin, xmax, max(2, int(nticks))))
    axis.set_yticks(np.linspace(ymin, ymax, max(2, int(nticks))))


def _source_sign_diagnostics(
    source_image: np.ndarray, source_bbox: Any | None = None,
) -> dict[str, Any]:
    """Measure source-sign structure without assigning a scientific class."""
    source = np.asarray(source_image, dtype=float)
    finite = np.isfinite(source)
    finite_values = source[finite]
    positive_flux = float(finite_values[finite_values > 0].sum())
    negative_flux = float(-finite_values[finite_values < 0].sum())
    positive_peak = (
        float(finite_values[finite_values > 0].max())
        if np.any(finite_values > 0)
        else 0.0
    )
    negative_peak = (
        float(-finite_values[finite_values < 0].min())
        if np.any(finite_values < 0)
        else 0.0
    )
    edge = np.zeros(source.shape, dtype=bool)
    if source.ndim == 2 and source.size:
        edge[[0, -1], :] = True
        edge[:, [0, -1]] = True
    edge_positive_flux = float(source[edge & finite & (source > 0)].sum())
    edge_negative_flux = float(-source[edge & finite & (source < 0)].sum())
    outer_two = np.zeros(source.shape, dtype=bool)
    if source.ndim == 2 and source.size:
        ring_width = min(2, source.shape[0], source.shape[1])
        outer_two[:ring_width, :] = True
        outer_two[-ring_width:, :] = True
        outer_two[:, :ring_width] = True
        outer_two[:, -ring_width:] = True
    ring_positive_flux = float(source[outer_two & finite & (source > 0)].sum())
    ring_negative_flux = float(-source[outer_two & finite & (source < 0)].sum())
    diagnostics = {
        "finite_pixel_count": int(finite.sum()),
        "non_finite_pixel_count": int((~finite).sum()),
        "negative_pixel_fraction": (
            float(np.count_nonzero(finite_values < 0) / finite_values.size)
            if finite_values.size
            else None
        ),
        "negative_to_positive_integrated_flux_ratio": (
            negative_flux / positive_flux if positive_flux > 0 else None
        ),
        "negative_to_positive_peak_amplitude_ratio": (
            negative_peak / positive_peak if positive_peak > 0 else None
        ),
        "positive_flux_fraction_at_bbox_edge": (
            edge_positive_flux / positive_flux if positive_flux > 0 else None
        ),
        "negative_flux_fraction_at_bbox_edge": (
            edge_negative_flux / negative_flux if negative_flux > 0 else None
        ),
        "positive_flux_fraction_in_outer_two_pixel_ring": (
            ring_positive_flux / positive_flux if positive_flux > 0 else None
        ),
        "negative_flux_fraction_in_outer_two_pixel_ring": (
            ring_negative_flux / negative_flux if negative_flux > 0 else None
        ),
    }
    if source.ndim == 2 and source.size:
        edge_rows = {
            "bottom": source[0, :],
            "top": source[-1, :],
            "left": source[:, 0],
            "right": source[:, -1],
        }
        diagnostics["positive_flux_fraction_by_bbox_edge"] = {
            name: (
                float(values[np.isfinite(values) & (values > 0)].sum()) / positive_flux
                if positive_flux > 0
                else None
            )
            for name, values in edge_rows.items()
        }
        ring_width = min(2, source.shape[0], source.shape[1])
        ring_sides = {
            "bottom": source[:ring_width, :],
            "top": source[-ring_width:, :],
            "left": source[:, :ring_width],
            "right": source[:, -ring_width:],
        }
        diagnostics["positive_flux_fraction_by_outer_two_pixel_side"] = {
            name: (
                float(values[np.isfinite(values) & (values > 0)].sum()) / positive_flux
                if positive_flux > 0
                else None
            )
            for name, values in ring_sides.items()
        }
    if source_bbox is not None:
        bbox = _normalize_source_bbox(source_bbox)
        diagnostics["source_bbox"] = bbox
        diagnostics["source_grid_pixel_scale"] = {
            "x": (bbox[1] - bbox[0]) / (source.shape[1] - 1)
            if source.ndim == 2 and source.shape[1] > 1
            else None,
            "y": (bbox[3] - bbox[2]) / (source.shape[0] - 1)
            if source.ndim == 2 and source.shape[0] > 1
            else None,
        }
    return diagnostics


def _connected_region_summary(mask: np.ndarray) -> tuple[int, int]:
    labels, count = ndimage.label(
        np.asarray(mask, dtype=bool), structure=np.ones((3, 3), dtype=int)
    )
    if count == 0:
        return 0, 0
    areas = ndimage.sum(mask, labels, index=range(1, count + 1))
    return int(count), int(np.max(areas))


def _residual_region_statistics(
    normalized_residual: np.ndarray, region: np.ndarray
) -> dict[str, Any]:
    residual = np.asarray(normalized_residual, dtype=float)
    valid = np.asarray(region, dtype=bool) & np.isfinite(residual)
    values = residual[valid]
    positive = valid & (residual > RESIDUAL_SIGNIFICANCE_REFERENCE_SIGMA)
    negative = valid & (residual < -RESIDUAL_SIGNIFICANCE_REFERENCE_SIGMA)
    positive_count, positive_max_area = _connected_region_summary(positive)
    negative_count, negative_max_area = _connected_region_summary(negative)
    return {
        "pixel_count": int(values.size),
        "rms": float(np.sqrt(np.mean(np.square(values)))) if values.size else None,
        "abs_gt_3sigma_fraction": (
            float(
                np.mean(np.abs(values) > RESIDUAL_SIGNIFICANCE_REFERENCE_SIGMA)
            )
            if values.size
            else None
        ),
        "abs_gt_5sigma_fraction": (
            float(np.mean(np.abs(values) > 5.0)) if values.size else None
        ),
        "positive_connected_region_count": positive_count,
        "positive_connected_region_max_area_pixels": positive_max_area,
        "negative_connected_region_count": negative_count,
        "negative_connected_region_max_area_pixels": negative_max_area,
    }


def _residual_diagnostics(
    normalized_residual: np.ndarray,
    *,
    valid_mask: np.ndarray,
    arc_region: np.ndarray | None = None,
    modeled_support: np.ndarray | None = None,
) -> dict[str, Any]:
    """Describe normalized residual morphology using reference, not gate, levels."""
    residual = np.asarray(normalized_residual, dtype=float)
    valid = np.asarray(valid_mask, dtype=bool)
    diagnostics: dict[str, Any] = {
        "significance_reference_sigma": RESIDUAL_SIGNIFICANCE_REFERENCE_SIGMA,
        "all_valid_pixels": _residual_region_statistics(residual, valid),
    }
    if arc_region is not None:
        arc = np.asarray(arc_region, dtype=bool)
        diagnostics["inside_arc_region"] = _residual_region_statistics(
            residual, valid & arc
        )
        diagnostics["outside_arc_region"] = _residual_region_statistics(
            residual, valid & ~arc
        )
    if modeled_support is not None:
        significant = (
            valid
            & np.isfinite(residual)
            & (np.abs(residual) > RESIDUAL_SIGNIFICANCE_REFERENCE_SIGMA)
        )
        support = np.asarray(modeled_support, dtype=bool)
        diagnostics["significant_residual_modeled_support_overlap_fraction"] = (
            float(np.mean(support[significant])) if np.any(significant) else None
        )
    return diagnostics


def _modeled_support(model: np.ndarray) -> np.ndarray:
    absolute = np.abs(np.asarray(model, dtype=float))
    finite = np.isfinite(absolute)
    peak = float(np.max(absolute[finite])) if np.any(finite) else 0.0
    return (
        finite & (absolute >= MODELED_SUPPORT_REFERENCE_FRACTION * peak)
        if peak > 0
        else np.zeros_like(finite)
    )


def _stage_from_payload(payload: dict[str, Any]) -> StagePosterior:
    schema = payload.get("stage_schema", {})
    prior_specs = schema.get("prior_specs")
    return StagePosterior.from_schema(
        payload["samples"], payload["weights"], prior_specs=prior_specs,
        param_names=None if prior_specs is not None else payload["param_names"],
        log_z=payload.get("log_z"),
    )


def build_stage_a_likelihood(image, noise, psf, mask=None) -> ImageProbModel:
    cfg = _CONFIG
    mass = SIE(
        theta_E=_stage_a_theta_E_parameter(cfg),
        e1=ParamU("e1_mass", 0.0, **_prior(cfg.stage_a_e1_prior)),
        e2=ParamU("e2_mass", 0.0, **_prior(cfg.stage_a_e2_prior)),
        center_x=ParamU("center_x_mass", 0.0, **_prior(cfg.stage_a_center_x_prior)),
        center_y=ParamU("center_y_mass", 0.0, **_prior(cfg.stage_a_center_y_prior)),
    )
    shear = Shear(
        gamma1=ParamU("gamma1", 0.0, **_prior(cfg.stage_a_gamma1_prior)),
        gamma2=ParamU("gamma2", 0.0, **_prior(cfg.stage_a_gamma2_prior)),
    )
    for parameter in (
        mass.theta_E, mass.e1, mass.e2, mass.center_x, mass.center_y,
        shear.gamma1, shear.gamma2,
    ):
        parameter.to_dynamic()
    physical = PhysicalModel(
        lens_mass=[mass, shear],
        source_light=_mge(
            "src",
            cfg.n_gaussians_src,
            1.0,
            two_groups=False,
            center_prior_spec=cfg.stage_a_src_center_prior,
            shape_prior_spec=cfg.stage_a_src_e_prior,
        ),
        lens_light=_mge(
            "lens",
            cfg.n_gaussians_lens,
            MASK_RADIUS,
            two_groups=True,
            center_prior_spec=cfg.stage_a_lens_light_center_prior,
            shape_prior_spec=cfg.stage_a_lens_light_e_prior,
        ),
    )
    return ImageProbModel(
        image_data=image, noise_map=noise, psf_kernel=psf, dpix=DPIX,
        nsub=NSUB, phys_model=physical, use_linear=True,
        solver_type="nnls", mask=mask,
    )


def _parametric_planes(
    likelihood: ImageProbModel, medians: dict[str, float], param_names: list[str]
) -> tuple[np.ndarray, np.ndarray]:
    likelihood.set_values([medians[name] for name in param_names])
    result = likelihood.forward_model(
        use_linear=True, return_intensity=True, ret_each_plane=True,
        image_map=likelihood.image_data, noise_map=likelihood.noise_map,
    )
    return np.asarray(result[0]), np.asarray(result[1])


def _plot_parametric_stage(
    likelihood: ImageProbModel,
    theta: jnp.ndarray,
    target: Path,
    title: str,
    *,
    source_npix: int = PARAMETRIC_SOURCE_NPIX,
    source_dpix: float = PARAMETRIC_SOURCE_DPIX,
    source_display_range: tuple[float, float] | None = PARAMETRIC_SOURCE_DISPLAY_RANGE,
    show_critical_lines: bool = False,
    show_caustics: bool = False,
) -> None:
    """Save a parametric-model diagnostic with a high-resolution source-plane crop."""
    figure, axes = plot_model_results(
        likelihood,
        theta,
        title=title,
        source_npix=source_npix,
        source_dpix=source_dpix,
        show_critical_lines=show_critical_lines,
        show_caustics=show_caustics,
    )
    if source_display_range is not None:
        source_axis = axes[1, 2]
        source_axis.set_xlim(*source_display_range)
        source_axis.set_ylim(*source_display_range)
    figure.savefig(target, dpi=150, bbox_inches="tight")
    plt.close(figure)


def run_stage_a(image, noise, psf, circular_mask=None):
    start = time.monotonic()
    likelihood = build_stage_a_likelihood(image, noise, psf, circular_mask)
    stage = _sample(
        likelihood, n_live=_CONFIG.stage_a_n_live, n_eff=_CONFIG.stage_a_n_eff
    )
    medians = stage.medians()
    source_grid_anchor = _stage_a_source_grid_anchor(medians)
    lensed_source, lens_light = _parametric_planes(
        likelihood, medians, stage.param_names
    )
    valid = (
        ~np.asarray(circular_mask, dtype=bool)
        if circular_mask is not None
        else np.ones_like(image, dtype=bool)
    )
    residual_diagnostics = _residual_diagnostics(
        (np.asarray(image) - lens_light - lensed_source) / np.asarray(noise),
        valid_mask=valid,
        modeled_support=_modeled_support(lensed_source),
    )
    residual_diagnostics["modeled_support_reference_fraction_of_peak"] = (
        MODELED_SUPPORT_REFERENCE_FRACTION
    )
    _save_stage("a", stage, {
        "medians": medians,
        "lens_light_model": lens_light,
        "source_grid_anchor": source_grid_anchor,
        "residual_diagnostics": residual_diagnostics,
        "time_taken": time.monotonic() - start,
    })
    _write_stage_a_predicted_image_family(medians, np.asarray(image).shape)
    _plot_parametric_stage(
        likelihood, jnp.asarray([medians[name] for name in stage.param_names]),
        DIAGNOSTICS_DIR / "stage_a_model.png", "Stage A",
        source_npix=PARAMETRIC_SOURCE_NPIX,
        source_dpix=PARAMETRIC_SOURCE_DPIX,
        source_display_range=PARAMETRIC_SOURCE_DISPLAY_RANGE,
        show_critical_lines=True, show_caustics=True,
    )
    return stage, medians, lens_light


def run_stage_b(
    image, noise, lens_light_model, predicted_image_family, modeling_mask=None,
    *, family_reference=None, family_sha256=None,
):
    residual = image - lens_light_model
    snr = residual / noise
    modeling_mask_array = (
        np.asarray(modeling_mask, dtype=bool)
        if modeling_mask is not None
        else np.zeros_like(image, dtype=bool)
    )
    construction = construct_arc_mask(
        snr, modeling_mask=modeling_mask_array, threshold=_CONFIG.arc_snr_threshold,
        ignor_size=_CONFIG.arc_ignor_size, ext_size=_CONFIG.arc_ext_size,
        close_size=_CONFIG.arc_close_size,
    )
    feature_mask = construction.feature_mask
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ny, nx = image.shape
    extent = (-nx * DPIX / 2, nx * DPIX / 2, -ny * DPIX / 2, ny * DPIX / 2)
    display_extent = _square_extent(_unmasked_extent(modeling_mask_array, DPIX))
    candidate_arc_region = ~np.asarray(feature_mask, dtype=bool) & ~modeling_mask_array
    component_labels, component_count = _arc_component_labels(candidate_arc_region)
    arc_region, kept_component_ids, dropped_component_ids = _apply_arc_component_selection(
        candidate_arc_region, component_labels, component_count,
    )
    feature_mask = ~arc_region
    component_catalog = _write_arc_component_label_artifacts(
        component_labels,
        component_count,
        snr,
        construction.threshold_island_labels,
        construction.filtered_signal,
        modeling_mask_array,
        extent,
        display_extent,
        kept_ids=kept_component_ids, dropped_ids=dropped_component_ids,
    )
    fits.writeto(
        OUT_DIR / "feature_mask.fits", feature_mask.astype(np.uint8),
        header=_image_geometry_header(feature_mask.shape), overwrite=True,
    )
    if family_reference is None:
        family_reference = (
            f"{predicted_image_family['stage_attempt']}/artifacts/"
            "stage_a_predicted_image_family.json"
        )
    if family_sha256 is None:
        canonical_family = json.dumps(
            predicted_image_family, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        family_sha256 = hashlib.sha256(canonical_family).hexdigest()
    morphology_audit = build_stage_b_morphology_audit(
        predicted_image_family,
        construction=construction,
        snr=snr,
        modeling_mask=modeling_mask_array,
        candidate_component_labels=component_labels,
        selected_arc_region=arc_region,
        stage_attempt=_STAGE_ATTEMPT_REFERENCE,
        family_reference=family_reference,
        family_sha256=family_sha256,
        threshold=_CONFIG.arc_snr_threshold,
        ignor_size=_CONFIG.arc_ignor_size,
        ext_size=_CONFIG.arc_ext_size,
        close_size=_CONFIG.arc_close_size,
    )
    (OUT_DIR / "stage_b_morphology_audit.json").write_text(
        json.dumps(morphology_audit, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    component_labels_path = OUT_DIR / "stage_b_component_labels.fits"
    morphology_audit_path = OUT_DIR / "stage_b_morphology_audit.json"
    _write_arc_component_metadata(
        component_catalog,
        image_shape=component_labels.shape,
        kept_ids=kept_component_ids,
        dropped_ids=dropped_component_ids,
        excluded_above_threshold_pixel_count=(
            construction.excluded_above_threshold_pixel_count
        ),
        component_labels_sha256=hashlib.sha256(
            component_labels_path.read_bytes()
        ).hexdigest(),
        morphology_audit_sha256=hashlib.sha256(
            morphology_audit_path.read_bytes()
        ).hexdigest(),
    )
    plot_stage_b_morphology_audit(
        morphology_audit,
        snr=snr,
        threshold_island_labels=construction.threshold_island_labels,
        selected_arc_region=arc_region,
        modeling_mask=modeling_mask_array,
        target=DIAGNOSTICS_DIR / "stage_b_morphology_audit.png",
    )
    plot_stage_b_mask(
        residual=residual, snr=snr, modeling_mask_array=modeling_mask_array,
        arc_region=arc_region, component_count=component_count,
        dropped_component_ids=dropped_component_ids,
        excluded_above_threshold_pixel_count=construction.excluded_above_threshold_pixel_count,
        target=DIAGNOSTICS_DIR / "stage_b_mask.png",
    )
    return feature_mask


def plot_stage_b_mask(
    *, residual, snr, modeling_mask_array, arc_region, component_count,
    dropped_component_ids, excluded_above_threshold_pixel_count, target,
):
    """Render saved Stage-B arrays without constructing or writing a mask."""
    ny, nx = snr.shape
    extent = (-nx * DPIX / 2, nx * DPIX / 2, -ny * DPIX / 2, ny * DPIX / 2)
    display_extent = _square_extent(_unmasked_extent(modeling_mask_array, DPIX))
    high_snr = (snr > _CONFIG.arc_snr_threshold) & ~modeling_mask_array
    covered_high_snr = high_snr & arc_region
    raw_missed_high_snr = high_snr & ~arc_region
    missed_high_snr, isolated_missed_high_snr, missed_component_sizes = (
        _connected_component_area_filter(
            raw_missed_high_snr, _CONFIG.arc_ignor_size
        )
    )
    mask_only = arc_region & ~high_snr
    n_high_snr = int(high_snr.sum())
    n_raw_missed = int(raw_missed_high_snr.sum())
    n_missed = int(missed_high_snr.sum())
    n_isolated_missed = int(isolated_missed_high_snr.sum())
    n_missed_components = int(
        sum(size >= _CONFIG.arc_ignor_size for size in missed_component_sizes)
    )
    missed_fraction = n_missed / n_high_snr if n_high_snr else 0.0
    max_snr_outside_mask = float(np.nanmax(snr[missed_high_snr])) if n_missed else float("nan")

    residual_display = np.ma.array(residual, mask=modeling_mask_array)
    snr_display = np.ma.array(snr, mask=modeling_mask_array)
    high_snr_display = np.ma.array(high_snr.astype(float), mask=modeling_mask_array)
    arc_region_display = np.ma.array(arc_region.astype(float), mask=modeling_mask_array)
    snr_visible = snr[~modeling_mask_array]
    snr_vmax = 5.0
    if snr_visible.size and np.isfinite(snr_visible).any():
        snr_vmax = max(snr_vmax, float(np.nanpercentile(snr_visible, 99.5)))

    diagnostic_rgb = np.ones((*snr.shape, 3), dtype=float)
    diagnostic_rgb[modeling_mask_array] = (0.82, 0.82, 0.82)
    diagnostic_rgb[mask_only] = (0.12, 0.34, 0.95)
    diagnostic_rgb[covered_high_snr] = (0.00, 0.72, 0.18)
    diagnostic_rgb[isolated_missed_high_snr] = (1.00, 0.58, 0.00)
    diagnostic_rgb[missed_high_snr] = (1.00, 0.00, 0.00)

    fig, axes = plt.subplots(2, 3, figsize=(13.5, 8.0))
    axes = axes.ravel()

    im0 = axes[0].imshow(residual_display, origin="lower", extent=extent, cmap=PLOT_CMAP_IMAGE)
    axes[0].set_title("residual = image - stage-A lens light")
    fig.colorbar(im0, ax=axes[0], fraction=0.046, pad=0.04)

    im1 = axes[1].imshow(
        snr_display, origin="lower", extent=extent, cmap=PLOT_CMAP_IMAGE,
        vmin=-3, vmax=snr_vmax,
    )
    axes[1].set_title("S/N map + arc mask boundary")
    axes[1].contour(
        arc_region.astype(float), levels=[0.5], origin="lower", extent=extent,
        colors="cyan", linewidths=1.4,
    )
    plot_valid_modeling_domain_boundary(axes[1], modeling_mask_array, extent)
    fig.colorbar(im1, ax=axes[1], fraction=0.046, pad=0.04)

    im2 = axes[2].imshow(
        high_snr_display, origin="lower", extent=extent, cmap="gray", vmin=0, vmax=1,
    )
    axes[2].set_title(f"S/N > {_CONFIG.arc_snr_threshold:.1f} pixels")
    fig.colorbar(im2, ax=axes[2], fraction=0.046, pad=0.04, ticks=[0, 1])

    im3 = axes[3].imshow(
        arc_region_display, origin="lower", extent=extent, cmap="Blues", vmin=0, vmax=1,
    )
    axes[3].set_title("arc mask region")
    axes[3].contour(
        arc_region.astype(float), levels=[0.5], origin="lower", extent=extent,
        colors="cyan", linewidths=1.2,
    )
    fig.colorbar(im3, ax=axes[3], fraction=0.046, pad=0.04, ticks=[0, 1])

    axes[4].imshow(diagnostic_rgb, origin="lower", extent=extent)
    axes[4].set_title("coverage diagnostic")
    plot_valid_modeling_domain_boundary(axes[4], modeling_mask_array, extent)

    axes[5].axis("off")
    axes[5].legend(
        handles=[
            Patch(facecolor=(0.00, 0.72, 0.18)),
            Patch(facecolor=(1.00, 0.00, 0.00)),
            Patch(facecolor=(1.00, 0.58, 0.00)),
            Patch(facecolor=(0.12, 0.34, 0.95)),
            (Line2D([], [], color="black"), Line2D([], [], color="white", linestyle="--")),
        ],
        labels=[
            f"covered S/N>{_CONFIG.arc_snr_threshold:.1f}",
            f"uncovered island >= {_CONFIG.arc_ignor_size} px",
            "ignored small component", "mask only",
            "valid modeling domain boundary",
        ],
        handler_map={tuple: HandlerTuple(ndivide=1)},
        loc="upper left", bbox_to_anchor=(0.0, 1.02),
        frameon=False, fontsize=9, borderaxespad=0,
    )
    max_snr_text = "n/a" if not np.isfinite(max_snr_outside_mask) else f"{max_snr_outside_mask:.2f}"
    axes[5].text(
        0.02, 0.64,
        "\n".join((
            "Stage-B arc mask audit",
            f"S/N threshold: {_CONFIG.arc_snr_threshold:.1f}",
            f"large-island reference: {_CONFIG.arc_ignor_size} pixels",
            f"S/N>{_CONFIG.arc_snr_threshold:.1f} pixels: {n_high_snr}",
            (
                f"excluded S/N>{_CONFIG.arc_snr_threshold:.1f} pixels: "
                f"{excluded_above_threshold_pixel_count}"
            ),
            f"raw outside-mask pixels: {n_raw_missed}",
            f"ignored small-comp. pixels: {n_isolated_missed}",
            f"large uncovered threshold islands: {n_missed_components}",
            f"large uncovered threshold pixels: {n_missed}",
            f"large uncovered threshold fraction: {missed_fraction:.3%}",
            f"max S/N in large uncovered islands: {max_snr_text}",
            f"arc pixels kept: {int(arc_region.sum())}",
            f"candidate arc components: {component_count}",
            f"dropped components: {list(dropped_component_ids) or 'none'}",
        )),
        transform=axes[5].transAxes,
        ha="left", va="top", fontsize=9, linespacing=1.25,
    )

    for axis in axes[:5]:
        axis.set_xlim(display_extent[0], display_extent[1])
        axis.set_ylim(display_extent[2], display_extent[3])
        axis.set_aspect("equal", adjustable="box")
        _set_equal_tick_count(axis, display_extent)
        axis.set_xlabel("x (arcsec)")
        axis.set_ylabel("y (arcsec)")

    fig.tight_layout()
    fig.savefig(target, dpi=120, bbox_inches="tight")
    plt.close(fig)


def _connected_component_area_filter(mask: np.ndarray, min_pixels: int):
    labeled, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=int))
    sizes = ndimage.sum(mask, labeled, index=range(1, count + 1))
    keep = np.zeros_like(mask, dtype=bool)
    isolated = np.zeros_like(mask, dtype=bool)
    for label, size in enumerate(sizes, start=1):
        target = labeled == label
        (keep if size >= min_pixels else isolated)[target] = True
    return keep, isolated, [int(size) for size in sizes]


def _solve_stage_a_image_positions(medians: dict[str, float]) -> np.ndarray:
    model = PhysicalModel(
        lens_mass=[
            SIE(
                theta_E=float(medians["theta_E"]), e1=float(medians["e1_mass"]),
                e2=float(medians["e2_mass"]), center_x=float(medians["center_x_mass"]),
                center_y=float(medians["center_y_mass"]),
            ),
            Shear(gamma1=float(medians["gamma1"]), gamma2=float(medians["gamma2"])),
        ],
        source_light=[], lens_light=[],
    )
    solver = PointSourceProbModel(
        phys_model=model, observed_positions=[[0.0, 0.0]], position_sigma=[0.01],
        source_x=float(medians["center_x_src"]), source_y=float(medians["center_y_src"]),
        source_position_fixed=True, solver=POSITION_SOLVER,
        solver_config=POSITION_SOLVER_CONFIG,
    )
    positions, _ = solver.solve_image_positions()
    positions = np.asarray(positions, dtype=np.float64)
    return positions


def _write_stage_a_predicted_image_family(
    medians: dict[str, float], image_shape: tuple[int, int],
) -> dict[str, Any]:
    family = build_predicted_image_family(
        _solve_stage_a_image_positions(medians),
        medians=medians,
        image_shape=image_shape,
        pixel_scale_arcsec=DPIX,
        stage_attempt=_STAGE_ATTEMPT_REFERENCE,
        solver=POSITION_SOLVER,
        solver_config=POSITION_SOLVER_CONFIG,
        threshold_arcsec=POSITION_THRESHOLD_ARCSEC,
        min_log_like=POSITION_MIN_LOG_LIKE,
    )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "stage_a_predicted_image_family.json").write_text(
        json.dumps(family, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    return family


def _fixed_sie(stage_a: StagePosterior):
    return (
        SIE(
            theta_E=stage_a.fixed("theta_E"), e1=stage_a.fixed("e1_mass"),
            e2=stage_a.fixed("e2_mass"), center_x=stage_a.fixed("center_x_mass"),
            center_y=stage_a.fixed("center_y_mass"),
        ),
        Shear(gamma1=stage_a.fixed("gamma1"), gamma2=stage_a.fixed("gamma2")),
    )


def _free_sie(stage_a: StagePosterior):
    cfg = _CONFIG
    mass = SIE(
        theta_E=stage_a.gaussian(
            "theta_E", model="SIE", attr="theta_E",
            limits=list(cfg.stage_m1_theta_E_prior_limits),
        ),
        e1=stage_a.gaussian(
            "e1_mass", model="SIE", attr="e1",
            limits=list(cfg.stage_m1_ellipticity_prior_limits),
        ),
        e2=stage_a.gaussian(
            "e2_mass", model="SIE", attr="e2",
            limits=list(cfg.stage_m1_ellipticity_prior_limits),
        ),
        center_x=stage_a.fixed("center_x_mass"),
        center_y=stage_a.fixed("center_y_mass"),
    )
    shear = Shear(
        gamma1=stage_a.gaussian(
            "gamma1", model="Shear", attr="gamma1",
            limits=list(cfg.stage_m1_shear_prior_limits),
        ),
        gamma2=stage_a.gaussian(
            "gamma2", model="Shear", attr="gamma2",
            limits=list(cfg.stage_m1_shear_prior_limits),
        ),
    )
    return mass, shear


def _fixed_sie_from_medians(medians: dict[str, float]):
    mass = SIE(
        theta_E=ParamU("theta_E", medians["theta_E"]),
        e1=ParamU("e1_mass", medians["e1_mass"]),
        e2=ParamU("e2_mass", medians["e2_mass"]),
        center_x=ParamU("center_x_mass", medians["center_x_mass"]),
        center_y=ParamU("center_y_mass", medians["center_y_mass"]),
    )
    for parameter in (
        mass.theta_E, mass.e1, mass.e2, mass.center_x, mass.center_y
    ):
        parameter.to_static()
    shear = Shear(
        gamma1=ParamU("gamma1", medians["gamma1"]),
        gamma2=ParamU("gamma2", medians["gamma2"]),
    )
    shear.gamma1.to_static()
    shear.gamma2.to_static()
    return mass, shear


def _free_epl(stage_m1: StagePosterior, stage_a: StagePosterior):
    cfg = _CONFIG
    mass = EPL(
        theta_E=stage_m1.gaussian(
            "theta_E", model="EPL", attr="theta_E",
            limits=list(cfg.stage_m3_theta_E_prior_limits),
        ),
        gamma=ParamU("gamma", 2.0, **_prior(cfg.stage_m3_gamma_prior)),
        e1=stage_m1.gaussian(
            "e1_mass", model="EPL", attr="e1",
            limits=list(cfg.stage_m3_ellipticity_prior_limits),
        ),
        e2=stage_m1.gaussian(
            "e2_mass", model="EPL", attr="e2",
            limits=list(cfg.stage_m3_ellipticity_prior_limits),
        ),
        center_x=stage_a.fixed("center_x_mass"),
        center_y=stage_a.fixed("center_y_mass"),
    )
    mass.gamma.to_dynamic()
    shear = Shear(
        gamma1=stage_m1.gaussian(
            "gamma1", model="Shear", attr="gamma1",
            limits=list(cfg.stage_m3_shear_prior_limits),
        ),
        gamma2=stage_m1.gaussian(
            "gamma2", model="Shear", attr="gamma2",
            limits=list(cfg.stage_m3_shear_prior_limits),
        ),
    )
    return mass, shear


def _pixel_likelihood(
    image, noise, psf, feature_mask, circular_mask, mass_profiles,
    source: PixelizedSourceModel, position_likelihood, *, fixed_source_bbox, **kwargs,
):
    mask = np.asarray(feature_mask, dtype=bool)
    if circular_mask is not None:
        mask = mask | np.asarray(circular_mask, dtype=bool)
    physical = PhysicalModel(
        lens_mass=list(mass_profiles), source_light=[source], lens_light=[]
    )
    return PixelizedImageProbModelOperator(
        image_data=image, noise_map=noise, psf_kernel=psf, dpix=DPIX,
        nsub=NSUB_PIX, phys_model=physical, mask=mask,
        position_likelihood=position_likelihood, solver_type=SOLVER_TYPE,
        fixed_source_bbox=_normalize_source_bbox(fixed_source_bbox), **kwargs,
    )


def _solve_source(likelihood, medians: dict[str, float], names: list[str]) -> dict[str, Any]:
    with ck.ActiveContext(likelihood):
        likelihood.fill_params(jnp.asarray([medians[name] for name in names]))
        source = likelihood.phys_model.source_light[0]
        lambda_reg = jnp.exp(source.log_lambda_reg.value)
        xmin, xmax, ymin, ymax, beta_x_sub, beta_y_sub, _, _ = likelihood._get_bbox()
        scale = likelihood._get_reg_scale()
        regularization = likelihood._regularization_data(
            xmin, xmax, ymin, ymax, scale=scale
        )
        operator = likelihood.sim_obj.precompute_operator_data(
            xmin, xmax, ymin, ymax, _betas_sub=(beta_x_sub, beta_y_sub)
        )
        preconditioner = likelihood.sim_obj.build_block_diag_preconditioner(
            likelihood.noise_1d, xmin, xmax, ymin, ymax, lambda_reg,
            likelihood.reg_builder, block_size=likelihood.block_size, scale=scale,
        )
        pixels, solver_info = likelihood._solve_source(
            xmin, xmax, ymin, ymax, lambda_reg, regularization,
            preconditioner, op_data=operator,
        )
        model = likelihood.sim_obj.forward_model(
            pixels, xmin, xmax, ymin, ymax, op_data=operator
        )
        # Dynamic values revert on context exit; capture the evaluated value.
        rho = float(np.asarray(getattr(source.adaptive_reg_rho, "value", source.adaptive_reg_rho)))
    if hasattr(solver_info, "converged") and not bool(np.asarray(solver_info.converged)):
        raise RuntimeError("pixelized source solver did not converge")
    n = int(source.n)
    reg_scale = np.ones((n, n), dtype=np.float64) if scale is None else np.asarray(scale, dtype=np.float64).reshape(n, n)
    adaptive_regularization = bool(
        scale is not None or getattr(likelihood, "_fixed_reg_template", None) is not None
    )
    return {
        "source_pixels": np.asarray(pixels, dtype=np.float64),
        "source_image": np.asarray(pixels, dtype=np.float64).reshape(n, n),
        "source_bbox": (float(xmin), float(xmax), float(ymin), float(ymax)),
        "source_x_axis": np.linspace(float(xmin), float(xmax), n),
        "source_y_axis": np.linspace(float(ymin), float(ymax), n),
        "model_1d": np.asarray(model, dtype=np.float64),
        "reg_scale_image": reg_scale,
        "adaptive_reg_rho": float(np.asarray(rho)),
        "adaptive_regularization": adaptive_regularization,
        "n": n,
    }


def _pixelized_scientific_diagnostics(
    likelihood, solved: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    image = np.asarray(likelihood.image_data, dtype=float)
    noise = np.asarray(likelihood.noise_map, dtype=float)
    valid = np.asarray(likelihood.unmask, dtype=bool)
    model = np.zeros_like(image, dtype=float)
    model[valid] = np.asarray(solved["model_1d"], dtype=float)
    residual_diagnostics = _residual_diagnostics(
        (image - model) / noise,
        valid_mask=valid,
        arc_region=valid,
        modeled_support=_modeled_support(model),
    )
    residual_diagnostics["modeled_support_reference_fraction_of_peak"] = (
        MODELED_SUPPORT_REFERENCE_FRACTION
    )
    return {
        "source_sign_diagnostics": _source_sign_diagnostics(
            np.asarray(solved["source_image"], dtype=float), solved["source_bbox"],
        ),
        "residual_diagnostics": residual_diagnostics,
    }


def _grid_from_anchor(source_grid_anchor: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(source_grid_anchor, dict) or set(source_grid_anchor) != {
        "center_x", "center_y",
    }:
        raise ValueError("Stage-A source grid anchor is invalid")
    return source_grid_spec(
        center_x=float(source_grid_anchor["center_x"]),
        center_y=float(source_grid_anchor["center_y"]),
        level=_CONFIG.source_grid_level,
    )


def _write_source_grid_spec(source_grid: dict[str, Any]) -> None:
    validated = validate_source_grid_spec(source_grid)
    (OUT_DIR / "source_grid_spec.json").write_text(
        json.dumps(validated, indent=2) + "\n", encoding="utf-8"
    )


def _load_source_grid_spec(path: Path) -> dict[str, Any]:
    return validate_source_grid_spec(
        json.loads(path.read_text(encoding="utf-8")),
        expected_level=_CONFIG.source_grid_level,
    )


def _validate_runtime_source_grid(source_grid: dict[str, Any]) -> dict[str, Any]:
    return validate_source_grid_spec(
        source_grid, expected_level=_CONFIG.source_grid_level
    )


def _pixel_center_bbox(source_grid: dict[str, Any]) -> tuple[float, float, float, float]:
    validated = validate_source_grid_spec(source_grid)
    return tuple(float(value) for value in validated["pixel_center_bbox"])


def _validate_source_template_package(
    package: dict[str, Any], source_grid: dict[str, Any] | None = None,
):
    required = {
        "source_pixels", "source_bbox", "source_x_axis", "source_y_axis",
        "n", "lambda_best", "log_lambda_best",
    }
    missing = sorted(required - package.keys())
    if missing:
        raise KeyError(f"source template missing: {', '.join(missing)}")
    n = int(package["n"])
    expected_grid = validate_source_grid_spec(source_grid) if source_grid is not None else None
    if (
        (expected_grid is not None and n != expected_grid["nsrc"])
        or np.asarray(package["source_pixels"]).shape != (n * n,)
    ):
        raise ValueError("source template does not match the M0-Sealed Source Grid")
    bbox = _normalize_source_bbox(package["source_bbox"], label="Source template bbox")
    if expected_grid is not None and not _source_bboxes_match(
        bbox, expected_grid["pixel_center_bbox"]
    ):
        raise ValueError("source template bbox does not match the M0-Sealed Source Grid")
    expected_x_axis = np.linspace(bbox[0], bbox[1], n, dtype=np.float64)
    expected_y_axis = np.linspace(bbox[2], bbox[3], n, dtype=np.float64)
    for axis_name, expected_axis in (
        ("source_x_axis", expected_x_axis), ("source_y_axis", expected_y_axis),
    ):
        axis = np.asarray(package[axis_name], dtype=np.float64)
        if axis.shape != (n,) or not np.allclose(
            axis, expected_axis, rtol=1.0e-6, atol=1.0e-7,
        ):
            raise ValueError(f"source template {axis_name} does not match its bbox")
    package["source_bbox"] = bbox
    return package


def _fixed_source_template_kwargs(
    package: dict[str, Any], source_grid: dict[str, Any],
) -> dict[str, Any]:
    package = _validate_source_template_package(package, source_grid)
    return {
        "fixed_source_bbox": tuple(float(value) for value in package["source_bbox"]),
        "fixed_reg_template": jnp.asarray(package["source_pixels"], dtype=jnp.float32),
    }


def _plot_pixel_stage(
    tag: str,
    likelihood,
    solved: dict[str, Any],
    target: Path,
    source_grid: dict[str, Any],
    *,
    medians: dict[str, float],
    names: list[str],
    subhalo_marker: bool = False,
) -> None:
    image = np.asarray(likelihood.image_data)
    mask = ~np.asarray(likelihood.unmask, dtype=bool)
    model = np.zeros(image.shape, dtype=float)
    model[~mask] = solved["model_1d"]
    residual = (image - model) / np.asarray(likelihood.noise_map)
    image_extent = (
        -image.shape[1] * DPIX / 2,
        image.shape[1] * DPIX / 2,
        -image.shape[0] * DPIX / 2,
        image.shape[0] * DPIX / 2,
    )
    validated_grid = validate_source_grid_spec(
        source_grid, source_shape=np.asarray(solved["source_image"]).shape
    )
    if not _source_bboxes_match(
        solved["source_bbox"], validated_grid["pixel_center_bbox"]
    ):
        raise ValueError("solved source bbox does not match the Source Grid Specification")
    source_extent = validated_grid["footprint_bbox"]
    image_display_extent = _centered_unmasked_square_extent(mask, DPIX)
    image_values = image[~mask]
    image_vmax = max(1.0e-12, float(np.nanpercentile(image_values, 99.5)))
    reg_scale = np.asarray(
        solved.get("reg_scale_image", np.ones_like(solved["source_image"])), dtype=float,
    )
    rho = float(solved.get("adaptive_reg_rho", 0.0))
    is_adaptive = bool(solved.get("adaptive_regularization", False))
    reg_title = (
        f"regularization scale (adaptive, rho={rho:.2f})"
        if is_adaptive
        else "regularization scale (uniform, scale=1)"
    )

    fig, axes = plt.subplots(1, 5, figsize=(21, 4.2), constrained_layout=True)
    panels = (
        (np.ma.array(image, mask=mask), "lens-subtracted data", PLOT_CMAP_IMAGE, (0, image_vmax), image_extent),
        (np.ma.array(model, mask=mask), "pixelized model", PLOT_CMAP_IMAGE, (0, image_vmax), image_extent),
        (np.ma.array(residual, mask=mask), "normalized residual", PLOT_CMAP_RESIDUAL, (-3, 3), image_extent),
        (solved["source_image"], "source reconstruction", PLOT_CMAP_IMAGE, None, source_extent),
        (reg_scale, reg_title, PLOT_CMAP_IMAGE, (1.0, max(1.0, float(np.nanmax(reg_scale)))), source_extent),
    )
    for index, (axis, (values, title, cmap, limits, extent)) in enumerate(zip(axes, panels)):
        kwargs = {"origin": "lower", "cmap": cmap, "extent": extent}
        if limits is not None:
            kwargs.update(vmin=limits[0], vmax=limits[1])
        image_artist = axis.imshow(values, **kwargs)
        axis.set_title(title)
        axis.set_xlabel("arcsec")
        axis.set_aspect("equal")
        if index < 3:
            axis.set_xlim(image_display_extent[0], image_display_extent[1])
            axis.set_ylim(image_display_extent[2], image_display_extent[3])
            _set_equal_tick_count(axis, image_display_extent)
        else:
            _set_equal_tick_count(axis, source_extent)
        colorbar_kwargs = {"label": r"$\lambda_i / \lambda_{\rm global}$"} if index == 4 else {}
        fig.colorbar(image_artist, ax=axis, fraction=0.046, pad=0.04, **colorbar_kwargs)
    axes[0].set_ylabel("arcsec")
    # Match the parameter vector used for the source/model reconstruction.
    # _solve_source has already exited its temporary parameter context.
    with ck.ActiveContext(likelihood):
        likelihood.fill_params(jnp.asarray([medians[name] for name in names]))
        overlay_critical_and_caustics(
            image_axes=[axes[0], axes[1]],
            source_ax=axes[3],
            lens_mass=likelihood.phys_model,
            x_range=(-MASK_RADIUS, MASK_RADIUS),
            y_range=(-MASK_RADIUS, MASK_RADIUS),
        )
    for axis in axes[3:]:
        axis.set_xlim(source_extent[0], source_extent[1])
        axis.set_ylim(source_extent[2], source_extent[3])
    if subhalo_marker:
        for axis in axes[:3]:
            axis.plot(medians["center_x_subhalo"], medians["center_y_subhalo"],
                      marker="*", color="cyan", markeredgecolor="black", ms=12,
                      linestyle="none", label="SIS posterior median")
        axes[1].legend(loc="best")
        tag += f"; SIS theta_E = {medians['theta_E_subhalo']:.4f} arcsec"
    fig.suptitle(tag)
    fig.savefig(target, dpi=140)
    plt.close(fig)


def _plot_source_grid_review(
    solved: dict[str, Any], source_grid: dict[str, Any], target: Path,
) -> None:
    source = np.asarray(solved["source_image"], dtype=float)
    grid = validate_source_grid_spec(source_grid, source_shape=source.shape)
    extent = grid["footprint_bbox"]
    finite = source[np.isfinite(source)]
    signed_limit = (
        max(1.0e-12, float(np.nanpercentile(np.abs(finite), 99.5)))
        if finite.size else 1.0
    )
    positive = np.maximum(source, 0.0)
    positive_finite = positive[np.isfinite(positive) & (positive > 0)]
    asinh_scale = (
        max(1.0e-12, float(np.nanpercentile(positive_finite, 75.0)))
        if positive_finite.size else 1.0
    )
    stretched = np.arcsinh(positive / asinh_scale)
    diagnostics = _source_sign_diagnostics(source, solved["source_bbox"])

    fig, axes = plt.subplots(1, 3, figsize=(14.5, 4.8), constrained_layout=True)
    panels = (
        (source, "signed source (linear)", "RdBu_r", -signed_limit, signed_limit),
        (stretched, "positive source (asinh)", PLOT_CMAP_IMAGE, 0.0, None),
    )
    for axis, (values, title, cmap, vmin, vmax) in zip(axes[:2], panels):
        artist = axis.imshow(
            values, origin="lower", extent=extent, cmap=cmap, vmin=vmin, vmax=vmax,
        )
        axis.set_title(title)
        axis.set_xlabel("arcsec")
        axis.set_ylabel("arcsec")
        axis.set_aspect("equal")
        axis.set_xlim(extent[0], extent[1])
        axis.set_ylim(extent[2], extent[3])
        _set_equal_tick_count(axis, extent)
        inset = 2.0 * grid["pixel_scale_arcsec"]
        axis.add_patch(
            plt.Rectangle(
                (extent[0] + inset, extent[2] + inset),
                (extent[1] - extent[0]) - 2.0 * inset,
                (extent[3] - extent[2]) - 2.0 * inset,
                fill=False, edgecolor="cyan", linewidth=1.2, linestyle="--",
            )
        )
        fig.colorbar(artist, ax=axis, fraction=0.046, pad=0.04)

    edge_by_side = diagnostics.get("positive_flux_fraction_by_bbox_edge", {})
    ring_by_side = diagnostics.get(
        "positive_flux_fraction_by_outer_two_pixel_side", {}
    )
    axes[2].axis("off")
    axes[2].text(
        0.02,
        0.98,
        "\n".join((
            "M0 Source Grid Sufficiency",
            f"grid level: {grid['grid_level']}",
            f"half-width: {grid['half_width_arcsec']:.2f} arcsec",
            f"grid: {grid['nsrc']} x {grid['nsrc']}",
            f"pixel scale: {grid['pixel_scale_arcsec']:.3f} arcsec",
            "cyan dashed line: inner edge of outer two-pixel ring",
            f"positive flux at edge: {diagnostics['positive_flux_fraction_at_bbox_edge']}",
            f"negative flux at edge: {diagnostics['negative_flux_fraction_at_bbox_edge']}",
            f"positive flux in outer 2 px: {diagnostics['positive_flux_fraction_in_outer_two_pixel_ring']}",
            f"negative flux in outer 2 px: {diagnostics['negative_flux_fraction_in_outer_two_pixel_ring']}",
            "positive flux by edge:",
            *(f"  {name}: {edge_by_side.get(name)}" for name in ("top", "bottom", "left", "right")),
            "positive flux by outer 2 px side:",
            *(f"  {name}: {ring_by_side.get(name)}" for name in ("top", "bottom", "left", "right")),
        )),
        transform=axes[2].transAxes,
        ha="left",
        va="top",
        fontsize=11,
        linespacing=1.35,
    )
    fig.savefig(target, dpi=160)
    plt.close(fig)


def _save_grid_stage(log_z: float, extra: dict[str, Any]) -> None:
    payload = {
        "samples": None, "weights": None, "param_names": ["log_lambda_reg"],
        "log_z": float(log_z), "stage_schema": {"param_names": ["log_lambda_reg"]},
        "extra": {**extra, "input_geometry": _input_geometry_metadata()},
    }
    with (OUT_DIR / "stage_m0.pkl").open("wb") as handle:
        pickle.dump(payload, handle)


def run_stage_m0(
    image, noise, psf, feature_mask, lens_light_model, stage_a,
    position_likelihood, source_grid_anchor, circular_mask=None,
):
    started = time.monotonic()
    source_grid = _grid_from_anchor(source_grid_anchor)
    mass, shear = _fixed_sie(stage_a)
    log_lambda = ParamU(
        "log_lambda_reg", 0.0, prior_type="uniform",
        prior_settings=[-13.815510557964274, 13.815510557964274],
        limits=[-13.815510557964274, 13.815510557964274],
    )
    log_lambda.to_dynamic()
    source = PixelizedSourceModel(
        n=source_grid["nsrc"], log_lambda_reg=log_lambda,
        regularization_type=REGULARIZATION_TYPE,
    )
    likelihood = _pixel_likelihood(
        image - lens_light_model, noise, psf, feature_mask, circular_mask,
        (mass, shear), source, position_likelihood,
        fixed_source_bbox=_pixel_center_bbox(source_grid),
    )
    evaluate = make_likelihood(likelihood, vectorized=True)
    coarse = jnp.linspace(_CONFIG.m0_log_lam_min, _CONFIG.m0_log_lam_max, _CONFIG.m0_n_grid)
    coarse_ev = np.asarray(evaluate(coarse.reshape(-1, 1)), dtype=float)
    if not np.isfinite(coarse_ev).any():
        raise RuntimeError("M0 coarse evidence grid contains no finite values")
    coarse_index = int(np.nanargmax(coarse_ev))
    half_width = 0.5 * np.log(10.0)
    fine = jnp.linspace(
        float(coarse[coarse_index]) - half_width,
        float(coarse[coarse_index]) + half_width,
        _CONFIG.m0_n_grid,
    )
    fine_ev = np.asarray(evaluate(fine.reshape(-1, 1)), dtype=float)
    if not np.isfinite(fine_ev).any():
        raise RuntimeError("M0 fine evidence grid contains no finite values")
    fine_index = int(np.nanargmax(fine_ev))
    best = float(fine[fine_index])
    best_ev = float(fine_ev[fine_index])
    extra = {
        "m0_mass_model": "SIE+Shear",
        "log_lambda_best": best,
        "evidence_lambda_best": float(np.exp(best)),
        "evidence_log_lambda_best": best,
        "lambda_grid_coarse": np.asarray(coarse), "log_ev_coarse": coarse_ev,
        "lambda_grid_fine": np.asarray(fine), "log_ev_fine": fine_ev,
        "time_taken": time.monotonic() - started,
    }
    solved = _solve_source(likelihood, {"log_lambda_reg": best}, ["log_lambda_reg"])
    validate_source_grid_spec(source_grid, source_shape=solved["source_image"].shape)
    extra.update(_pixelized_scientific_diagnostics(likelihood, solved))
    _save_grid_stage(best_ev, extra)
    _write_source_grid_spec(source_grid)
    _plot_pixel_stage(
        "Stage M0", likelihood, solved, DIAGNOSTICS_DIR / "stage_m0_model.png",
        source_grid, medians={"log_lambda_reg": best}, names=["log_lambda_reg"],
    )
    _plot_source_grid_review(
        solved, source_grid, DIAGNOSTICS_DIR / "stage_m0_source_grid.png"
    )
    return best


def run_stage_m1(
    image, noise, psf, feature_mask, lens_light_model, stage_a,
    position_likelihood, log_lambda_fixed, source_grid, circular_mask=None,
):
    started = time.monotonic()
    source_grid = _validate_runtime_source_grid(source_grid)
    mass, shear = _free_sie(stage_a)
    log_lambda = ParamU(
        "log_lambda_reg", float(log_lambda_fixed), prior_type="truncated_gaussian",
        prior_settings=[float(log_lambda_fixed), 0.15],
        limits=[float(log_lambda_fixed) - 0.5, float(log_lambda_fixed) + 0.5],
    )
    log_lambda.to_dynamic()
    source = PixelizedSourceModel(
        n=source_grid["nsrc"], log_lambda_reg=log_lambda,
        regularization_type=REGULARIZATION_TYPE,
    )
    likelihood = _pixel_likelihood(
        image - lens_light_model, noise, psf, feature_mask, circular_mask,
        (mass, shear), source, position_likelihood,
        fixed_source_bbox=_pixel_center_bbox(source_grid),
    )
    stage = _sample(likelihood, n_live=_CONFIG.stage_m1_n_live, n_eff=_CONFIG.stage_m1_n_eff)
    medians = stage.medians()
    solved = _solve_source(likelihood, medians, stage.param_names)
    s1_package = {
        key: value
        for key, value in solved.items()
        if key not in {"reg_scale_image", "adaptive_reg_rho", "adaptive_regularization"}
    }
    s1_package.update(
        lambda_best=float(np.exp(medians["log_lambda_reg"])),
        log_lambda_best=float(medians["log_lambda_reg"]),
        stage_m1_medians=dict(medians),
    )
    _validate_source_template_package(
        s1_package, source_grid
    )
    diagnostics = _pixelized_scientific_diagnostics(likelihood, solved)
    _save_stage("m1", stage, {
        "medians": medians, "m1_mass_model": "SIE+Shear", "s1": s1_package,
        **diagnostics,
        "time_taken": time.monotonic() - started,
    })
    _plot_pixel_stage(
        "Stage M1", likelihood, solved, DIAGNOSTICS_DIR / "stage_m1_model.png",
        source_grid, medians=medians, names=stage.param_names,
    )
    return stage, medians, s1_package


def run_stage_m2(
    image, noise, psf, feature_mask, lens_light_model, medians_m1,
    position_likelihood, s1_package, source_grid, circular_mask=None,
):
    started = time.monotonic()
    source_grid = _validate_runtime_source_grid(source_grid)
    mass, shear = _fixed_sie_from_medians(medians_m1)
    log_lambda = ParamU(
        "log_lambda_reg", float(s1_package["log_lambda_best"]),
        prior_type="uniform", prior_settings=[-13.815510557964274, 13.815510557964274],
        limits=[-13.815510557964274, 13.815510557964274],
    )
    rho = ParamU(
        "adaptive_reg_rho", 2.0, prior_type="uniform",
        prior_settings=[0.0, _CONFIG.adaptive_reg_rho_prior_max],
        limits=[0.0, _CONFIG.adaptive_reg_rho_prior_max],
    )
    log_lambda.to_dynamic()
    rho.to_dynamic()
    source = PixelizedSourceModel(
        n=source_grid["nsrc"], log_lambda_reg=log_lambda,
        regularization_type=REGULARIZATION_TYPE, adaptive_reg_rho=rho,
    )
    likelihood = _pixel_likelihood(
        image - lens_light_model, noise, psf, feature_mask, circular_mask,
        (mass, shear), source, position_likelihood,
        **_fixed_source_template_kwargs(s1_package, source_grid),
    )
    stage = _sample(likelihood, n_live=_CONFIG.stage_m2_n_live, n_eff=_CONFIG.stage_m2_n_eff)
    medians = stage.medians()
    solved = _solve_source(likelihood, medians, stage.param_names)
    reg = {
        "log_lambda_reg": float(medians["log_lambda_reg"]),
        "adaptive_reg_rho": float(medians["adaptive_reg_rho"]),
    }
    diagnostics = _pixelized_scientific_diagnostics(likelihood, solved)
    _save_stage("m2", stage, {
        "medians": medians, "m2_mass_model": "SIE+Shear",
        "mass_medians_fixed": dict(medians_m1),
        "reg_hyperparams": reg, **diagnostics,
        "time_taken": time.monotonic() - started,
    })
    _plot_pixel_stage(
        "Stage M2", likelihood, solved, DIAGNOSTICS_DIR / "stage_m2_model.png",
        source_grid, medians=medians, names=stage.param_names,
    )
    return stage, medians, reg


def _reg_hyperparams_from_m2_payload(payload: dict[str, Any]) -> dict[str, float]:
    medians = payload["extra"]["medians"]
    return {
        "log_lambda_reg": float(medians["log_lambda_reg"]),
        "adaptive_reg_rho": float(medians["adaptive_reg_rho"]),
    }


def run_stage_m3(
    image, noise, psf, feature_mask, lens_light_model, stage_m1, stage_a,
    position_likelihood, reg_hyperparams_fixed, s1_package, source_grid,
    circular_mask=None,
):
    started = time.monotonic()
    source_grid = _validate_runtime_source_grid(source_grid)
    mass, shear = _free_epl(stage_m1, stage_a)
    log_lambda = ParamU("log_lambda_reg", reg_hyperparams_fixed["log_lambda_reg"])
    rho = ParamU("adaptive_reg_rho", reg_hyperparams_fixed["adaptive_reg_rho"])
    log_lambda.to_static()
    rho.to_static()
    source = PixelizedSourceModel(
        n=source_grid["nsrc"], log_lambda_reg=log_lambda,
        regularization_type=REGULARIZATION_TYPE, adaptive_reg_rho=rho,
    )
    likelihood = _pixel_likelihood(
        image - lens_light_model, noise, psf, feature_mask, circular_mask,
        (mass, shear), source, position_likelihood,
        **_fixed_source_template_kwargs(s1_package, source_grid),
    )
    stage = _sample(likelihood, n_live=_CONFIG.stage_m3_n_live, n_eff=_CONFIG.stage_m3_n_eff)
    medians = stage.medians()
    solved = _solve_source(likelihood, medians, stage.param_names)
    diagnostics = _pixelized_scientific_diagnostics(likelihood, solved)
    _save_stage("m3", stage, {
        "medians": medians, "m3_mass_model": "EPL+Shear",
        "reg_hyperparams_fixed": dict(reg_hyperparams_fixed),
        **diagnostics,
        "time_taken": time.monotonic() - started,
    })
    _plot_pixel_stage(
        "Stage M3", likelihood, solved, DIAGNOSTICS_DIR / "stage_m3_model.png",
        source_grid, medians=medians, names=stage.param_names,
    )
    return stage, medians
