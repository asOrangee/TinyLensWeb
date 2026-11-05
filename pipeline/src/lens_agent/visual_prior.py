from __future__ import annotations

from typing import Any

from .configuration import PipelineConfig, PriorConfig
from .inspector_decision import InspectorDecision


VISUAL_PRIOR_RULE_VERSION = "visual_theta_E_mixture.v1"
VISUAL_PRIOR_LIMITS = (0.5, 3.0)
VISUAL_PRIOR_CORE_WEIGHT = 0.8
VISUAL_PRIOR_RELATIVE_SIGMA = 0.2
VISUAL_PRIOR_SIGMA_CAP_ARCSEC = 0.2


def _fallback_provenance(
    settings: PipelineConfig,
    decision: InspectorDecision,
    reason: str,
) -> dict[str, Any]:
    hint = decision.theta_E_hint
    if hint is None:
        raise ValueError("visual-prior fallback requires a hint")
    return {
        "schema_version": "visual_prior_provenance.v1",
        "derivation_rule": VISUAL_PRIOR_RULE_VERSION,
        "theta_E_hint": hint.model_dump(mode="json"),
        "eligible": False,
        "effective_prior": settings.stage_a_theta_E_prior.model_dump(mode="json"),
        "theta_E_initial": settings.stage_a_theta_E_initial,
        "fallback_reason": reason,
    }


def derive_stage_a_visual_prior(
    settings: PipelineConfig,
    decision: InspectorDecision,
) -> tuple[PipelineConfig, dict[str, Any]]:
    hint = decision.theta_E_hint
    if decision.disposition != "model" or hint is None:
        raise ValueError("Stage A visual-prior derivation requires a model decision with a hint")
    estimate = hint.estimate_arcsec
    if hint.confidence not in {"high", "medium"}:
        return settings, _fallback_provenance(settings, decision, "low_confidence")
    lower, upper = VISUAL_PRIOR_LIMITS
    if not lower <= estimate <= upper:
        return settings, _fallback_provenance(
            settings, decision, "hint_outside_supported_prior"
        )
    sigma = min(VISUAL_PRIOR_RELATIVE_SIGMA * estimate, VISUAL_PRIOR_SIGMA_CAP_ARCSEC)
    prior = PriorConfig(
        prior_type="truncated_gaussian_uniform_mixture",
        prior_settings=[estimate, sigma, VISUAL_PRIOR_CORE_WEIGHT],
        limits=[lower, upper],
    )
    derived = settings.model_copy(
        update={
            "stage_a_theta_E_prior": prior,
            "stage_a_theta_E_initial": estimate,
        }
    )
    provenance = {
        "schema_version": "visual_prior_provenance.v1",
        "derivation_rule": VISUAL_PRIOR_RULE_VERSION,
        "theta_E_hint": hint.model_dump(mode="json"),
        "eligible": True,
        "effective_prior": prior.model_dump(mode="json"),
        "theta_E_initial": estimate,
        "fallback_reason": None,
    }
    return derived, provenance
