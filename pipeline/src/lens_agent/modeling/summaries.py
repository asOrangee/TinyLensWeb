from __future__ import annotations

from typing import Any

import numpy as np


NEAR_BOUNDARY_REFERENCE_FRACTION = 0.01
SCIENTIFIC_DIAGNOSTIC_KEYS = (
    "source_sign_diagnostics",
    "residual_diagnostics",
)


def _weighted_quantiles(
    values: np.ndarray, probability: np.ndarray
) -> tuple[float, float, float]:
    order = np.argsort(values)
    sorted_values = values[order]
    cumulative = np.cumsum(probability[order])
    return tuple(
        float(value)
        for value in np.interp((0.16, 0.5, 0.84), cumulative, sorted_values)
    )


def _prior_specs_by_name(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    specs = payload.get("stage_schema", {}).get("prior_specs", [])
    return {
        str(spec["name"]): spec
        for spec in specs
        if isinstance(spec, dict) and spec.get("name") is not None
    }


def _prior_boundary_diagnostic(
    values: np.ndarray,
    probability: np.ndarray,
    quantiles: tuple[float, float, float],
    spec: dict[str, Any],
) -> dict[str, Any] | None:
    limits = spec.get("limits")
    if not isinstance(limits, (list, tuple)) or len(limits) != 2:
        return None
    lower, upper = (float(limits[0]), float(limits[1]))
    prior_width = upper - lower
    if not np.isfinite([lower, upper, prior_width]).all() or prior_width <= 0:
        return None
    q16, q50, q84 = quantiles
    posterior_width = q84 - q16
    quantile_distances: dict[str, dict[str, float | None]] = {}
    for label, value in zip(("q16", "q50", "q84"), quantiles):
        to_lower = value - lower
        to_upper = upper - value
        nearest = min(to_lower, to_upper)
        quantile_distances[label] = {
            "value": value,
            "to_lower_limit": to_lower,
            "to_upper_limit": to_upper,
            "to_nearest_limit": nearest,
            "nearest_over_posterior_width": (
                nearest / posterior_width if posterior_width > 0 else None
            ),
            "nearest_over_prior_width": nearest / prior_width,
        }
    reference_width = NEAR_BOUNDARY_REFERENCE_FRACTION * prior_width
    return {
        "prior_type": spec.get("prior_type"),
        "prior_limits": {"lower": lower, "upper": upper},
        "posterior_width_q16_q84": posterior_width,
        "prior_width": prior_width,
        "near_boundary_reference_fraction_of_prior_width": (
            NEAR_BOUNDARY_REFERENCE_FRACTION
        ),
        "posterior_mass_near_lower_limit": float(
            probability[values <= lower + reference_width].sum()
        ),
        "posterior_mass_near_upper_limit": float(
            probability[values >= upper - reference_width].sum()
        ),
        "quantile_distances": quantile_distances,
    }


def _visual_prior_conflict_diagnostics(
    values: np.ndarray,
    probability: np.ndarray,
    names: list[str],
    provenance: dict[str, Any],
) -> dict[str, float] | None:
    if not provenance.get("eligible") or "theta_E" not in names:
        return None
    hint = provenance.get("theta_E_hint", {})
    prior = provenance.get("effective_prior", {})
    settings = prior.get("prior_settings", [])
    plausible_range = hint.get("plausible_range_arcsec", [])
    if len(settings) < 2 or len(plausible_range) != 2:
        return None
    estimate = float(hint["estimate_arcsec"])
    sigma = float(settings[1])
    lower, upper = (float(plausible_range[0]), float(plausible_range[1]))
    column = values[:, names.index("theta_E")]
    median = _weighted_quantiles(column, probability)[1]
    difference = median - estimate
    return {
        "posterior_median_arcsec": median,
        "hint_estimate_arcsec": estimate,
        "core_sigma_arcsec": sigma,
        "median_minus_hint_arcsec": difference,
        "median_minus_hint_in_core_sigma": difference / sigma,
        "posterior_mass_in_plausible_range": float(
            probability[(column >= lower) & (column <= upper)].sum()
        ),
        "posterior_mass_within_one_core_sigma": float(
            probability[np.abs(column - estimate) <= sigma].sum()
        ),
    }


def stage_summary(
    payload: dict[str, Any],
    stage: str,
    *,
    visual_prior_provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    samples = payload.get("samples")
    weights = payload.get("weights")
    names = list(payload.get("param_names", []))
    extra = payload.get("extra", {})
    summary: dict[str, Any] = {
        "stage": stage,
        "exists": True,
        "score_name": "log_ev" if stage == "m0" else "log_z",
        "score_value": float(payload["log_z"]),
        "n_samples": int(len(samples)) if samples is not None else None,
        "posterior_quantiles": {},
        "prior_boundary_diagnostics": {},
        "summary_warnings": [],
    }
    for key in SCIENTIFIC_DIAGNOSTIC_KEYS:
        if key in extra:
            summary[key] = extra[key]
    if samples is None or weights is None:
        if stage == "m0":
            coarse = np.asarray(extra.get("log_ev_coarse", []), dtype=float)
            fine = np.asarray(extra.get("log_ev_fine", []), dtype=float)
            coarse_index = int(np.nanargmax(coarse)) if coarse.size else -1
            fine_index = int(np.nanargmax(fine)) if fine.size else -1
            summary["m0_lambda_search"] = {
                "log_lambda_best": float(extra["log_lambda_best"]),
                "lambda_best": float(extra["evidence_lambda_best"]),
                "coarse_grid_size": int(coarse.size),
                "fine_grid_size": int(fine.size),
                "coarse_best_index": coarse_index,
                "fine_best_index": fine_index,
                "coarse_grid_best_at_edge": coarse_index in {0, coarse.size - 1},
                "fine_grid_best_at_edge": fine_index in {0, fine.size - 1},
            }
        return summary
    values = np.asarray(samples, dtype=float)
    probability = np.asarray(weights, dtype=float)
    probability /= probability.sum()
    summary["sampling"] = {
        "method": "nautilus",
        "observed_sample_count": int(len(values)),
        "effective_sample_size_from_weights": float(1.0 / np.square(probability).sum()),
        "posterior_pathology_flags": [],
    }
    prior_specs = _prior_specs_by_name(payload)
    for index, name in enumerate(names):
        column = values[:, index]
        q16, q50, q84 = _weighted_quantiles(column, probability)
        summary["posterior_quantiles"][name] = {
            "q16": q16, "q50": q50, "q84": q84
        }
        if name in prior_specs:
            diagnostic = _prior_boundary_diagnostic(
                column, probability, (q16, q50, q84), prior_specs[name]
            )
            if diagnostic is not None:
                summary["prior_boundary_diagnostics"][name] = diagnostic
    if stage == "a" and visual_prior_provenance is not None:
        visual_diagnostic = _visual_prior_conflict_diagnostics(
            values, probability, names, visual_prior_provenance
        )
        if visual_diagnostic is not None:
            summary["visual_prior_conflict_diagnostics"] = visual_diagnostic
    return summary
