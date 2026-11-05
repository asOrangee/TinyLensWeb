from typing import Any

import pytest
from pydantic import ValidationError

from lens_agent.inspector_decision import InspectorDecision


def model_decision() -> dict[str, Any]:
    return {
        "lens_id": "lens-001",
        "disposition": "model",
        "contaminant_ids": [],
        "reason": "one coherent simple lens",
        "theta_E_hint": {
            "estimate_arcsec": 1.35,
            "plausible_range_arcsec": [1.05, 1.7],
            "confidence": "medium",
            "deflector_center": {"dra_arcsec": 0.08, "ddec_arcsec": -0.04},
            "basis": "a secure tangential arc anchors the scale",
        },
    }


def test_model_inspector_decision_requires_a_complete_theta_e_hint() -> None:
    with pytest.raises(ValidationError, match="theta_E_hint"):
        InspectorDecision.model_validate(
            {
                "lens_id": "lens-001",
                "disposition": "model",
                "contaminant_ids": [],
                "reason": "one coherent simple lens",
                "theta_E_hint": None,
            },
            strict=True,
        )


def test_theta_e_plausible_range_must_contain_the_estimate() -> None:
    raw = model_decision()
    raw["theta_E_hint"] = {
        **raw["theta_E_hint"],
        "plausible_range_arcsec": [1.4, 1.7],
    }

    with pytest.raises(ValidationError, match="must contain estimate"):
        InspectorDecision.model_validate(raw, strict=True)


def test_contaminant_ids_must_be_sorted_unique_positive_integers() -> None:
    raw = model_decision()
    raw["contaminant_ids"] = [2, 1, 2]

    with pytest.raises(ValidationError, match="sorted and unique"):
        InspectorDecision.model_validate(raw, strict=True)
