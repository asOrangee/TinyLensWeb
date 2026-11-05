from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .attempts import (
    CORE_EVIDENCE_FILES,
    attempt_dir,
    manifest_paths,
    validate_decision_review_evidence,
    validate_m0_grid_enlargement,
    validate_retry_review,
    validate_stage_execution,
)
from .configuration import validated_run_root
from .contracts import validate_reviewer_response
from .models import StageName
from .modeling.morphology_audit import validate_stage_b_morphology_audit
from .modeling.predicted_image_family import validate_predicted_image_family
from .review_context import unresolved_warnings


_STAGE_RETRY_LIMIT = 5
_STAGE_B_RETRY_LIMIT = 10
_SHARED_RETRY_LIMIT = 15
_SHARED_RETRY_STAGES = {
    StageName.A,
    StageName.M0,
    StageName.M1,
    StageName.M2,
    StageName.M3,
}
_OPERATIONAL_FAILURE_REASONS = {
    "stage_a_timeout": "Stage A exceeded 1800 seconds",
    "incomplete_stage_execution": (
        "physical stage execution started but produced no complete stage result"
    ),
    "response_contract_failure": (
        "Stage Expert failed the response contract after two corrections"
    ),
}


def _read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def _json_text(value: dict[str, Any]) -> str:
    return json.dumps(value, indent=2) + "\n"


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(_json_text(value), encoding="utf-8")
    os.replace(temporary, path)


def _sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _evidence_snapshot(
    root: Path, *, review: dict[str, Any] | None = None
) -> dict[str, str | None]:
    evidence = {name: _sha256(root / name) for name in CORE_EVIDENCE_FILES}
    if review is not None:
        evidence["review.json"] = hashlib.sha256(
            _json_text(review).encode("utf-8")
        ).hexdigest()
    manifest_path = root / "manifest.json"
    try:
        manifest = _read_object(manifest_path)
    except (OSError, ValueError, json.JSONDecodeError):
        return evidence
    entries = manifest.get("artifacts")
    if not isinstance(entries, list):
        return evidence
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            continue
        reference = entry["path"]
        candidate = (root / reference).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError:
            evidence[f"artifact:{reference}"] = None
        else:
            evidence[f"artifact:{reference}"] = _sha256(candidate)
    return dict(sorted(evidence.items()))


def _register_adjudication(
    root: Path,
    decision: dict[str, Any],
    review: dict[str, Any] | None = None,
) -> Path:
    """Persist one canonical adjudication or accept an identical replay."""
    review_path = root / "review.json"
    decision_path = root / "decision.json"
    existing_review = _read_object(review_path) if review_path.is_file() else None
    existing_decision = _read_object(decision_path) if decision_path.is_file() else None
    if existing_review is not None and existing_review != review:
        raise ValueError("Stage Attempt Record is already adjudicated with another review")
    if existing_decision is not None:
        validate_decision_review_evidence(root, existing_decision)
        if existing_decision != decision or existing_review != review:
            raise ValueError("Stage Attempt Record is already adjudicated with another decision")
        return decision_path
    if review is None and existing_review is not None:
        raise ValueError("operational adjudication conflicts with an existing scientific review")
    if review is not None and existing_review is None:
        _write_json_atomic(review_path, review)
    _write_json_atomic(decision_path, decision)
    return decision_path


def _load_result(root: Path, stage: StageName, attempt: int) -> dict[str, Any]:
    validate_stage_execution(root, stage, attempt)
    result = _read_object(root / "stage-result.json")
    if result.get("stage") != stage.value or result.get("attempt") != attempt:
        raise ValueError("stage result does not identify this review candidate")
    return result


def _passes_hard_gate(result: dict[str, Any]) -> bool:
    return bool(
        result.get("status") == "success"
        and result.get("eligible_for_review") is True
        and not result.get("gate_failures")
    )


def _artifact_gate_failure(root: Path, result: dict[str, Any]) -> str | None:
    try:
        recorded = manifest_paths(root)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return str(error)
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        return "stage result has no required artifact map"
    if any(not isinstance(path, str) for path in artifacts.values()):
        return "stage result has an invalid artifact map"
    required = set(artifacts.values())
    if not required <= recorded:
        return "Attempt Artifact Manifest omits a required stage artifact"
    return None


def _operational_reason(result: dict[str, Any]) -> str:
    failures = result.get("gate_failures")
    if isinstance(failures, list) and failures:
        return "; ".join(str(item) for item in failures)
    return str(result.get("error") or "stage result did not pass the Hard Gate")


def _validate_operational_failure_evidence(
    root: Path, stage: StageName, attempt: int, failure: str
) -> None:
    if failure in {"stage_a_timeout", "incomplete_stage_execution"}:
        if (root / "stage-result.json").exists():
            raise ValueError(
                "incomplete execution failure conflicts with a completed stage result"
            )
        validate_stage_execution(root, stage, attempt)
        return
    result = _load_result(root, stage, attempt)
    if not _passes_hard_gate(result) or _artifact_gate_failure(root, result) is not None:
        raise ValueError(
            "response contract failure requires a review-eligible stage result"
        )


def _consumed_retries(output_dir: Path, stages: set[StageName]) -> int:
    consumed = 0
    for stage in stages:
        stage_root = output_dir / "attempts" / stage.value
        if not stage_root.is_dir():
            continue
        for root in stage_root.iterdir():
            if not root.is_dir() or not root.name.isdigit() or int(root.name) <= 0:
                continue
            proposal_path = root / "proposal-validation.json"
            result_path = root / "stage-result.json"
            if not proposal_path.is_file() or not result_path.is_file():
                continue
            proposal = _read_object(proposal_path)
            result = _read_object(result_path)
            attempt = int(root.name)
            if (
                proposal.get("status") != "valid"
                or proposal.get("stage") != stage.value
                or result.get("stage") != stage.value
                or result.get("attempt") != attempt
            ):
                raise ValueError(
                    f"retry evidence does not identify Stage {stage.value} "
                    f"attempt {attempt}"
                )
            consumed += 1
    return consumed


def _retry_budget_snapshot(
    output_dir: Path, stage: StageName
) -> tuple[dict[str, int], str | None]:
    used = _consumed_retries(output_dir, {stage})
    limit = _STAGE_B_RETRY_LIMIT if stage == StageName.B else _STAGE_RETRY_LIMIT
    if stage == StageName.SUBHALO:
        limit = 2
    snapshot = {"stage_used": used, "stage_limit": limit}
    if used >= limit:
        return snapshot, f"Stage {stage.value} retry budget is exhausted ({used}/{limit})"
    if stage in _SHARED_RETRY_STAGES:
        shared = _consumed_retries(output_dir, _SHARED_RETRY_STAGES)
        snapshot.update(
            shared_used=shared,
            shared_limit=_SHARED_RETRY_LIMIT,
        )
        if shared >= _SHARED_RETRY_LIMIT:
            return snapshot, (
                "shared physical-stage retry budget is exhausted "
                f"({shared}/{_SHARED_RETRY_LIMIT})"
            )
    return snapshot, None


def _warning_snapshot(
    upstream: list[dict[str, Any]],
    review: dict[str, Any],
    stage: StageName,
    attempt: int,
) -> list[dict[str, Any]]:
    updates = review.get("upstream_warning_updates", [])
    expected = [str(item.get("warning_ref", "")) for item in upstream]
    received = [str(item.get("warning_ref", "")) for item in updates]
    if len(received) != len(set(received)) or set(received) != set(expected):
        raise ValueError(
            "every unresolved upstream warning must be updated exactly once"
        )
    updates_by_ref = {item["warning_ref"]: item for item in updates}
    snapshot: list[dict[str, Any]] = []
    for warning in upstream:
        reference = str(warning["warning_ref"])
        update = updates_by_ref[reference]
        if update["status"] == "resolved":
            continue
        snapshot.append({**warning, "latest_update": update})
    for index, warning in enumerate(review.get("handoff_warnings", [])):
        snapshot.append(
            {
                **warning,
                "warning_ref": f"{stage.value}:{attempt}:w{index}",
            }
        )
    return snapshot


def _validate_stage_b_dispositions(
    output_dir: Path, root: Path, result: dict[str, Any], review: dict[str, Any]
) -> None:
    artifacts = result.get("artifacts", {})
    reference = artifacts.get("stage_b_morphology_audit_json")
    if not isinstance(reference, str):
        raise ValueError("Stage-B review requires the morphology audit artifact")
    audit_path = (root / reference).resolve()
    try:
        audit_path.relative_to(root.resolve())
    except ValueError as error:
        raise ValueError("Stage-B morphology audit escapes its Stage Attempt Record") from error
    audit = validate_stage_b_morphology_audit(_read_object(audit_path))
    family_reference = audit["predicted_image_family"]["reference"]
    accepted_head_path = output_dir / "accepted" / "a.json"
    accepted_head = _read_object(accepted_head_path)
    if accepted_head.get("stage") != "a":
        raise ValueError("Stage-B review requires an accepted Stage A")
    accepted_a_root = (
        accepted_head_path.parent / str(accepted_head.get("attempt_path", ""))
    ).resolve()
    try:
        expected_family_reference = (
            accepted_a_root / "artifacts" / "stage_a_predicted_image_family.json"
        ).relative_to(output_dir.resolve()).as_posix()
    except ValueError as error:
        raise ValueError("Accepted Stage A escapes the Lens Result Directory") from error
    if family_reference != expected_family_reference:
        raise ValueError("Stage-B morphology audit does not reference accepted Stage A")
    family_path = (output_dir / family_reference).resolve()
    try:
        family_path.relative_to(output_dir.resolve())
    except ValueError as error:
        raise ValueError("Stage-A family reference escapes the Lens Result Directory") from error
    family = validate_predicted_image_family(_read_object(family_path))
    if family["stage_attempt"] != accepted_a_root.relative_to(output_dir).as_posix():
        raise ValueError("Stage-A predicted image family names the wrong accepted attempt")
    if hashlib.sha256(family_path.read_bytes()).hexdigest() != audit[
        "predicted_image_family"
    ]["sha256"]:
        raise ValueError("Stage-B morphology audit has the wrong Stage-A family hash")
    if [
        (item["image_id"], item["position_arcsec"]) for item in audit["images"]
    ] != [
        (item["image_id"], item["position_arcsec"]) for item in family["images"]
    ]:
        raise ValueError("Stage-B morphology audit does not match its Stage-A family")
    coverage = {
        item["image_id"]: item["nearest_pixel_covered"] for item in audit["images"]
    }
    dispositions = review["predicted_image_dispositions"]
    received_ids = [item["image_id"] for item in dispositions]
    if len(received_ids) != len(set(received_ids)) or set(received_ids) != set(coverage):
        raise ValueError(
            "Stage-B review must classify every predicted image ID exactly once"
        )
    for item in dispositions:
        mechanically_covered = coverage[item["image_id"]]
        if item["disposition"] == "covered_consistent" and not mechanically_covered:
            raise ValueError("covered_consistent conflicts with mechanical mask coverage")
        if item["disposition"] == "supported_uncovered" and mechanically_covered:
            raise ValueError("supported_uncovered conflicts with mechanical mask coverage")
        if item["disposition"] == "supported_partial" and not mechanically_covered:
            raise ValueError("supported_partial conflicts with mechanical mask coverage")


def adjudicate_attempt(
    output_dir: Path,
    stage: StageName,
    attempt: int,
    *,
    response: Path | None,
    failure: str | None = None,
) -> Path:
    output_dir = validated_run_root(output_dir)
    root = attempt_dir(output_dir, stage, attempt)
    if failure is not None:
        if response is not None:
            raise ValueError("operational failure cannot include a scientific review")
        if failure not in _OPERATIONAL_FAILURE_REASONS:
            raise ValueError("unsupported operational failure code")
        if failure == "stage_a_timeout" and stage != StageName.A:
            raise ValueError("stage_a_timeout is valid only for Stage A")
        _validate_operational_failure_evidence(root, stage, attempt, failure)
        return _register_adjudication(
            root,
            {
                "schema_version": "stage_decision.v1",
                "stage": stage.value,
                "attempt": attempt,
                "decision": "human_review",
                "reason_kind": "operational_failure",
                "failure_code": failure,
                "reason": _OPERATIONAL_FAILURE_REASONS[failure],
                "evidence_sha256": _evidence_snapshot(root),
            },
        )
    result = _load_result(root, stage, attempt)
    passed_hard_gate = _passes_hard_gate(result)
    artifact_failure = (
        _artifact_gate_failure(root, result) if passed_hard_gate else None
    )
    if not passed_hard_gate or artifact_failure is not None:
        if response is not None:
            raise ValueError("Hard Gate failure must not receive a scientific review")
        decision = {
            "schema_version": "stage_decision.v1",
            "stage": stage.value,
            "attempt": attempt,
            "decision": "human_review",
            "reason_kind": "operational_failure",
            "reason": artifact_failure or _operational_reason(result),
            "evidence_sha256": _evidence_snapshot(root),
        }
        return _register_adjudication(root, decision)
    if response is None:
        raise ValueError("eligible stage adjudication requires a scientific review")
    response_path = response.resolve()
    try:
        response_path.relative_to(output_dir)
    except ValueError:
        pass
    else:
        raise ValueError("expert response must be a temporary file outside the Lens Result Directory")
    review = validate_reviewer_response(_read_object(response_path), stage)
    if stage == StageName.B:
        _validate_stage_b_dispositions(output_dir, root, result, review)
    upstream = unresolved_warnings(output_dir, stage)
    warning_snapshot = (
        upstream if stage == StageName.M0 else _warning_snapshot(upstream, review, stage, attempt)
    )
    budget_reason: str | None = None
    budget_snapshot: dict[str, int] | None = None
    uncertainty = review.get("scientific_uncertainty")
    uncertainty_reason_kind = False
    if stage == StageName.M0:
        judgment = review["grid_judgment"]
        if judgment == "grid_sufficient":
            decision_name = "accept"
        elif judgment == "indeterminate":
            decision_name = "human_review"
            uncertainty_reason_kind = True
        else:
            try:
                validate_m0_grid_enlargement(output_dir, attempt, review)
            except ValueError as error:
                if "maximum policy level" not in str(error):
                    raise
                decision_name = "human_review"
            else:
                budget_snapshot, budget_reason = _retry_budget_snapshot(
                    output_dir, stage
                )
                decision_name = "human_review" if budget_reason else "retry"
    elif stage == StageName.B:
        refinement = review["refinement_kind"]
        if refinement == "none":
            decision_name = "accept"
        elif refinement == "coverage_blocked":
            decision_name = "human_review"
        elif refinement in {"parameters", "selection"}:
            validate_retry_review(output_dir, stage, attempt, review)
            budget_snapshot, budget_reason = _retry_budget_snapshot(
                output_dir, stage
            )
            decision_name = "human_review" if budget_reason else "retry"
        else:
            decision_name = "human_review"
            dispositions = {
                item["disposition"]
                for item in review["predicted_image_dispositions"]
            }
            uncertainty_reason_kind = "unsupported_prediction" not in dispositions
    else:
        blockers = review["progression_blockers"]
        repair = review["retry_repair"]
        if uncertainty is not None:
            if blockers or repair is not None:
                raise ValueError(
                    "scientific uncertainty cannot include blockers or a retry repair"
                )
            decision_name = "human_review"
            uncertainty_reason_kind = True
        elif not blockers:
            if repair is not None:
                raise ValueError("a review without blockers cannot propose a retry")
            decision_name = "accept"
        elif len(blockers) == 1 and repair is not None:
            validate_retry_review(output_dir, stage, attempt, review)
            budget_snapshot, budget_reason = _retry_budget_snapshot(
                output_dir, stage
            )
            decision_name = "human_review" if budget_reason else "retry"
        else:
            decision_name = "human_review"
    if (
        review.get("development_recommendation") is not None
        and decision_name != "human_review"
    ):
        raise ValueError(
            "a development recommendation is only valid for Human Review"
        )
    decision = {
        "schema_version": "stage_decision.v1",
        "stage": stage.value,
        "attempt": attempt,
        "decision": decision_name,
        "reason": review["reason"],
        "evidence_sha256": _evidence_snapshot(root, review=review),
    }
    if stage == StageName.SUBHALO and decision_name == "accept":
        from .subhalo import detection_status
        decision["subhalo_status"] = detection_status(
            result["metrics"]["delta_log_z"], review["residual_improved"]
        )
        decision["delta_log_z"] = result["metrics"]["delta_log_z"]
        decision["residual_improved"] = review["residual_improved"]
    if budget_snapshot is not None:
        decision["retry_budget"] = budget_snapshot
    if decision_name == "human_review" and budget_reason:
        decision["reason"] = f"{review['reason']}; {budget_reason}"
    if decision_name == "accept":
        decision["unresolved_warnings"] = warning_snapshot
    elif decision_name == "human_review":
        decision["reason_kind"] = (
            "scientific_uncertainty" if uncertainty_reason_kind else "scientific_blocker"
        )
        if review.get("development_recommendation") is not None:
            decision["development_recommendation"] = review[
                "development_recommendation"
            ]
    return _register_adjudication(root, decision, review)
