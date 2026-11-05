import pytest

from lens_agent.contracts import validate_reviewer_response
from lens_agent.models import StageName


def test_stage_a_review_accepts_visual_prior_conflict_as_a_handoff_warning() -> None:
    raw = {
        "stage": "a",
        "visual_findings": ["the principal image family is reproduced"],
        "numerical_findings": ["posterior lies outside the visual core"],
        "progression_blockers": [],
        "handoff_warnings": [
            {
                "kind": "visual_prior_conflict",
                "evidence": ["posterior mass is low inside the plausible visual range"],
                "impact": "retain the discrepancy for downstream review",
                "expected_resolution_stage": "m1",
            }
        ],
        "upstream_warning_updates": [],
        "retry_repair": None,
        "development_recommendation": None,
        "reason": "visual disagreement alone does not block progression",
    }

    validated = validate_reviewer_response(raw, StageName.A)

    assert validated["handoff_warnings"][0]["kind"] == "visual_prior_conflict"


def test_python_contract_rejects_vocabulary_owned_by_another_stage() -> None:
    raw = {
        "stage": "a",
        "visual_findings": ["the principal image family is reproduced"],
        "numerical_findings": ["sampling diagnostics are stable"],
        "progression_blockers": [],
        "handoff_warnings": [
            {
                "kind": "source_clumpiness",
                "evidence": ["the source has multiple supported peaks"],
                "impact": "preserve the morphology for M2 review",
                "expected_resolution_stage": "m2",
            }
        ],
        "upstream_warning_updates": [],
        "retry_repair": None,
        "development_recommendation": None,
        "reason": "the result is otherwise safe for progression",
    }

    with pytest.raises(ValueError, match="not valid for Stage a"):
        validate_reviewer_response(raw, StageName.A)


@pytest.mark.parametrize(
    "judgment",
    ["grid_sufficient", "source_bbox_truncation", "indeterminate"],
)
def test_m0_grid_review_accepts_only_the_three_grid_judgments(judgment: str) -> None:
    raw = {
        "stage": "m0",
        "grid_judgment": judgment,
        "visual_findings": ["the source-grid edge was inspected"],
        "numerical_findings": ["edge-flux diagnostics were considered"],
        "reason": "the judgment follows the source-grid criterion",
    }

    assert validate_reviewer_response(raw, StageName.M0) == raw


def test_m0_grid_review_rejects_generic_retry_fields() -> None:
    raw = {
        "stage": "m0",
        "grid_judgment": "source_bbox_truncation",
        "visual_findings": ["coherent emission is clipped"],
        "numerical_findings": [],
        "reason": "the grid is too small",
        "retry_repair": {"proposal": {"new_value": 1.0}},
    }

    with pytest.raises(ValueError, match="Extra inputs"):
        validate_reviewer_response(raw, StageName.M0)


@pytest.mark.parametrize("stage", [StageName.M1, StageName.M3])
def test_late_pixel_stage_can_report_source_grid_scientific_uncertainty(
    stage: StageName,
) -> None:
    raw = {
        "stage": stage.value,
        "visual_findings": ["edge morphology is ambiguous"],
        "numerical_findings": ["edge flux alone is not decisive"],
        "progression_blockers": [],
        "handoff_warnings": [],
        "upstream_warning_updates": [],
        "retry_repair": None,
        "development_recommendation": None,
        "scientific_uncertainty": {
            "kind": "source_grid_sufficiency",
            "evidence": ["cannot distinguish clipping from boundary-only pathology"],
            "impact": "the final source cannot be interpreted safely",
        },
        "reason": "human scientific judgment is required",
    }

    assert validate_reviewer_response(raw, stage)["scientific_uncertainty"] == raw[
        "scientific_uncertainty"
    ]


@pytest.mark.parametrize("stage", [StageName.M1, StageName.M3])
def test_late_pixel_stage_must_explicitly_complete_source_grid_safety_review(
    stage: StageName,
) -> None:
    raw = {
        "stage": stage.value,
        "visual_findings": [],
        "numerical_findings": [],
        "progression_blockers": [],
        "handoff_warnings": [],
        "upstream_warning_updates": [],
        "retry_repair": None,
        "development_recommendation": None,
        "reason": "the review omitted its required source-grid safety result",
    }

    with pytest.raises(ValueError, match="must explicitly report"):
        validate_reviewer_response(raw, stage)


def test_stage_a_cannot_report_source_grid_scientific_uncertainty() -> None:
    raw = {
        "stage": "a",
        "visual_findings": [],
        "numerical_findings": [],
        "progression_blockers": [],
        "handoff_warnings": [],
        "upstream_warning_updates": [],
        "retry_repair": None,
        "development_recommendation": None,
        "scientific_uncertainty": {
            "kind": "source_grid_sufficiency",
            "evidence": ["no pixelized source exists yet"],
            "impact": "not applicable",
        },
        "reason": "invalid stage use",
    }

    with pytest.raises(ValueError, match="only valid for Stage M1 or M3"):
        validate_reviewer_response(raw, StageName.A)
