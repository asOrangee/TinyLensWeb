import pytest

from lens_agent.configuration import PipelineConfig
from lens_agent.inspector_decision import InspectorDecision
from lens_agent.visual_prior import derive_stage_a_visual_prior


def decision(*, estimate: float = 1.35, confidence: str = "medium") -> InspectorDecision:
    return InspectorDecision.model_validate(
        {
            "lens_id": "lens-001",
            "disposition": "model",
            "contaminant_ids": [],
            "reason": "one coherent simple lens",
            "theta_E_hint": {
                "estimate_arcsec": estimate,
                "plausible_range_arcsec": [max(0.1, estimate - 0.3), estimate + 0.3],
                "confidence": confidence,
                "deflector_center": {"dra_arcsec": 0.0, "ddec_arcsec": 0.0},
                "basis": "secure tangential image family",
            },
        },
        strict=True,
    )


@pytest.mark.parametrize(
    ("estimate", "expected_sigma"),
    [
        (0.5, 0.1),
        (0.75, 0.15),
        (1.0, 0.2),
        (1.35, 0.2),
        (3.0, 0.2),
    ],
)
def test_eligible_hint_caps_the_visual_prior_core_width(
    estimate: float,
    expected_sigma: float,
) -> None:
    settings, provenance = derive_stage_a_visual_prior(
        PipelineConfig(), decision(estimate=estimate)
    )

    prior = settings.stage_a_theta_E_prior.model_dump(mode="json")
    assert prior["prior_type"] == "truncated_gaussian_uniform_mixture"
    assert prior["prior_settings"] == pytest.approx([estimate, expected_sigma, 0.8])
    assert prior["limits"] == [0.5, 3.0]
    assert settings.stage_a_theta_E_initial == estimate
    assert provenance["eligible"] is True
    assert provenance["fallback_reason"] is None


def test_low_confidence_hint_keeps_the_baseline_uniform_prior() -> None:
    baseline = PipelineConfig()
    settings, provenance = derive_stage_a_visual_prior(
        baseline, decision(confidence="low")
    )

    assert settings.stage_a_theta_E_prior == baseline.stage_a_theta_E_prior
    assert settings.stage_a_theta_E_initial == 1.5
    assert provenance["eligible"] is False
    assert provenance["fallback_reason"] == "low_confidence"


def test_out_of_support_hint_is_not_clipped_and_keeps_uniform_prior() -> None:
    baseline = PipelineConfig()
    settings, provenance = derive_stage_a_visual_prior(baseline, decision(estimate=3.2))

    assert settings.stage_a_theta_E_prior == baseline.stage_a_theta_E_prior
    assert provenance["theta_E_hint"]["estimate_arcsec"] == 3.2
    assert provenance["fallback_reason"] == "hint_outside_supported_prior"
