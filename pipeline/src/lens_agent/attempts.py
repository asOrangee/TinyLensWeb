from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from pydantic import BaseModel, ConfigDict

from .configuration import (
    EffectiveConfig,
    InputGeometry,
    run_input_geometry,
    validate_config_geometry,
    PIPELINE_RELEASE_ID,
    PipelineConfig,
    TUNABLE_CATALOG,
    validated_run_root,
)
from .contracts import validate_reviewer_response
from .inspector_decision import InspectorDecision, validate_inspector_decision
from .models import STAGE_DEPENDENCY_ORDER, StageName
from .operations import attempt_lock
from .modeling.arc_components import validate_stage_b_arc_components
from .modeling.morphology_audit import validate_stage_b_morphology_audit
from .modeling.predicted_image_family import validate_predicted_image_family
from .modeling.source_grid import (
    next_source_grid_level,
    source_grid_spec,
    validate_source_grid_spec,
)
from .visual_prior import derive_stage_a_visual_prior


CORE_EVIDENCE_FILES = (
    "effective-config.json",
    "stage-execution.json",
    "stage-result.json",
    "manifest.json",
    "arc-component-selection.json",
    "review.json",
    "stage.log",
    "traceback.log",
)


class _Proposal(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False)

    base_config: str
    parameter: str
    old_value: Any
    new_value: Any


class _ComponentSelection(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False)

    component_catalog: str
    drop_component_ids: list[int]


def attempt_dir(output_dir: Path, stage: StageName, attempt: int) -> Path:
    if attempt < 0:
        raise ValueError("attempt must be non-negative")
    boundary = output_dir.resolve()
    target = (boundary / "attempts" / stage.value / str(attempt)).resolve()
    try:
        target.relative_to(boundary)
    except ValueError as error:
        raise ValueError("stage attempt escapes the Lens Result Directory") from error
    return target


def validate_stage_execution(
    attempt_root: Path, stage: StageName, attempt: int
) -> dict[str, Any]:
    marker_path = attempt_root / "stage-execution.json"
    if not marker_path.is_file():
        raise ValueError("stage result requires a stage execution marker")
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    expected = {
        "schema_version": "stage_execution.v1",
        "stage": stage.value,
        "attempt": attempt,
        "pipeline_release_id": PIPELINE_RELEASE_ID,
        "status": "started",
    }
    if marker != expected:
        raise ValueError("stage execution marker does not identify this attempt")
    return marker


def validate_decision_review_evidence(
    attempt_root: Path, decision: dict[str, Any]
) -> None:
    evidence = decision.get("evidence_sha256")
    core_names = set(CORE_EVIDENCE_FILES)
    expected_names = set(core_names)
    manifest_path = attempt_root / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entries = manifest.get("artifacts") if isinstance(manifest, dict) else None
        if isinstance(entries, list):
            expected_names.update(
                f"artifact:{entry['path']}"
                for entry in entries
                if isinstance(entry, dict) and isinstance(entry.get("path"), str)
            )
    if not isinstance(evidence, dict) or set(evidence) != expected_names:
        raise ValueError("Stage Attempt Record has incomplete adjudicated evidence")
    for evidence_name, expected_sha256 in evidence.items():
        if evidence_name.startswith("artifact:"):
            reference = evidence_name.removeprefix("artifact:")
            if not reference:
                raise ValueError("Stage Attempt Record has invalid artifact evidence")
        elif evidence_name in core_names:
            reference = evidence_name
        else:
            raise ValueError("Stage Attempt Record has unknown adjudicated evidence")
        evidence_path = _resolve_within(attempt_root, reference, attempt_root)
        actual_sha256 = (
            hashlib.sha256(evidence_path.read_bytes()).hexdigest()
            if evidence_path.is_file()
            else None
        )
        if actual_sha256 != expected_sha256:
            if evidence_name == "review.json":
                raise ValueError(
                    "Stage Attempt Record review no longer matches its adjudicated evidence"
                )
            raise ValueError(
                f"Stage Attempt Record {evidence_name} no longer matches its "
                "adjudicated evidence"
            )


def _load_config(path: Path) -> EffectiveConfig:
    return EffectiveConfig.model_validate_json(path.read_text(encoding="utf-8"), strict=True)


def _resolve_within(base: Path, reference: str, boundary: Path) -> Path:
    target = (base / reference).resolve()
    try:
        target.relative_to(boundary.resolve())
    except ValueError as error:
        raise ValueError("attempt reference escapes the Lens Result Directory") from error
    return target


def _accepted_config(output_dir: Path, stage: StageName) -> tuple[EffectiveConfig, str | None]:
    stage_index = STAGE_DEPENDENCY_ORDER.index(stage)
    if stage_index == 0:
        return EffectiveConfig(settings=PipelineConfig(**run_input_geometry(output_dir).model_dump())), None
    upstream = STAGE_DEPENDENCY_ORDER[stage_index - 1]
    head_path = output_dir / "accepted" / f"{upstream.value}.json"
    head = json.loads(head_path.read_text(encoding="utf-8"))
    if head.get("stage") != upstream.value:
        raise ValueError("Accepted Stage Head names the wrong stage")
    config_path = _resolve_within(
        head_path.parent, str(head.get("effective_config", "")), output_dir
    )
    return _load_config(config_path), config_path.relative_to(output_dir).as_posix()


def _proposal_from_response(raw: dict[str, Any], stage: StageName) -> tuple[_Proposal, str]:
    if stage == StageName.B:
        if raw.get("refinement_kind") != "parameters":
            raise ValueError("Stage B parameter proposal requires a parameter retry")
        blocker = "arc_mask"
    else:
        blockers = raw.get("progression_blockers")
        if not isinstance(blockers, list) or len(blockers) != 1:
            raise ValueError("retry requires exactly one Progression Blocker")
        blocker = blockers[0].get("kind") if isinstance(blockers[0], dict) else None
    repair = raw.get("retry_repair")
    if not isinstance(repair, dict):
        raise ValueError("retry response must contain retry_repair")
    hypothesis = repair.get("hypothesis")
    if not isinstance(hypothesis, dict) or hypothesis.get("blocker_kind") != blocker:
        raise ValueError("Retry Repair Hypothesis must match the Progression Blocker")
    return _Proposal.model_validate(repair.get("proposal"), strict=True), str(blocker)


def _selection_from_response(
    raw: dict[str, Any], output_dir: Path, parent_root: Path
) -> _ComponentSelection | None:
    if raw.get("refinement_kind") != "selection":
        return None
    if raw.get("retry_repair") is not None:
        raise ValueError("Stage B selection and parameter repair are mutually exclusive")
    selection = _ComponentSelection.model_validate(
        raw.get("component_selection"), strict=True
    )
    ids = selection.drop_component_ids
    if (
        any(isinstance(value, bool) or value <= 0 for value in ids)
        or ids != sorted(set(ids))
    ):
        raise ValueError("drop_component_ids must be sorted unique positive integers")
    expected = (
        parent_root / "artifacts" / "stage_b_components.json"
    ).relative_to(output_dir).as_posix()
    if selection.component_catalog != expected:
        raise ValueError("component selection is not bound to the parent component catalog")
    catalog_path = _resolve_within(output_dir, selection.component_catalog, output_dir)
    catalog = validate_stage_b_arc_components(
        json.loads(catalog_path.read_text(encoding="utf-8"))
    )
    expected_attempt = parent_root.relative_to(output_dir).as_posix()
    if catalog["stage_attempt"] != expected_attempt:
        raise ValueError("component catalog does not identify the parent attempt")
    labels_path = _resolve_within(
        catalog_path.parent,
        catalog["component_labels"]["reference"],
        parent_root,
    )
    audit_path = _resolve_within(
        catalog_path.parent,
        catalog["morphology_audit"]["reference"],
        parent_root,
    )
    if not labels_path.is_file() or not audit_path.is_file():
        raise ValueError("component selection requires parent labels and morphology audit")
    if hashlib.sha256(labels_path.read_bytes()).hexdigest() != catalog[
        "component_labels"
    ]["sha256"]:
        raise ValueError("component labels do not match the parent component catalog")
    if hashlib.sha256(audit_path.read_bytes()).hexdigest() != catalog[
        "morphology_audit"
    ]["sha256"]:
        raise ValueError("morphology audit does not match the parent component catalog")
    labels = np.asarray(fits.getdata(labels_path))
    validate_stage_b_arc_components(catalog, component_labels=labels)
    audit = validate_stage_b_morphology_audit(
        json.loads(audit_path.read_text(encoding="utf-8"))
    )
    if audit["stage_attempt"] != expected_attempt:
        raise ValueError("morphology audit does not identify the parent attempt")
    family_path = _resolve_within(
        output_dir,
        audit["predicted_image_family"]["reference"],
        output_dir,
    )
    if (
        not family_path.is_file()
        or hashlib.sha256(family_path.read_bytes()).hexdigest()
        != audit["predicted_image_family"]["sha256"]
    ):
        raise ValueError("morphology audit does not match its predicted image family")
    family = validate_predicted_image_family(
        json.loads(family_path.read_text(encoding="utf-8"))
    )
    if family["coordinate_system"]["image_shape"] != catalog["image_shape"]:
        raise ValueError(
            "component catalog and morphology audit use different image shapes"
        )
    if audit["parameters"] != catalog["parameters"]:
        raise ValueError("component catalog and morphology audit parameters differ")
    if (
        audit["valid_modeling_domain"]["excluded_above_threshold_pixel_count"]
        != catalog["excluded_above_threshold_pixel_count"]
    ):
        raise ValueError("component catalog and morphology audit domain evidence differ")
    available = {
        item.get("id") for item in catalog.get("components", []) if isinstance(item, dict)
    }
    unknown = set(ids) - available
    if unknown:
        raise ValueError(f"component selection references absent IDs: {sorted(unknown)}")
    kept = set(catalog["selection"]["effective_keep_component_ids"])
    uncovered = []
    for image in audit["images"]:
        row, col = image["nearest_pixel"]
        if not (0 <= row < labels.shape[0] and 0 <= col < labels.shape[1]):
            raise ValueError("component labels do not match the morphology audit")
        if (
            not set(image["candidate_component_ids"]) <= available
            or not set(image["selected_component_ids"]) <= kept
            or image["nearest_pixel_covered"]
            != (int(labels[row, col]) in kept)
        ):
            raise ValueError("component catalog, labels, and morphology audit disagree")
        if image["nearest_pixel_covered"] and int(labels[row, col]) in ids:
            uncovered.append(image["image_id"])
    if uncovered:
        raise ValueError(
            "component selection would uncover predicted images: "
            + ", ".join(uncovered)
        )
    current_path = parent_root / "arc-component-selection.json"
    current_ids: list[int] = []
    if current_path.is_file():
        current_ids = json.loads(current_path.read_text(encoding="utf-8")).get(
            "drop_component_ids", []
        )
    if ids == current_ids:
        raise ValueError("component selection must change the dropped-component set")
    return selection


def _apply_proposal(
    parent: EffectiveConfig,
    proposal: _Proposal,
    blocker: str,
    stage: StageName,
    expected_base: str,
) -> PipelineConfig:
    if proposal.base_config != expected_base:
        raise ValueError("proposal base_config is not the current candidate configuration")
    spec = TUNABLE_CATALOG.get(proposal.parameter)
    if spec is None:
        raise ValueError("proposal parameter is not in the Tunable Catalog")
    if spec.stage != stage.value:
        raise ValueError("proposal parameter belongs to another stage")
    if blocker not in spec.blockers:
        raise ValueError("proposal parameter cannot repair this blocker")
    current = getattr(parent.settings, proposal.parameter)
    if proposal.old_value != current:
        raise ValueError("proposal old_value does not match the parent configuration")
    new_value = proposal.new_value
    if isinstance(new_value, bool) or type(new_value) is not spec.value_type:
        raise ValueError("proposal new_value has the wrong type")
    if not spec.minimum <= new_value <= spec.maximum:
        raise ValueError("proposal new_value is outside the Tuning Safety Envelope")
    if stage == StageName.SUBHALO and new_value <= current:
        raise ValueError("subhalo sampling retries must increase the selected setting")
    if new_value == current:
        raise ValueError("proposal must change the selected parameter")
    values = parent.settings.model_dump()
    values[proposal.parameter] = new_value
    return PipelineConfig.model_validate(values, strict=True)


def validate_retry_review(
    output_dir: Path,
    stage: StageName,
    attempt: int,
    raw_response: dict[str, Any],
) -> tuple[PipelineConfig, dict[str, Any], _ComponentSelection | None]:
    """Validate one stage-local retry without creating the next attempt."""
    output_dir = validated_run_root(output_dir)
    parent_root = attempt_dir(output_dir, stage, attempt)
    parent_path = parent_root / "effective-config.json"
    parent_reference = parent_path.relative_to(output_dir).as_posix()
    parent = _load_config(parent_path)
    response = validate_reviewer_response(raw_response, stage)
    component_selection = None
    if stage == StageName.B:
        component_selection = _selection_from_response(
            response, output_dir, parent_root
        )
    if component_selection is not None:
        return (
            parent.settings,
            {
                "status": "valid",
                "stage": stage.value,
                "kind": "component_selection",
                "component_catalog": component_selection.component_catalog,
                "drop_component_ids": component_selection.drop_component_ids,
            },
            component_selection,
        )
    proposal, blocker = _proposal_from_response(response, stage)
    if stage == StageName.B and any(
        item["disposition"] == "supported_uncovered"
        for item in response["predicted_image_dispositions"]
    ):
        if (
            proposal.parameter != "arc_snr_threshold"
            or proposal.new_value >= proposal.old_value
        ):
            raise ValueError(
                "Stage-B supported_uncovered repair requires lowering arc_snr_threshold"
            )
    settings = _apply_proposal(
        parent, proposal, blocker, stage, parent_reference
    )
    return (
        settings,
        {
            "status": "valid",
            "stage": stage.value,
            "parameter": proposal.parameter,
            "old_value": proposal.old_value,
            "new_value": proposal.new_value,
        },
        None,
    )


def validate_m0_grid_enlargement(
    output_dir: Path, attempt: int, raw_response: dict[str, Any]
) -> tuple[PipelineConfig, dict[str, Any]]:
    """Derive the next fixed grid level from one canonical M0 truncation review."""
    output_dir = validated_run_root(output_dir)
    parent_root = attempt_dir(output_dir, StageName.M0, attempt)
    parent = _load_config(parent_root / "effective-config.json")
    response = validate_reviewer_response(raw_response, StageName.M0)
    if response["grid_judgment"] != "source_bbox_truncation":
        raise ValueError("M0 Grid Enlargement requires confirmed source truncation")
    old_level = parent.settings.source_grid_level
    new_level = next_source_grid_level(old_level)
    if new_level is None:
        raise ValueError("M0 source grid is already at the maximum policy level")
    values = parent.settings.model_dump()
    values["source_grid_level"] = new_level
    settings = PipelineConfig.model_validate(values, strict=True)
    old_grid = validate_source_grid_spec(
        json.loads(
            (parent_root / "artifacts" / "source_grid_spec.json").read_text(
                encoding="utf-8"
            )
        )
    )
    if old_grid["grid_level"] != old_level:
        raise ValueError("M0 Source Grid Specification does not match its configuration")
    center = old_grid["anchor_center"]
    new_grid = source_grid_spec(
        center_x=center["x"], center_y=center["y"], level=new_level
    )
    return settings, {
        "status": "valid",
        "stage": "m0",
        "kind": "source_grid_enlargement",
        "old_grid_level": old_level,
        "new_grid_level": new_level,
        "old_source_grid_spec": old_grid,
        "new_source_grid_spec": new_grid,
    }


def prepare_attempt(
    output_dir: Path,
    stage: StageName,
    attempt: int,
) -> Path:
    with attempt_lock(output_dir, stage, attempt):
        return _prepare_attempt(output_dir, stage, attempt)


def _prepare_attempt(output_dir: Path, stage: StageName, attempt: int) -> Path:
    """Publish a complete configuration bundle while the caller holds the attempt lock."""
    final_dir = attempt_dir(output_dir, stage, attempt)
    if final_dir.exists():
        raise ValueError("Stage Attempt Record already exists and cannot be overwritten")
    bundle = configuration_bundle(output_dir, stage, attempt)
    final_dir.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".prepare-{attempt}-", dir=final_dir.parent))
    for name, payload in bundle.items():
        (temporary / name).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    # Interrupted bundles remain diagnostic evidence; later requests build a fresh bundle.
    os.rename(temporary, final_dir)
    return final_dir / "effective-config.json"


def configuration_bundle(output_dir: Path, stage: StageName, attempt: int) -> dict[str, Any]:
    """Derive the complete authorized preparation without filesystem writes."""
    output_dir = validated_run_root(output_dir)
    parent_reference: str | None = None
    settings = PipelineConfig()
    validation: dict[str, Any] | None = None
    component_selection: _ComponentSelection | None = None
    visual_prior_provenance: dict[str, Any] | None = None
    attempt_dir(output_dir, stage, attempt)
    if attempt == 0:
        accepted, accepted_reference = _accepted_config(output_dir, stage)
        settings = accepted.settings
        if stage in {StageName.A, StageName.B, StageName.M0} and settings.source_grid_level != 0:
            raise ValueError("the root configuration and initial M0 attempt require source grid level 0")
        if stage == StageName.A:
            inspector_path = output_dir / "preflight" / "inspector.json"
            decision = InspectorDecision.model_validate(
                validate_inspector_decision(
                    json.loads(inspector_path.read_text(encoding="utf-8")),
                    expected_lens_id=output_dir.name,
                ),
                strict=True,
            )
            settings, visual_prior_provenance = derive_stage_a_visual_prior(
                settings, decision
            )
            visual_prior_provenance["source_inspector"] = "preflight/inspector.json"
        else:
            parent_reference = accepted_reference
    else:
        parent_root = attempt_dir(output_dir, stage, attempt - 1)
        parent_path = parent_root / "effective-config.json"
        parent_reference = parent_path.relative_to(output_dir).as_posix()
        decision = json.loads((parent_root / "decision.json").read_text(encoding="utf-8"))
        if (
            decision.get("schema_version") != "stage_decision.v1"
            or decision.get("stage") != stage.value
            or decision.get("attempt") != attempt - 1
        ):
            raise ValueError("canonical retry decision does not identify the parent attempt")
        if decision.get("decision") != "retry":
            raise ValueError("retry attempt requires a canonical retry decision")
        validate_decision_review_evidence(parent_root, decision)
        raw_response = json.loads(
            (parent_root / "review.json").read_text(encoding="utf-8")
        )
        if stage == StageName.M0:
            settings, validation = validate_m0_grid_enlargement(
                output_dir, attempt - 1, raw_response
            )
        else:
            settings, validation, component_selection = validate_retry_review(
                output_dir, stage, attempt - 1, raw_response
            )

    if InputGeometry.from_settings(settings) != run_input_geometry(output_dir):
        raise ValueError("Attempt input geometry differs from the run manifest; start a new run")
    config = EffectiveConfig(parent_config=parent_reference, settings=settings)
    bundle = {"effective-config.json": config.model_dump(mode="json")}
    if component_selection is not None:
        selection_payload = {
            "schema_version": "arc_component_selection.v1",
            **component_selection.model_dump(mode="json"),
        }
        bundle["arc-component-selection.json"] = selection_payload
    if validation is not None:
        bundle["proposal-validation.json"] = validation
    if visual_prior_provenance is not None:
        bundle["visual-prior-provenance.json"] = visual_prior_provenance
    if stage == StageName.SUBHALO:
        from .subhalo import load_candidate
        bundle["subhalo-candidate.json"] = load_candidate(output_dir, require_candidate=True)
        if attempt > 0:
            bundle["preview-confirmed.json"] = json.loads(
                (output_dir / "attempts/subhalo/0/preview-confirmed.json").read_text()
            )
    return bundle


def manifest_paths(attempt_root: Path) -> set[str]:
    manifest = json.loads((attempt_root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != "attempt_artifact_manifest.v1":
        raise ValueError("unsupported Attempt Artifact Manifest")
    entries = manifest.get("artifacts")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Attempt Artifact Manifest has no artifacts")
    paths: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("invalid artifact manifest entry")
        if set(entry) != {"path", "role", "media_type"}:
            raise ValueError("artifact manifest entry must contain path, role, and media_type")
        reference = entry["path"]
        if (
            not isinstance(reference, str)
            or not isinstance(entry["role"], str)
            or not entry["role"]
            or not isinstance(entry["media_type"], str)
            or not entry["media_type"]
        ):
            raise ValueError("invalid artifact manifest value")
        if reference in paths:
            raise ValueError("duplicate artifact manifest path")
        path = _resolve_within(attempt_root, reference, attempt_root)
        if not path.is_file():
            raise ValueError(f"manifest artifact is missing: {entry['path']}")
        with path.open("rb") as handle:
            handle.read(1)
        paths.add(reference)
    return paths


def promote_attempt(output_dir: Path, stage: StageName, attempt: int) -> Path:
    """Validate and atomically advance one Accepted Stage Head."""
    output_dir = validated_run_root(output_dir)
    candidate = attempt_dir(output_dir, stage, attempt)
    validate_stage_execution(candidate, stage, attempt)
    config = _load_config(candidate / "effective-config.json")
    validate_config_geometry(config, output_dir)
    if config.pipeline_release_id != PIPELINE_RELEASE_ID:
        raise ValueError("candidate belongs to a different Pipeline Release")
    result = json.loads((candidate / "stage-result.json").read_text(encoding="utf-8"))
    if result.get("stage") != stage.value or result.get("attempt") != attempt:
        raise ValueError("stage result does not identify this candidate")
    if (
        result.get("status") != "success"
        or result.get("eligible_for_review") is not True
        or result.get("gate_failures")
    ):
        raise ValueError("Hard Gate did not pass; candidate cannot be promoted")
    decision = json.loads((candidate / "decision.json").read_text(encoding="utf-8"))
    if (
        decision.get("schema_version") != "stage_decision.v1"
        or decision.get("stage") != stage.value
        or decision.get("attempt") != attempt
    ):
        raise ValueError("candidate decision does not identify this candidate")
    if decision.get("decision") != "accept":
        raise ValueError("candidate decision is not accept")
    validate_decision_review_evidence(candidate, decision)
    recorded_paths = manifest_paths(candidate)
    result_artifacts = result.get("artifacts")
    if not isinstance(result_artifacts, dict) or any(
        not isinstance(path, str) for path in result_artifacts.values()
    ):
        raise ValueError("stage result has an invalid artifact map")
    required_paths = set(result_artifacts.values())
    if not required_paths or not required_paths <= recorded_paths:
        raise ValueError("Attempt Artifact Manifest omits a required stage artifact")
    existing_attempts = [
        int(path.name)
        for path in candidate.parent.iterdir()
        if path.is_dir() and path.name.isdigit()
        and (path / "effective-config.json").is_file()
    ]
    if not existing_attempts or attempt != max(existing_attempts):
        raise ValueError("candidate is not the current chain end")

    accepted_dir = output_dir / "accepted"
    accepted_dir.mkdir(parents=True, exist_ok=True)
    target = accepted_dir / f"{stage.value}.json"
    head = {
        "schema_version": "accepted_stage_head.v1",
        "stage": stage.value,
        "accepted_attempt": attempt,
        "attempt_path": f"../attempts/{stage.value}/{attempt}",
        "effective_config": f"../attempts/{stage.value}/{attempt}/effective-config.json",
    }
    if target.is_file():
        existing = json.loads(target.read_text(encoding="utf-8"))
        if existing == head:
            return target
        raise ValueError("Accepted Stage Head already exists with another candidate")
    temporary = accepted_dir / f".{stage.value}.json.tmp"
    temporary.write_text(json.dumps(head, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, target)
    return target
