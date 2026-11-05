from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .attempts import attempt_dir
from .configuration import EffectiveConfig, TUNABLE_CATALOG, validated_run_root
from .models import STAGE_DEPENDENCY_ORDER, StageName
from .modeling.morphology_audit import validate_stage_b_morphology_audit
from .modeling.predicted_image_family import validate_predicted_image_family


_CONSUMED_PREFIXES: dict[StageName, tuple[str, ...]] = {
    StageName.A: ("stage_a_", "n_gaussians_"),
    StageName.B: ("arc_",),
    StageName.M0: ("stage_m0_", "m0_", "source_grid_"),
    StageName.M1: ("stage_m1_", "source_grid_"),
    StageName.M2: ("stage_m2_", "adaptive_reg_", "source_grid_"),
    StageName.M3: ("stage_m3_", "source_grid_"),
    StageName.SUBHALO: ("stage_subhalo_", "stage_m3_", "source_grid_"),
}


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _read_attempt_json(root: Path, name: str) -> dict[str, Any] | None:
    path = (root / name).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError("attempt evidence escapes its Stage Attempt Record") from error
    return _read_json(path)


def _is_consumed(stage: StageName, parameter: str) -> bool:
    return any(parameter.startswith(prefix) for prefix in _CONSUMED_PREFIXES[stage])


def _settings_view(config: EffectiveConfig, stage: StageName) -> dict[str, Any]:
    values = config.settings.model_dump(mode="json")
    result: dict[str, Any] = {}
    for parameter, value in values.items():
        if parameter not in {"pixel_scale_arcsec", "input_x_direction", "input_y_direction"} and not _is_consumed(stage, parameter):
            continue
        spec = TUNABLE_CATALOG.get(parameter)
        if spec is not None and spec.stage != stage.value:
            spec = None  # Inherited settings are visible but never editable here.
        entry: dict[str, Any] = {"value": value, "tunable": spec is not None}
        if spec is not None:
            minimum = spec.minimum
            maximum = spec.maximum
            cross_field_requirements: list[dict[str, Any]] = []
            if spec.cross_field_peer is not None:
                peer_value = values[spec.cross_field_peer]
                if spec.cross_field_relation == "lte":
                    maximum = min(maximum, peer_value)
                    operator = "<="
                else:
                    minimum = max(minimum, peer_value)
                    operator = ">="
                cross_field_requirements.append(
                    {
                        "operator": operator,
                        "parameter": spec.cross_field_peer,
                        "current_value": peer_value,
                    }
                )
            entry.update(
                type="integer" if spec.value_type is int else "number",
                minimum=minimum,
                maximum=maximum,
                repairable_blockers=sorted(spec.blockers),
                invalidates_from=spec.invalidates_from,
                cross_field_requirements=cross_field_requirements,
            )
        result[parameter] = entry
    return result


def _lineage(output_dir: Path, stage: StageName, current: int) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for attempt in range(current + 1):
        root = attempt_dir(output_dir, stage, attempt)
        if not (root / "effective-config.json").is_file():
            continue
        result = _read_json(root / "stage-result.json") or {}
        decision = _read_json(root / "decision.json") or {}
        entry = {
            "attempt": attempt,
            "effective_config": (root / "effective-config.json")
            .relative_to(output_dir)
            .as_posix(),
            "eligible_for_review": result.get("eligible_for_review"),
            "decision": decision.get("decision"),
        }
        if stage == StageName.M0:
            review = _read_json(root / "review.json") or {}
            metrics = result.get("metrics", {}) if isinstance(result, dict) else {}
            diagnostics = (
                metrics.get("source_sign_diagnostics", {})
                if isinstance(metrics, dict) else {}
            )
            artifacts = result.get("artifacts", {}) if isinstance(result, dict) else {}
            diagnostic_reference = (
                artifacts.get("source_grid_png")
                if isinstance(artifacts, dict) else None
            )
            if isinstance(diagnostic_reference, str):
                diagnostic_path = (root / diagnostic_reference).resolve()
                try:
                    diagnostic_reference = diagnostic_path.relative_to(
                        output_dir
                    ).as_posix()
                except ValueError as error:
                    raise ValueError(
                        "M0 source-grid diagnostic escapes the Lens Result Directory"
                    ) from error
            entry.update(
                grid_level=(metrics.get("source_grid_spec") or {}).get("grid_level")
                if isinstance(metrics, dict) else None,
                grid_judgment=review.get("grid_judgment"),
                reason=review.get("reason"),
                edge_flux={
                    key: diagnostics.get(key)
                    for key in (
                        "positive_flux_fraction_at_bbox_edge",
                        "negative_flux_fraction_at_bbox_edge",
                        "positive_flux_fraction_by_bbox_edge",
                        "positive_flux_fraction_in_outer_two_pixel_ring",
                        "negative_flux_fraction_in_outer_two_pixel_ring",
                        "positive_flux_fraction_by_outer_two_pixel_side",
                    )
                },
                source_grid_diagnostic=diagnostic_reference,
            )
        entries.append(entry)
    return entries


def unresolved_warnings(output_dir: Path, stage: StageName) -> list[dict[str, Any]]:
    warnings: dict[str, dict[str, Any]] = {}
    for upstream in STAGE_DEPENDENCY_ORDER[: STAGE_DEPENDENCY_ORDER.index(stage)]:
        head_path = output_dir / "accepted" / f"{upstream.value}.json"
        head = _read_json(head_path)
        if head is None:
            continue
        root = (head_path.parent / str(head.get("attempt_path", ""))).resolve()
        try:
            root.relative_to(output_dir)
        except ValueError as error:
            raise ValueError("Accepted Stage Head escapes the Lens Result Directory") from error
        decision = _read_attempt_json(root, "decision.json") or {}
        snapshot = decision.get("unresolved_warnings")
        if isinstance(snapshot, list):
            warnings = {
                str(warning["warning_ref"]): warning
                for warning in snapshot
                if isinstance(warning, dict) and warning.get("warning_ref")
            }
            continue
        review = _read_attempt_json(root, "review.json") or {}
        for update in review.get("upstream_warning_updates", []):
            if not isinstance(update, dict):
                continue
            reference = str(update.get("warning_ref", ""))
            if update.get("status") == "resolved":
                warnings.pop(reference, None)
            elif reference in warnings:
                warnings[reference] = {
                    **warnings[reference],
                    "latest_update": update,
                }
        accepted_attempt = head.get("accepted_attempt")
        for index, warning in enumerate(review.get("handoff_warnings", [])):
            if not isinstance(warning, dict):
                continue
            record = dict(warning)
            reference = str(
                record.setdefault(
                    "warning_ref", f"{upstream.value}:{accepted_attempt}:w{index}"
                )
            )
            warnings[reference] = record
    return list(warnings.values())


def _visual_prior_provenance(
    output_dir: Path, stage: StageName
) -> dict[str, Any] | None:
    if stage != StageName.A:
        return None
    path = attempt_dir(output_dir, StageName.A, 0) / "visual-prior-provenance.json"
    record = _read_json(path)
    if record is None:
        raise ValueError("Stage A review requires Visual-Prior Provenance")
    return {
        "reference": path.relative_to(output_dir).as_posix(),
        "record": record,
    }


def _stage_a_evidence(
    output_dir: Path, stage: StageName, root: Path
) -> tuple[dict[str, Any] | None, str | None]:
    if stage not in {StageName.A, StageName.B}:
        return None, None
    if stage == StageName.A:
        stage_a_root = root
    else:
        head_path = output_dir / "accepted" / "a.json"
        head = _read_json(head_path)
        if head is None or head.get("stage") != "a":
            raise ValueError("Stage B review requires an accepted Stage A")
        stage_a_root = (head_path.parent / str(head.get("attempt_path", ""))).resolve()
    try:
        stage_a_root.relative_to(output_dir)
    except ValueError as error:
        raise ValueError("Stage-A review evidence escapes the Lens Result Directory") from error
    family_path = stage_a_root / "artifacts" / "stage_a_predicted_image_family.json"
    model_path = stage_a_root / "diagnostics" / "stage_a_model.png"
    family = validate_predicted_image_family(
        json.loads(family_path.read_text(encoding="utf-8"))
    )
    expected_attempt = stage_a_root.relative_to(output_dir).as_posix()
    if family["stage_attempt"] != expected_attempt:
        raise ValueError("Stage-A predicted image family names the wrong attempt")
    if not model_path.is_file():
        raise ValueError("Stage-A model diagnostic is missing")
    return (
        {
            "reference": family_path.relative_to(output_dir).as_posix(),
            "sha256": hashlib.sha256(family_path.read_bytes()).hexdigest(),
            "record": family,
        },
        model_path.relative_to(output_dir).as_posix(),
    )


def _stage_b_audit_evidence(
    output_dir: Path,
    stage: StageName,
    root: Path,
    family_evidence: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if stage != StageName.B:
        return None
    audit_path = root / "artifacts" / "stage_b_morphology_audit.json"
    audit = validate_stage_b_morphology_audit(
        json.loads(audit_path.read_text(encoding="utf-8"))
    )
    if audit["stage_attempt"] != root.relative_to(output_dir).as_posix():
        raise ValueError("Stage-B morphology audit names the wrong attempt")
    if family_evidence is None or audit["predicted_image_family"] != {
        "reference": family_evidence["reference"],
        "sha256": family_evidence["sha256"],
    }:
        raise ValueError("Stage-B morphology audit is not bound to accepted Stage A")
    expected_images = [
        (item["image_id"], item["position_arcsec"])
        for item in family_evidence["record"]["images"]
    ]
    received_images = [
        (item["image_id"], item["position_arcsec"])
        for item in audit["images"]
    ]
    if received_images != expected_images:
        raise ValueError("Stage-B morphology audit does not cover the accepted image family")
    return {
        "reference": audit_path.relative_to(output_dir).as_posix(),
        "record": audit,
    }


def build_review_context(output_dir: Path, stage: StageName, attempt: int) -> Path:
    """Materialize a bounded filesystem-resumable context for one review turn."""
    output_dir = validated_run_root(output_dir)
    root = attempt_dir(output_dir, stage, attempt)
    config_path = root / "effective-config.json"
    config = EffectiveConfig.model_validate_json(
        config_path.read_text(encoding="utf-8"), strict=True
    )
    stage_result = _read_json(root / "stage-result.json")
    if stage_result is None:
        raise ValueError("review context requires a completed stage result")
    if stage_result.get("stage") != stage.value or stage_result.get("attempt") != attempt:
        raise ValueError("stage result does not identify this review candidate")
    preceding_retry = None
    if attempt > 0:
        parent_review = _read_json(
            attempt_dir(output_dir, stage, attempt - 1) / "review.json"
        )
        if parent_review is not None:
            preceding_retry = parent_review.get("retry_repair")
            if preceding_retry is None and parent_review.get("component_selection") is not None:
                preceding_retry = {
                    "component_selection": parent_review["component_selection"]
                }
        if stage == StageName.M0:
            preceding_retry = {
                "grid_enlargement": _read_json(root / "proposal-validation.json")
            }
    family_evidence, stage_a_model_png = _stage_a_evidence(
        output_dir, stage, root
    )
    context = {
        "schema_version": "stage_review_context.v1",
        "lens_id": output_dir.name,
        "stage": stage.value,
        "attempt": attempt,
        "effective_config": config_path.relative_to(output_dir).as_posix(),
        "settings": _settings_view(config, stage),
        "stage_result": stage_result,
        "arc_component_selection": (
            _read_json(root / "arc-component-selection.json")
            if stage == StageName.B
            else None
        ),
        "visual_prior_provenance": _visual_prior_provenance(output_dir, stage),
        "stage_a_predicted_image_family": family_evidence,
        "stage_a_model_png": stage_a_model_png,
        "stage_b_morphology_audit": _stage_b_audit_evidence(
            output_dir, stage, root, family_evidence
        ),
        "preceding_retry": preceding_retry,
        "lineage": _lineage(output_dir, stage, attempt),
        "unresolved_upstream_warnings": unresolved_warnings(output_dir, stage),
    }
    target = root / "review-context.json"
    target.write_text(json.dumps(context, indent=2) + "\n", encoding="utf-8")
    return target
