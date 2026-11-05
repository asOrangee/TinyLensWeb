"""Candidate selection and result reporting for the optional local SIS search."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .configuration import EffectiveConfig, validated_run_root
from .models import StageName
from .operations import attempt_lock

POSITION_SIGMA_ARCSEC = 0.2
THETA_E_LIMITS = (0.0, 0.2)
DETECTION_DELTA_LOG_Z = 10.0
EVIDENCE_INTERPRETATION = (
    "Local candidate comparison using M3 posterior-derived macro priors and a "
    "residual-selected position prior; includes the macro-prior change and is "
    "not a blind full-field detection significance."
)


class SubhaloCandidate(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False)
    status: Literal["candidate", "no_candidate"]
    center_x: float | None
    center_y: float | None
    reason: str = Field(min_length=1)

    @model_validator(mode="after")
    def check_position(self):
        present = self.center_x is not None and self.center_y is not None
        absent = self.center_x is None and self.center_y is None
        if not (present if self.status == "candidate" else absent):
            raise ValueError("candidate needs both coordinates; no_candidate needs null coordinates")
        return self


def detection_status(delta_log_z: float, residual_improved: bool) -> str:
    if not math.isfinite(delta_log_z):
        raise ValueError("evidence difference must be finite")
    return ("significant" if residual_improved and delta_log_z >= DETECTION_DELTA_LOG_Z
            else "not_significant")


def _m3_reference(output_dir: Path) -> dict:
    head_path = output_dir / "accepted" / "m3.json"
    head = json.loads(head_path.read_text())
    root = (head_path.parent / head["attempt_path"]).resolve()
    root.relative_to(output_dir)
    from .attempts import validate_decision_review_evidence
    decision = json.loads((root / "decision.json").read_text())
    validate_decision_review_evidence(root, decision)
    result = json.loads((root / "stage-result.json").read_text())
    if (head.get("stage") != "m3" or decision.get("decision") != "accept"
            or result.get("status") != "success" or not result.get("eligible_for_review")
            or result.get("gate_failures")):
        raise ValueError("subhalo search requires an accepted, valid M3")
    return {
        "attempt": root.relative_to(output_dir).as_posix(),
        "posterior_sha256": hashlib.sha256((root / "artifacts/stage_m3.pkl").read_bytes()).hexdigest(),
        "log_z": result["metrics"]["log_z"],
    }


def register_candidate(output_dir: Path, response: Path) -> Path:
    output_dir = validated_run_root(output_dir)
    candidate = SubhaloCandidate.model_validate_json(response.read_text(), strict=True)
    with attempt_lock(output_dir, StageName.SUBHALO, 0):
        reference = _m3_reference(output_dir)
        config = EffectiveConfig.model_validate_json(
            (output_dir / reference["attempt"] / "effective-config.json").read_text(), strict=True
        )
        from .stages import _accepted_upstream_dirs
        _accepted_upstream_dirs(output_dir, StageName.SUBHALO,
                                expected_source_grid_level=config.settings.source_grid_level)
        record = {
            "schema_version": "subhalo_candidate.v1",
            **candidate.model_dump(mode="json"),
            "sigma_x": POSITION_SIGMA_ARCSEC, "sigma_y": POSITION_SIGMA_ARCSEC,
            "theta_E_limits": list(THETA_E_LIMITS),
            "m3": reference,
            "evidence_interpretation": EVIDENCE_INTERPRETATION,
        }
        target = output_dir / "attempts/subhalo/candidate.json"
        if target.exists():
            if json.loads(target.read_text()) != record:
                raise ValueError("subhalo candidate is already locked")
            return target
        if (output_dir / "attempts/subhalo/0/stage-execution.json").exists():
            raise ValueError("cannot choose a candidate after sampling starts")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(record, indent=2) + "\n")
        return target


def load_candidate(output_dir: Path, *, require_candidate: bool = False) -> dict:
    record = json.loads((output_dir / "attempts/subhalo/candidate.json").read_text())
    SubhaloCandidate.model_validate({key: record[key] for key in
                                    ("status", "center_x", "center_y", "reason")}, strict=True)
    if record["m3"] != _m3_reference(output_dir):
        raise ValueError("subhalo candidate no longer references accepted M3")
    # Existing searches retain their recorded priors when read or resumed.
    prior = (record["sigma_x"], record["sigma_y"], tuple(record["theta_E_limits"]))
    if prior not in ((POSITION_SIGMA_ARCSEC, POSITION_SIGMA_ARCSEC, THETA_E_LIMITS),
                     (0.1, 0.1, (0.0, 0.1))):
        raise ValueError("subhalo prior differs from the supported search policies")
    if require_candidate and record["status"] != "candidate":
        raise ValueError("no candidate: subhalo sampling is not requested")
    return record


SUBHALO_SUMMARY_FIELDS = (
    "subhalo_status", "subhalo_log_z_m3", "subhalo_log_z", "subhalo_delta_log_z",
    "subhalo_residual_improved", "theta_E_subhalo", "center_x_subhalo", "center_y_subhalo",
)


def summary_fields(output_dir: Path) -> dict[str, str]:
    fields = dict.fromkeys(SUBHALO_SUMMARY_FIELDS, "")
    stage_root = output_dir / "attempts/subhalo"
    if not stage_root.exists():
        fields["subhalo_status"] = "not_requested"
        return fields
    candidate_path = stage_root / "candidate.json"
    if candidate_path.exists():
        candidate = load_candidate(output_dir)
        if candidate["status"] == "no_candidate":
            fields["subhalo_status"] = "no_candidate"
            return fields
    fields["subhalo_status"] = "incomplete"
    roots = sorted((p for p in stage_root.iterdir() if p.is_dir() and p.name.isdigit()),
                   key=lambda p: int(p.name))
    if not roots:
        return fields
    root = roots[-1]
    decision_path = root / "decision.json"
    decision = json.loads(decision_path.read_text()) if decision_path.exists() else {}
    head_path = output_dir / "accepted/subhalo.json"
    if decision.get("decision") == "human_review":
        fields["subhalo_status"] = "human_review"
    elif head_path.exists():
        head = json.loads(head_path.read_text())
        accepted_root = (head_path.parent / head["attempt_path"]).resolve()
        if accepted_root != root.resolve() or decision.get("decision") != "accept":
            raise ValueError("subhalo accepted head does not match the accepted decision")
        from .attempts import validate_decision_review_evidence
        validate_decision_review_evidence(root, decision)
        fields["subhalo_status"] = decision["subhalo_status"]
        fields["subhalo_residual_improved"] = str(decision["residual_improved"])
    result_path = root / "stage-result.json"
    if result_path.exists():
        metrics = json.loads(result_path.read_text()).get("metrics", {})
        for field, key in (("subhalo_log_z_m3", "log_z_m3"), ("subhalo_log_z", "log_z"),
                           ("subhalo_delta_log_z", "delta_log_z")):
            value = metrics.get(key)
            if value is not None:
                fields[field] = str(value)
        from .cli import _format_posterior
        for name in ("theta_E_subhalo", "center_x_subhalo", "center_y_subhalo"):
            fields[name] = _format_posterior(metrics.get("posterior_quantiles", {}).get(name, {}))
    return fields


def _preview_fingerprint(root: Path) -> dict:
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in ("subhalo-candidate.json", "preview/subhalo_candidate.png")}


def confirm_preview(output_dir: Path) -> Path:
    output_dir = validated_run_root(output_dir)
    with attempt_lock(output_dir, StageName.SUBHALO, 0):
        load_candidate(output_dir, require_candidate=True)
        root = output_dir / "attempts/subhalo/0"
        record = _preview_fingerprint(root)
        target = root / "preview-confirmed.json"
        if target.exists():
            if json.loads(target.read_text()) != record:
                raise ValueError("confirmed preview has changed")
            return target
        if (root / "stage-execution.json").exists():
            raise ValueError("preview must be confirmed before sampling")
        target.write_text(json.dumps(record, indent=2)+"\n")
        return target


def validate_preview_confirmation(root: Path) -> None:
    original = root.parent / "0"
    if json.loads((original / "preview-confirmed.json").read_text()) != _preview_fingerprint(original):
        raise ValueError("candidate preview must be inspected and confirmed before sampling")
    if (root / "subhalo-candidate.json").read_bytes() != (original / "subhalo-candidate.json").read_bytes():
        raise ValueError("retry must preserve the original candidate")
