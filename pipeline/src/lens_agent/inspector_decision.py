from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


PositiveFinite = Annotated[float, Field(gt=0)]
NonEmpty = Annotated[str, Field(min_length=1)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        allow_inf_nan=False,
        frozen=True,
    )


class DeflectorCenter(_StrictModel):
    dra_arcsec: float
    ddec_arcsec: float


class ThetaEHint(_StrictModel):
    estimate_arcsec: PositiveFinite
    plausible_range_arcsec: Annotated[
        list[PositiveFinite], Field(min_length=2, max_length=2)
    ]
    confidence: Literal["high", "medium", "low"]
    deflector_center: DeflectorCenter
    basis: NonEmpty

    @model_validator(mode="after")
    def validate_range(self) -> "ThetaEHint":
        lower, upper = self.plausible_range_arcsec
        if lower > upper:
            raise ValueError("theta_E plausible range lower bound exceeds upper bound")
        if not lower <= self.estimate_arcsec <= upper:
            raise ValueError("theta_E plausible range must contain estimate")
        return self


class InspectorDecision(_StrictModel):
    lens_id: NonEmpty
    disposition: Literal["model", "human_review"]
    contaminant_ids: list[int]
    reason: NonEmpty
    theta_E_hint: ThetaEHint | None

    @model_validator(mode="after")
    def validate_branch(self) -> "InspectorDecision":
        if self.disposition == "model" and self.theta_E_hint is None:
            raise ValueError("model disposition requires theta_E_hint")
        if any(isinstance(value, bool) or value <= 0 for value in self.contaminant_ids):
            raise ValueError("contaminant_ids must be positive integers")
        if self.contaminant_ids != sorted(set(self.contaminant_ids)):
            raise ValueError("contaminant_ids must be sorted and unique")
        return self


def validate_inspector_decision(raw: object, *, expected_lens_id: str) -> dict[str, Any]:
    decision = InspectorDecision.model_validate(raw, strict=True)
    if decision.lens_id != expected_lens_id:
        raise ValueError("inspector lens_id does not match Lens Result Directory")
    return decision.model_dump(mode="json")
