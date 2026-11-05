from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .models import StageName
from .review_vocabulary import BLOCKERS_BY_STAGE, WARNINGS_BY_STAGE


NonEmpty = Annotated[str, Field(min_length=1)]


class _StrictContract(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False)


class Blocker(_StrictContract):
    kind: NonEmpty
    evidence: Annotated[list[NonEmpty], Field(min_length=1)]
    impact: NonEmpty


class HandoffWarning(_StrictContract):
    kind: NonEmpty
    evidence: Annotated[list[NonEmpty], Field(min_length=1)]
    impact: NonEmpty
    expected_resolution_stage: Literal["m0", "m1", "m2", "m3", "final"]


class WarningUpdate(_StrictContract):
    warning_ref: NonEmpty
    status: Literal["resolved", "persisted", "worsened"]
    evidence: Annotated[list[NonEmpty], Field(min_length=1)]


class RepairHypothesis(_StrictContract):
    blocker_kind: str
    expected_improvement: NonEmpty


class RepairProposal(_StrictContract):
    base_config: NonEmpty
    parameter: NonEmpty
    old_value: Any
    new_value: Any


class RetryRepair(_StrictContract):
    hypothesis: RepairHypothesis
    proposal: RepairProposal


class ScientificUncertainty(_StrictContract):
    kind: Literal["source_grid_sufficiency"]
    evidence: Annotated[list[NonEmpty], Field(min_length=1)]
    impact: NonEmpty


class StageReviewResponse(_StrictContract):
    stage: Literal["a", "m1", "m2", "m3"]
    visual_findings: list[NonEmpty]
    numerical_findings: list[NonEmpty]
    progression_blockers: list[Blocker]
    handoff_warnings: list[HandoffWarning]
    upstream_warning_updates: list[WarningUpdate]
    retry_repair: RetryRepair | None
    development_recommendation: NonEmpty | None
    scientific_uncertainty: ScientificUncertainty | None = None
    reason: NonEmpty

    @model_validator(mode="after")
    def validate_stage_vocabulary(self) -> "StageReviewResponse":
        uncertainty_was_submitted = "scientific_uncertainty" in self.model_fields_set
        if self.stage in {"m1", "m3", "subhalo"} and not uncertainty_was_submitted:
            raise ValueError(
                "Stage M1, M3 and subhalo must explicitly report source-grid scientific uncertainty"
            )
        if self.stage not in {"m1", "m3", "subhalo"} and uncertainty_was_submitted:
            raise ValueError("source-grid scientific uncertainty is only valid for Stage M1 or M3 or subhalo")
        invalid_blockers = {
            item.kind for item in self.progression_blockers
        }.difference(BLOCKERS_BY_STAGE[self.stage])
        if invalid_blockers:
            raise ValueError(
                f"blockers are not valid for Stage {self.stage}: "
                f"{sorted(invalid_blockers)}"
            )
        invalid_warnings = {
            item.kind for item in self.handoff_warnings
        }.difference(WARNINGS_BY_STAGE[self.stage])
        if invalid_warnings:
            raise ValueError(
                f"warnings are not valid for Stage {self.stage}: "
                f"{sorted(invalid_warnings)}"
            )
        return self


class SubhaloReviewResponse(StageReviewResponse):
    stage: Literal["subhalo"]
    residual_improved: bool


class ComponentSelection(_StrictContract):
    component_catalog: NonEmpty
    drop_component_ids: list[int]


class PredictedImageDisposition(_StrictContract):
    image_id: NonEmpty
    disposition: Literal[
        "covered_consistent",
        "supported_uncovered",
        "supported_partial",
        "unsupported_prediction",
        "indeterminate",
    ]
    evidence: Annotated[list[NonEmpty], Field(min_length=1)]


class ArcReviewResponse(_StrictContract):
    stage: Literal["b"]
    refinement_kind: Literal[
        "none", "parameters", "selection", "uncertain", "coverage_blocked"
    ]
    predicted_image_dispositions: Annotated[
        list[PredictedImageDisposition], Field(min_length=2)
    ]
    upstream_warning_updates: list[WarningUpdate]
    retry_repair: RetryRepair | None
    component_selection: ComponentSelection | None
    development_recommendation: NonEmpty | None
    reason: NonEmpty

    @model_validator(mode="after")
    def validate_branch(self) -> "ArcReviewResponse":
        dispositions = {item.disposition for item in self.predicted_image_dispositions}
        if self.refinement_kind == "none":
            valid = (
                self.retry_repair is None
                and self.component_selection is None
                and self.development_recommendation is None
                and dispositions == {"covered_consistent"}
            )
        elif self.refinement_kind == "uncertain":
            valid = (
                self.retry_repair is None and self.component_selection is None
                and bool(dispositions & {"unsupported_prediction", "indeterminate"})
            )
        elif self.refinement_kind == "coverage_blocked":
            valid = (
                self.retry_repair is None
                and self.component_selection is None
                and bool(dispositions & {"supported_uncovered", "supported_partial"})
                and dispositions <= {
                    "covered_consistent", "supported_uncovered", "supported_partial"
                }
            )
        elif self.refinement_kind == "parameters":
            valid = (
                self.retry_repair is not None
                and self.component_selection is None
                and self.development_recommendation is None
                and bool(dispositions & {"supported_uncovered", "supported_partial"})
                and dispositions <= {
                    "covered_consistent", "supported_uncovered", "supported_partial"
                }
            )
        elif self.refinement_kind == "selection":
            valid = (
                self.retry_repair is None
                and self.component_selection is not None
                and self.development_recommendation is None
                and dispositions == {"covered_consistent"}
            )
        else:
            valid = False
        if not valid:
            raise ValueError("Stage-B refinement payload is inconsistent")
        return self


class M0GridReviewResponse(_StrictContract):
    stage: Literal["m0"]
    grid_judgment: Literal[
        "grid_sufficient", "source_bbox_truncation", "indeterminate"
    ]
    visual_findings: list[NonEmpty]
    numerical_findings: list[NonEmpty]
    reason: NonEmpty


def validate_reviewer_response(raw: Any, stage: StageName) -> dict[str, Any]:
    model: StageReviewResponse | ArcReviewResponse | M0GridReviewResponse
    if stage == StageName.SUBHALO:
        model = SubhaloReviewResponse.model_validate(raw, strict=True)
    elif stage == StageName.B:
        model = ArcReviewResponse.model_validate(raw, strict=True)
    elif stage == StageName.M0:
        model = M0GridReviewResponse.model_validate(raw, strict=True)
    elif stage in {StageName.A, StageName.M1, StageName.M2, StageName.M3}:
        model = StageReviewResponse.model_validate(raw, strict=True)
    else:
        raise ValueError(f"stage {stage.value} has no reviewer response contract")
    if model.stage != stage.value:
        raise ValueError("review stage does not match attempt stage")
    return model.model_dump(mode="json", exclude_unset=True)
