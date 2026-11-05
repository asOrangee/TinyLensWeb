import hashlib
import json
from pathlib import Path

import numpy as np
import jsonschema
import pytest
from astropy.io import fits

from lens_agent.cli import main
from lens_agent.configuration import EffectiveConfig, PIPELINE_RELEASE_ID
from lens_agent.contracts import validate_reviewer_response
from lens_agent.modeling.source_grid import source_grid_spec
from lens_agent.modeling.predicted_image_family import build_predicted_image_family
from lens_agent.models import StageName


def _stage_b_audit(
    covered: tuple[bool, bool], family_sha256: str
) -> dict[str, object]:
    images = []
    for index, is_covered in enumerate(covered, start=1):
        images.append(
            {
                "image_id": f"image_{index}",
                "position_arcsec": [float(index), 0.0],
                "nearest_pixel": [10, 10 + index],
                "nearest_pixel_covered": is_covered,
                "nearest_arc_pixel_distance_arcsec": 0.0 if is_covered else 0.2,
                "local_peak_snr": 4.0,
                "local_peak_position_arcsec": [float(index), 0.0],
                "local_above_threshold_pixel_count": 0,
                "threshold_islands": [],
                "candidate_component_ids": [index] if is_covered else [],
                "selected_component_ids": [index] if is_covered else [],
                "local_selected_arc_pixel_count": 1 if is_covered else 0,
                "local_valid_pixel_count": 10,
                "local_selected_arc_fraction": 0.1 if is_covered else 0.0,
            }
        )
    return {
        "schema_version": "stage_b_morphology_audit.v2",
        "stage_attempt": "attempts/b/0",
        "predicted_image_family": {
            "reference": "attempts/a/0/artifacts/stage_a_predicted_image_family.json",
            "sha256": family_sha256,
        },
        "parameters": {"threshold": 2.0, "ignor_size": 5, "ext_size": 5, "close_size": 3},
        "pixel_scale_arcsec": 0.1,
        "local_radius_arcsec": 0.3,
        "mask_convention": "selected_arc_region True includes pixels",
        "valid_modeling_domain": {
            "mask_convention": "modeling_mask True excludes pixels",
            "valid_pixel_count": 4096,
            "excluded_pixel_count": 0,
            "excluded_above_threshold_pixel_count": 0,
        },
        "images": images,
    }


def _eligible_attempt(
    tmp_path: Path,
    stage: str = "a",
    attempt: int = 0,
    *,
    stage_b_covered: tuple[bool, bool] = (True, True),
) -> tuple[Path, Path]:
    output_dir = tmp_path / "output" / "lens-001"
    output_dir.mkdir(parents=True)
    (output_dir / "run-manifest.json").write_text(
        json.dumps(
            {
                "schema_version": "lens_run_manifest.v1",
                "pipeline_release_id": PIPELINE_RELEASE_ID,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    root = output_dir / "attempts" / stage / str(attempt)
    artifact = root / "artifacts" / f"stage_{stage}.pkl"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"test artifact")
    (root / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    _write_execution_marker(root, stage, attempt)
    manifest_artifacts = [
        {
            "path": f"artifacts/stage_{stage}.pkl",
            "role": "stage_pickle",
            "media_type": "application/octet-stream",
        }
    ]
    result_artifacts = {"stage_pickle": f"artifacts/stage_{stage}.pkl"}
    if stage == "b":
        family_root = output_dir / "attempts" / "a" / "0" / "artifacts"
        family_root.mkdir(parents=True, exist_ok=True)
        family = build_predicted_image_family(
            [[1.0, 0.0], [2.0, 0.0]],
            medians={
                "theta_E": 1.2, "e1_mass": 0.0, "e2_mass": 0.0,
                "center_x_mass": 0.0, "center_y_mass": 0.0,
                "gamma1": 0.0, "gamma2": 0.0,
                "center_x_src": 0.0, "center_y_src": 0.0,
            },
            image_shape=(64, 64), pixel_scale_arcsec=0.1,
            stage_attempt="attempts/a/0", solver="optimization",
            solver_config={
                "initial_range": 4.0, "n_x": 400, "n_y": 400,
                "k_keep": 30, "num_iters": 20, "tolerance": 5.0e-4,
                "cluster_tol": 0.08,
            },
            threshold_arcsec=0.1, min_log_like=-1.0e10,
        )
        family_path = family_root / "stage_a_predicted_image_family.json"
        family_path.write_text(json.dumps(family) + "\n", encoding="utf-8")
        (output_dir / "accepted").mkdir(exist_ok=True)
        (output_dir / "accepted" / "a.json").write_text(
            json.dumps({
                "stage": "a", "accepted_attempt": 0,
                "attempt_path": "../attempts/a/0",
            }) + "\n",
            encoding="utf-8",
        )
        audit_path = root / "artifacts" / "stage_b_morphology_audit.json"
        audit_path.write_text(
            json.dumps(
                _stage_b_audit(
                    stage_b_covered,
                    hashlib.sha256(family_path.read_bytes()).hexdigest(),
                )
            ) + "\n",
            encoding="utf-8",
        )
        manifest_artifacts.append(
            {
                "path": "artifacts/stage_b_morphology_audit.json",
                "role": "stage_b_morphology_audit_json",
                "media_type": "application/json",
            }
        )
        result_artifacts["stage_b_morphology_audit_json"] = (
            "artifacts/stage_b_morphology_audit.json"
        )
        component_labels = np.zeros((64, 64), dtype=np.int32)
        component_labels[10, 11] = 1
        component_labels[10, 12] = 2
        component_labels[30, 30] = 3
        fits.writeto(
            root / "artifacts" / "stage_b_component_labels.fits",
            component_labels,
        )
        component_catalog = root / "artifacts" / "stage_b_components.json"
        components = []
        for component_id, (row, col) in enumerate(
            ((10, 11), (10, 12), (30, 30)), start=1
        ):
            components.append(
                {
                    "id": component_id, "status": "kept", "pixel_count": 1,
                    "bbox_rows": [row, row], "bbox_cols": [col, col],
                    "centroid_pixel": [float(row), float(col)],
                    "centroid_arcsec": [0.0, 0.0], "peak_snr": 4.0,
                    "mean_snr": 4.0, "arc_seed_ids": [component_id],
                    "arc_seed_pixel_count": 1, "has_arc_seed": True,
                }
            )
        component_catalog.write_text(
            json.dumps(
                {
                    "schema_version": "stage_b_arc_components.v2",
                    "stage_attempt": f"attempts/b/{attempt}",
                    "image_shape": [64, 64],
                    "mask_convention": (
                        "feature_mask True excludes pixels; component labels identify "
                        "pre-selection candidate arc islands"
                    ),
                    "connectivity": 8,
                    "parameters": {
                        "threshold": 2.0, "ignor_size": 5,
                        "ext_size": 5, "close_size": 3,
                    },
                    "selection": {
                        "effective_keep_component_ids": [1, 2, 3],
                        "drop_component_ids": [],
                    },
                    "component_labels": {
                        "reference": "stage_b_component_labels.fits",
                        "sha256": hashlib.sha256(
                            (root / "artifacts" / "stage_b_component_labels.fits").read_bytes()
                        ).hexdigest(),
                    },
                    "morphology_audit": {
                        "reference": "stage_b_morphology_audit.json",
                        "sha256": hashlib.sha256(audit_path.read_bytes()).hexdigest(),
                    },
                    "candidate_component_count": 3,
                    "all_components_have_arc_seed": True,
                    "excluded_above_threshold_pixel_count": 0,
                    "components": components,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        for path, role, media_type in (
            (
                "artifacts/stage_b_component_labels.fits",
                "stage_b_component_labels_fits",
                "image/fits",
            ),
            (
                "artifacts/stage_b_components.json",
                "stage_b_components_json",
                "application/json",
            ),
        ):
            manifest_artifacts.append(
                {"path": path, "role": role, "media_type": media_type}
            )
        result_artifacts["stage_b_component_labels_fits"] = (
            "artifacts/stage_b_component_labels.fits"
        )
        result_artifacts["stage_b_components_json"] = (
            "artifacts/stage_b_components.json"
        )
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": "attempt_artifact_manifest.v1",
                "artifacts": manifest_artifacts,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (root / "stage-result.json").write_text(
        json.dumps(
            {
                "stage": stage,
                "attempt": attempt,
                "status": "success",
                "eligible_for_review": True,
                "gate_failures": [],
                "artifacts": result_artifacts,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    if stage == "m0":
        level = EffectiveConfig.model_validate_json(
            (root / "effective-config.json").read_text(encoding="utf-8"), strict=True
        ).settings.source_grid_level
        (root / "artifacts" / "source_grid_spec.json").write_text(
            json.dumps(source_grid_spec(center_x=0.0, center_y=0.0, level=level)) + "\n",
            encoding="utf-8",
        )
    return output_dir, root


def _accepted_review(stage: str = "a") -> dict[str, object]:
    review: dict[str, object] = {
        "stage": stage,
        "visual_findings": ["the principal image family is reproduced"],
        "numerical_findings": ["sampling diagnostics are stable"],
        "progression_blockers": [],
        "handoff_warnings": [],
        "upstream_warning_updates": [],
        "retry_repair": None,
        "development_recommendation": None,
        "reason": "the result is safe for progression",
    }
    if stage in {"m1", "m3"}:
        review["scientific_uncertainty"] = None
    return review


def _m1_retry_review(attempt: int = 0) -> dict[str, object]:
    return {
        "stage": "m1",
        "visual_findings": ["the principal image family and coherent source are present"],
        "numerical_findings": ["posterior sampling is unstable at the current budget"],
        "progression_blockers": [
            {
                "kind": "sampling_pathology",
                "evidence": ["effective sample size is insufficient"],
                "impact": "the downstream mass posterior would be unstable",
            }
        ],
        "handoff_warnings": [],
        "upstream_warning_updates": [],
        "retry_repair": {
            "hypothesis": {
                "blocker_kind": "sampling_pathology",
                "expected_improvement": "posterior quantiles stabilize",
            },
            "proposal": {
                "base_config": f"attempts/m1/{attempt}/effective-config.json",
                "parameter": "stage_m1_n_eff",
                "old_value": 600,
                "new_value": 1000,
            },
        },
        "development_recommendation": None,
        "scientific_uncertainty": None,
        "reason": "one local sampling setting can test the instability",
    }


def _stage_b_retry_review(attempt: int = 0) -> dict[str, object]:
    return {
        "stage": "b",
        "refinement_kind": "parameters",
        "predicted_image_dispositions": [
            {
                "image_id": "image_1",
                "disposition": "supported_uncovered",
                "evidence": ["local peak S/N is 4 and its threshold island is excluded"],
            },
            {
                "image_id": "image_2",
                "disposition": "covered_consistent",
                "evidence": ["the nearest pixel belongs to the selected arc region"],
            },
        ],
        "upstream_warning_updates": [],
        "retry_repair": {
            "hypothesis": {
                "blocker_kind": "arc_mask",
                "expected_improvement": "the connected faint arc support is included",
            },
            "proposal": {
                "base_config": f"attempts/b/{attempt}/effective-config.json",
                "parameter": "arc_snr_threshold",
                "old_value": 2.0,
                "new_value": 1.8,
            },
        },
        "component_selection": None,
        "development_recommendation": None,
        "reason": "one mask threshold can test the missing connected support",
    }


@pytest.mark.parametrize(
    ("parameter", "old_value", "new_value"),
    [
        ("arc_ext_size", 5, 7),
        ("arc_close_size", 3, 5),
        ("arc_snr_threshold", 2.0, 2.5),
        ("arc_snr_threshold", 2.0, 2.0),
    ],
)
def test_stage_b_uncovered_requires_lower_snr_threshold(
    tmp_path: Path, parameter: str, old_value: float, new_value: float,
) -> None:
    output_dir, root = _eligible_attempt(
        tmp_path, stage="b", stage_b_covered=(False, True)
    )
    review = _stage_b_retry_review()
    review["retry_repair"]["proposal"].update(
        parameter=parameter, old_value=old_value, new_value=new_value
    )
    response = tmp_path / "response.json"
    response.write_text(json.dumps(review))
    with pytest.raises(ValueError, match="requires lowering arc_snr_threshold"):
        main([
            "review", "adjudicate", "--output-dir", str(output_dir),
            "--stage", "b", "--attempt", "0", "--response", str(response),
        ])
    assert not (root / "decision.json").exists()


def test_stage_b_rejects_arc_ignor_size_proposal(tmp_path: Path) -> None:
    from lens_agent.attempts import validate_retry_review

    output_dir, _ = _eligible_attempt(tmp_path, stage="b")
    review = _stage_b_retry_review()
    review["predicted_image_dispositions"][0]["disposition"] = "supported_partial"
    review["retry_repair"]["proposal"].update(
        parameter="arc_ignor_size", old_value=5, new_value=4
    )
    schema_path = Path(__file__).resolve().parents[1] / ".codex/evals/stage-b-expert-output.schema.json"
    validator = jsonschema.Draft202012Validator(json.loads(schema_path.read_text()))
    assert not validator.is_valid(review)
    with pytest.raises(ValueError):
        validate_retry_review(output_dir, StageName.B, 0, review)


def _record_completed_retries(
    output_dir: Path, stage: str, count: int
) -> None:
    for attempt in range(1, count + 1):
        root = output_dir / "attempts" / stage / str(attempt)
        root.mkdir(parents=True, exist_ok=True)
        (root / "proposal-validation.json").write_text(
            json.dumps({"status": "valid", "stage": stage}) + "\n",
            encoding="utf-8",
        )
        (root / "stage-result.json").write_text(
            json.dumps(
                {
                    "stage": stage,
                    "attempt": attempt,
                    "status": "success",
                }
            )
            + "\n",
            encoding="utf-8",
        )


def _write_execution_marker(root: Path, stage: str, attempt: int) -> None:
    (root / "stage-execution.json").write_text(
        json.dumps(
            {
                "schema_version": "stage_execution.v1",
                "stage": stage,
                "attempt": attempt,
                "pipeline_release_id": PIPELINE_RELEASE_ID,
                "status": "started",
            }
        )
        + "\n",
        encoding="utf-8",
    )


def _decision_without_evidence(
    root: Path, *, has_stage_result: bool = True
) -> dict[str, object]:
    decision = json.loads((root / "decision.json").read_text(encoding="utf-8"))
    evidence = decision.pop("evidence_sha256")
    for name in ("effective-config.json", "stage-execution.json", "manifest.json"):
        assert isinstance(evidence[name], str) and len(evidence[name]) == 64
    if has_stage_result:
        assert isinstance(evidence["stage-result.json"], str)
        assert len(evidence["stage-result.json"]) == 64
    else:
        assert evidence["stage-result.json"] is None
    assert "stage.log" in evidence
    assert "traceback.log" in evidence
    return decision


@pytest.mark.parametrize(
    ("kind", "first", "second", "valid"),
    [
        ("parameters", "supported_partial", "covered_consistent", True),
        ("parameters", "supported_partial", "supported_uncovered", True),
        ("parameters", "supported_uncovered", "covered_consistent", True),
        ("parameters", "covered_consistent", "covered_consistent", False),
        ("parameters", "supported_partial", "indeterminate", False),
        ("parameters", "supported_partial", "unsupported_prediction", False),
        ("selection", "supported_partial", "covered_consistent", False),
        ("selection", "supported_uncovered", "covered_consistent", False),
        ("selection", "covered_consistent", "covered_consistent", True),
        ("none", "supported_partial", "covered_consistent", False),
        ("none", "covered_consistent", "covered_consistent", True),
        ("uncertain", "supported_partial", "indeterminate", True),
        ("uncertain", "supported_uncovered", "covered_consistent", False),
        ("coverage_blocked", "supported_uncovered", "covered_consistent", True),
        ("coverage_blocked", "supported_partial", "covered_consistent", True),
        ("coverage_blocked", "supported_uncovered", "supported_partial", True),
        ("coverage_blocked", "covered_consistent", "covered_consistent", False),
        ("coverage_blocked", "supported_uncovered", "unsupported_prediction", False),
        ("coverage_blocked", "supported_partial", "indeterminate", False),
    ],
)
def test_stage_b_coverage_order_agrees_between_schema_and_python(
    kind: str, first: str, second: str, valid: bool,
) -> None:
    review = _stage_b_retry_review()
    review["refinement_kind"] = kind
    for item, disposition in zip(review["predicted_image_dispositions"], (first, second)):
        item["disposition"] = disposition
    if kind != "parameters":
        review["retry_repair"] = None
    if kind == "selection":
        review["component_selection"] = {
            "component_catalog": "attempts/b/0/artifacts/stage_b_components.json",
            "drop_component_ids": [3],
        }
    schema_path = Path(__file__).resolve().parents[1] / ".codex/evals/stage-b-expert-output.schema.json"
    validator = jsonschema.Draft202012Validator(json.loads(schema_path.read_text()))
    assert validator.is_valid(review) is valid
    if valid:
        assert validate_reviewer_response(review, StageName.B) == review
    else:
        with pytest.raises(ValueError):
            validate_reviewer_response(review, StageName.B)


@pytest.mark.parametrize("field", ["retry_repair", "component_selection", "reason", "evidence"])
def test_stage_b_blocked_coverage_rejects_repairs_and_missing_explanation(field: str) -> None:
    review = _stage_b_retry_review()
    repair = review["retry_repair"]
    review.update(refinement_kind="coverage_blocked", retry_repair=None)
    if field == "retry_repair":
        review[field] = repair
    elif field == "component_selection":
        review[field] = {
            "component_catalog": "attempts/b/0/artifacts/stage_b_components.json",
            "drop_component_ids": [3],
        }
    elif field == "reason":
        review[field] = ""
    else:
        review["predicted_image_dispositions"][0]["evidence"] = []
    schema_path = Path(__file__).resolve().parents[1] / ".codex/evals/stage-b-expert-output.schema.json"
    validator = jsonschema.Draft202012Validator(json.loads(schema_path.read_text()))
    assert not validator.is_valid(review)
    with pytest.raises(ValueError):
        validate_reviewer_response(review, StageName.B)


@pytest.mark.parametrize("partial", [False, True])
def test_stage_b_blocked_coverage_stops_for_human_review(tmp_path: Path, partial: bool) -> None:
    output_dir, root = _eligible_attempt(
        tmp_path, stage="b", stage_b_covered=(partial, True)
    )
    config_path = root / "effective-config.json"
    config = json.loads(config_path.read_text())
    config["settings"]["arc_snr_threshold"] = 2.0 if partial else 1.0
    config_path.write_text(json.dumps(config))
    review = _stage_b_retry_review()
    review.update(
        refinement_kind="coverage_blocked",
        retry_repair=None,
        reason=(
            "Expanding the selected arc would merge credible southern emission with a contaminant; "
            "the current diagnostics show no safe permitted repair."
            if partial else
            "arc_snr_threshold is at its lower bound 1.0; the credible compact image remains "
            "below the fixed five-pixel island requirement."
        ),
        development_recommendation="Inspect the nearby contaminant manually." if partial else None,
    )
    review["predicted_image_dispositions"][0].update(
        disposition="supported_partial" if partial else "supported_uncovered",
        evidence=[
            "stage_b_morphology_audit.png: credible southern emission continues outside the "
            "selected arc towards a separate contaminant."
            if partial else
            "stage_b_morphology_audit.png: the compact counterimage east of the lens agrees "
            "with the Stage-A prediction but its threshold island has only four pixels."
        ],
    )
    schema_path = Path(__file__).resolve().parents[1] / ".codex/evals/stage-b-expert-output.schema.json"
    jsonschema.Draft202012Validator(json.loads(schema_path.read_text())).validate(review)
    response = tmp_path / "response.json"
    response.write_text(json.dumps(review))
    main([
        "review", "adjudicate", "--output-dir", str(output_dir),
        "--stage", "b", "--attempt", "0", "--response", str(response),
    ])
    decision = json.loads((root / "decision.json").read_text())
    assert decision["decision"] == "human_review"
    assert decision["reason_kind"] == "scientific_blocker"
    assert decision["reason"] == review["reason"]
    assert "retry_budget" not in decision
    assert "failure_code" not in decision
    assert decision.get("development_recommendation") == review["development_recommendation"]
    assert json.loads((root / "review.json").read_text()) == review
    with pytest.raises(ValueError, match="candidate decision is not accept"):
        main([
            "attempt", "promote", "--output-dir", str(output_dir),
            "--stage", "b", "--attempt", "0",
        ])
    with pytest.raises(ValueError, match="requires a canonical retry decision"):
        main([
            "attempt", "prepare", "--output-dir", str(output_dir),
            "--stage", "b", "--attempt", "1",
        ])
    assert not (output_dir / "accepted" / "b.json").exists()
    assert not (output_dir / "attempts" / "b" / "1").exists()


@pytest.mark.parametrize("covered", [True, False])
def test_stage_b_partial_requires_covered_position_and_can_prepare_retry(
    tmp_path: Path, covered: bool,
) -> None:
    output_dir, root = _eligible_attempt(
        tmp_path, stage="b", stage_b_covered=(covered, True)
    )
    review = _stage_b_retry_review()
    review["predicted_image_dispositions"][0].update(
        disposition="supported_partial",
        evidence=[
            "stage_b_morphology_audit.png: continuous southern emission extends beyond the cyan boundary"
        ],
    )
    review["retry_repair"]["proposal"].update(
        parameter="arc_ext_size", old_value=5, new_value=7
    )
    response = tmp_path / "response.json"
    response.write_text(json.dumps(review))
    command = [
        "review", "adjudicate", "--output-dir", str(output_dir),
        "--stage", "b", "--attempt", "0", "--response", str(response),
    ]
    if not covered:
        with pytest.raises(ValueError, match="supported_partial conflicts"):
            main(command)
        assert not (root / "decision.json").exists()
        return
    main(command)
    assert json.loads((root / "decision.json").read_text())["decision"] == "retry"
    main([
        "attempt", "prepare", "--output-dir", str(output_dir),
        "--stage", "b", "--attempt", "1",
    ])
    candidate = output_dir / "attempts/b/1"
    config = json.loads((candidate / "effective-config.json").read_text())
    assert config["settings"]["arc_ext_size"] == 7
    assert not (candidate / "arc-component-selection.json").exists()


def test_stage_b_partial_routes_to_human_review_when_budget_exhausted(tmp_path: Path) -> None:
    output_dir, root = _eligible_attempt(tmp_path, stage="b")
    _record_completed_retries(output_dir, "b", 10)
    review = _stage_b_retry_review()
    review["predicted_image_dispositions"][0]["disposition"] = "supported_partial"
    response = tmp_path / "response.json"
    response.write_text(json.dumps(review))
    main([
        "review", "adjudicate", "--output-dir", str(output_dir),
        "--stage", "b", "--attempt", "0", "--response", str(response),
    ])
    decision = json.loads((root / "decision.json").read_text())
    assert decision["decision"] == "human_review"
    assert "retry budget is exhausted" in decision["reason"]


def test_stage_b_allows_component_selection_when_all_images_are_covered() -> None:
    review = {
        "stage": "b",
        "refinement_kind": "selection",
        "predicted_image_dispositions": [
            {
                "image_id": f"image_{index}",
                "disposition": "covered_consistent",
                "evidence": ["the nearest predicted-image pixel is covered"],
            }
            for index in (1, 2)
        ],
        "upstream_warning_updates": [],
        "retry_repair": None,
        "component_selection": {
            "component_catalog": "attempts/b/0/artifacts/stage_b_components.json",
            "drop_component_ids": [3],
        },
        "development_recommendation": None,
        "reason": "component 3 is unrelated to the covered image family",
    }

    assert validate_reviewer_response(review, StageName.B) == review


def test_stage_b_rejects_selection_that_would_uncover_a_predicted_image(
    tmp_path: Path,
) -> None:
    output_dir, _ = _eligible_attempt(tmp_path, stage="b")
    response = tmp_path / "response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "b",
                "refinement_kind": "selection",
                "predicted_image_dispositions": [
                    {
                        "image_id": f"image_{index}",
                        "disposition": "covered_consistent",
                        "evidence": ["the nearest predicted-image pixel is covered"],
                    }
                    for index in (1, 2)
                ],
                "upstream_warning_updates": [],
                "retry_repair": None,
                "component_selection": {
                    "component_catalog": (
                        "attempts/b/0/artifacts/stage_b_components.json"
                    ),
                    "drop_component_ids": [1],
                },
                "development_recommendation": None,
                "reason": "incorrectly drops the first predicted image",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="uncover predicted images: image_1"):
        main(
            [
                "review", "adjudicate", "--output-dir", str(output_dir),
                "--stage", "b", "--attempt", "0", "--response", str(response),
            ]
        )


@pytest.mark.parametrize(
    ("evidence_problem", "error_match"),
    (
        ("stale", "labels do not match the parent"),
        ("cropped", "label image has the wrong shape"),
    ),
)
def test_stage_b_rejects_selection_with_inconsistent_component_labels(
    tmp_path: Path, evidence_problem: str, error_match: str
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="b")
    labels_path = attempt_root / "artifacts" / "stage_b_component_labels.fits"
    labels = np.asarray(fits.getdata(labels_path), dtype=np.int32)
    if evidence_problem == "stale":
        labels[40, 40] = 3
    else:
        labels = labels[:40, :40]
    fits.writeto(labels_path, labels, overwrite=True)
    if evidence_problem == "cropped":
        catalog_path = attempt_root / "artifacts" / "stage_b_components.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        catalog["component_labels"]["sha256"] = hashlib.sha256(
            labels_path.read_bytes()
        ).hexdigest()
        catalog_path.write_text(json.dumps(catalog) + "\n", encoding="utf-8")
    response = tmp_path / "response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "b",
                "refinement_kind": "selection",
                "predicted_image_dispositions": [
                    {
                        "image_id": f"image_{index}",
                        "disposition": "covered_consistent",
                        "evidence": ["the nearest predicted-image pixel is covered"],
                    }
                    for index in (1, 2)
                ],
                "upstream_warning_updates": [],
                "retry_repair": None,
                "component_selection": {
                    "component_catalog": (
                        "attempts/b/0/artifacts/stage_b_components.json"
                    ),
                    "drop_component_ids": [3],
                },
                "development_recommendation": None,
                "reason": "component 3 is unrelated to the predicted images",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match=error_match):
        main(
            [
                "review", "adjudicate", "--output-dir", str(output_dir),
                "--stage", "b", "--attempt", "0", "--response", str(response),
            ]
        )


def test_failed_stage_decision_seals_log_and_traceback_hashes(tmp_path: Path) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    (attempt_root / "stage.log").write_text("stage failed\n", encoding="utf-8")
    (attempt_root / "traceback.log").write_text(
        "RuntimeError: solver failed\n", encoding="utf-8"
    )
    (attempt_root / "stage-result.json").write_text(
        json.dumps(
            {
                "stage": "a",
                "attempt": 0,
                "status": "failed",
                "eligible_for_review": False,
                "gate_failures": ["stage command failed"],
                "artifacts": {},
                "error": "RuntimeError: solver failed",
                "traceback_log": "traceback.log",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )

    decision = json.loads((attempt_root / "decision.json").read_text(encoding="utf-8"))
    evidence = decision["evidence_sha256"]
    assert evidence["stage.log"] == hashlib.sha256(b"stage failed\n").hexdigest()
    assert evidence["traceback.log"] == hashlib.sha256(
        b"RuntimeError: solver failed\n"
    ).hexdigest()


def test_adjudicate_registers_an_eligible_stage_acceptance(tmp_path: Path) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_accepted_review()) + "\n", encoding="utf-8")

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )

    assert json.loads((attempt_root / "review.json").read_text(encoding="utf-8")) == (
        _accepted_review()
    )
    assert _decision_without_evidence(attempt_root) == {
        "schema_version": "stage_decision.v1",
        "stage": "a",
        "attempt": 0,
        "decision": "accept",
        "reason": "the result is safe for progression",
        "unresolved_warnings": [],
    }


def test_adjudicate_rejects_a_stage_result_without_execution_evidence(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    (attempt_root / "stage-execution.json").unlink()
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_accepted_review()) + "\n", encoding="utf-8")

    try:
        main(
            [
                "review",
                "adjudicate",
                "--output-dir",
                str(output_dir),
                "--stage",
                "a",
                "--attempt",
                "0",
                "--response",
                str(response),
            ]
        )
    except ValueError as error:
        assert "execution marker" in str(error)
    else:
        raise AssertionError("a stage result without execution evidence was adjudicated")
    assert not (attempt_root / "decision.json").exists()


def test_retry_preparation_requires_the_canonical_adjudicated_review(
    tmp_path: Path,
) -> None:
    output_dir, parent = _eligible_attempt(tmp_path, stage="m1")
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_m1_retry_review()) + "\n", encoding="utf-8")

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m1",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )
    main(
        [
            "attempt",
            "prepare",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m1",
            "--attempt",
            "1",
        ]
    )

    assert json.loads((parent / "decision.json").read_text(encoding="utf-8"))[
        "decision"
    ] == "retry"
    candidate = json.loads(
        (output_dir / "attempts" / "m1" / "1" / "effective-config.json").read_text(
            encoding="utf-8"
        )
    )
    assert candidate["settings"]["stage_m1_n_eff"] == 1000


def test_retry_preparation_rejects_a_decision_for_another_attempt(
    tmp_path: Path,
) -> None:
    output_dir, parent = _eligible_attempt(tmp_path, stage="m1")
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_m1_retry_review()) + "\n", encoding="utf-8")
    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m1",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )
    decision_path = parent / "decision.json"
    decision = json.loads(decision_path.read_text(encoding="utf-8"))
    decision["attempt"] = 9
    decision_path.write_text(json.dumps(decision) + "\n", encoding="utf-8")

    try:
        main(
            [
                "attempt",
                "prepare",
                "--output-dir",
                str(output_dir),
                "--stage",
                "m1",
                "--attempt",
                "1",
            ]
        )
    except ValueError as error:
        assert "identify" in str(error)
    else:
        raise AssertionError("retry preparation trusted a decision for another attempt")
    assert not (output_dir / "attempts" / "m1" / "1").exists()


def test_promotion_is_idempotent_but_does_not_replace_a_conflicting_head(
    tmp_path: Path,
) -> None:
    output_dir, _ = _eligible_attempt(tmp_path)
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_accepted_review()) + "\n", encoding="utf-8")
    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )
    command = [
        "attempt",
        "promote",
        "--output-dir",
        str(output_dir),
        "--stage",
        "a",
        "--attempt",
        "0",
    ]
    main(command)
    head_path = output_dir / "accepted" / "a.json"
    original = head_path.read_text(encoding="utf-8")
    main(command)
    assert head_path.read_text(encoding="utf-8") == original

    conflicting = json.loads(original)
    conflicting["accepted_attempt"] = 7
    head_path.write_text(json.dumps(conflicting) + "\n", encoding="utf-8")
    try:
        main(command)
    except ValueError as error:
        assert "Accepted Stage Head" in str(error)
    else:
        raise AssertionError("promotion replaced a conflicting Accepted Stage Head")
    assert json.loads(head_path.read_text(encoding="utf-8")) == conflicting


def test_promotion_rejects_an_artifact_changed_after_adjudication(tmp_path: Path) -> None:
    output_dir, root = _eligible_attempt(tmp_path)
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_accepted_review()) + "\n", encoding="utf-8")
    main([
        "review", "adjudicate", "--output-dir", str(output_dir),
        "--stage", "a", "--attempt", "0", "--response", str(response),
    ])
    (root / "artifacts" / "stage_a.pkl").write_bytes(b"changed after review")

    with pytest.raises(ValueError, match="artifact:artifacts/stage_a.pkl"):
        main([
            "attempt", "promote", "--output-dir", str(output_dir),
            "--stage", "a", "--attempt", "0",
        ])


def test_adjudicate_routes_a_hard_gate_failure_without_scientific_review(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="m2")
    result_path = attempt_root / "stage-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result.update(
        status="success",
        eligible_for_review=False,
        gate_failures=["non-finite numerical output: metrics.log_z"],
    )
    result_path.write_text(json.dumps(result) + "\n", encoding="utf-8")

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m2",
            "--attempt",
            "0",
        ]
    )

    assert not (attempt_root / "review.json").exists()
    assert _decision_without_evidence(attempt_root) == {
        "schema_version": "stage_decision.v1",
        "stage": "m2",
        "attempt": 0,
        "decision": "human_review",
        "reason_kind": "operational_failure",
        "reason": "non-finite numerical output: metrics.log_z",
    }


def test_unrepairable_blocker_preserves_a_non_executable_development_recommendation(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="m1")
    review = _accepted_review("m1")
    review["progression_blockers"] = [
        {
            "kind": "structural_image_family_failure",
            "evidence": ["one principal counterimage is not reproduced"],
            "impact": "the current simple mass family is scientifically inadequate",
        }
    ]
    review["development_recommendation"] = (
        "evaluate a new Pipeline Release with a more expressive mass family"
    )
    review["reason"] = "no M1-local Tunable Catalog setting can repair the topology"
    response = tmp_path / "response.json"
    response.write_text(json.dumps(review) + "\n", encoding="utf-8")

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m1",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )

    decision = json.loads((attempt_root / "decision.json").read_text(encoding="utf-8"))
    assert decision["decision"] == "human_review"
    assert decision["development_recommendation"] == review[
        "development_recommendation"
    ]


def test_adjudicate_accepts_eligible_m0_after_grid_review(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="m0")
    response = tmp_path / "m0-response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "m0",
                "grid_judgment": "grid_sufficient",
                "visual_findings": ["coherent emission is interior to the footprint"],
                "numerical_findings": ["edge flux does not show visible clipping"],
                "reason": "the source grid is sufficient",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m0",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )

    assert (attempt_root / "review.json").is_file()
    assert _decision_without_evidence(attempt_root) == {
        "schema_version": "stage_decision.v1",
        "stage": "m0",
        "attempt": 0,
        "decision": "accept",
        "reason": "the source grid is sufficient",
        "unresolved_warnings": [],
    }


def test_adjudicate_retries_m0_confirmed_truncation_before_maximum_grid(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="m0")
    response = tmp_path / "m0-response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "m0",
                "grid_judgment": "source_bbox_truncation",
                "visual_findings": ["coherent interior emission is clipped at the right edge"],
                "numerical_findings": ["right-edge flux supports the visual continuation"],
                "reason": "the current source grid truncates coherent emission",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review", "adjudicate", "--output-dir", str(output_dir),
            "--stage", "m0", "--attempt", "0", "--response", str(response),
        ]
    )

    decision = _decision_without_evidence(attempt_root)
    assert decision["decision"] == "retry"
    assert decision["retry_budget"] == {
        "stage_used": 0,
        "stage_limit": 5,
        "shared_used": 0,
        "shared_limit": 15,
    }


def test_adjudicate_routes_indeterminate_m0_to_scientific_uncertainty(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="m0")
    response = tmp_path / "m0-response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "m0",
                "grid_judgment": "indeterminate",
                "visual_findings": ["edge morphology is ambiguous"],
                "numerical_findings": ["edge flux alone is inconclusive"],
                "reason": "truncation cannot be distinguished from pathology",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review", "adjudicate", "--output-dir", str(output_dir),
            "--stage", "m0", "--attempt", "0", "--response", str(response),
        ]
    )

    decision = _decision_without_evidence(attempt_root)
    assert decision["decision"] == "human_review"
    assert decision["reason_kind"] == "scientific_uncertainty"


def test_adjudicate_routes_maximum_m0_truncation_to_scientific_blocker(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="m0", attempt=2)
    config = EffectiveConfig(
        settings=EffectiveConfig().settings.model_copy(update={"source_grid_level": 2})
    )
    (attempt_root / "effective-config.json").write_text(
        json.dumps(config.model_dump(mode="json")) + "\n", encoding="utf-8"
    )
    (attempt_root / "artifacts" / "source_grid_spec.json").write_text(
        json.dumps(source_grid_spec(center_x=0.0, center_y=0.0, level=2)) + "\n",
        encoding="utf-8",
    )
    response = tmp_path / "m0-response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "m0",
                "grid_judgment": "source_bbox_truncation",
                "visual_findings": ["coherent emission remains clipped at level 2"],
                "numerical_findings": ["edge flux supports the visible clipping"],
                "reason": "the maximum source footprint remains insufficient",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review", "adjudicate", "--output-dir", str(output_dir),
            "--stage", "m0", "--attempt", "2", "--response", str(response),
        ]
    )

    decision = _decision_without_evidence(attempt_root)
    assert decision["decision"] == "human_review"
    assert decision["reason_kind"] == "scientific_blocker"


@pytest.mark.parametrize("stage", ["m1", "m3"])
def test_late_pixel_stage_source_grid_uncertainty_routes_to_human_review(
    tmp_path: Path, stage: str
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage=stage)
    review = _accepted_review(stage)
    review["scientific_uncertainty"] = {
        "kind": "source_grid_sufficiency",
        "evidence": ["clipping cannot be distinguished from boundary-only pathology"],
        "impact": "the final source cannot be interpreted safely",
    }
    review["reason"] = "source-grid sufficiency is scientifically indeterminate"
    response = tmp_path / f"{stage}-response.json"
    response.write_text(json.dumps(review) + "\n", encoding="utf-8")

    main(
        [
            "review", "adjudicate", "--output-dir", str(output_dir),
            "--stage", stage, "--attempt", "0", "--response", str(response),
        ]
    )

    decision = _decision_without_evidence(attempt_root)
    assert decision["decision"] == "human_review"
    assert decision["reason_kind"] == "scientific_uncertainty"


def test_stage_b_decision_is_derived_from_refinement_evidence(tmp_path: Path) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="b")
    upstream = output_dir / "attempts" / "a" / "0"
    upstream.mkdir(parents=True, exist_ok=True)
    warning = {
        "warning_ref": "a:0:w0",
        "kind": "prior_boundary_contact",
        "evidence": ["theta_E support approaches the configured boundary"],
        "impact": "monitor whether downstream inference remains interior",
        "expected_resolution_stage": "m1",
    }
    (upstream / "decision.json").write_text(
        json.dumps({"decision": "accept", "unresolved_warnings": [warning]}) + "\n",
        encoding="utf-8",
    )
    accepted = output_dir / "accepted"
    accepted.mkdir(exist_ok=True)
    (accepted / "a.json").write_text(
        json.dumps(
            {
                "stage": "a",
                "accepted_attempt": 0,
                "attempt_path": "../attempts/a/0",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    response = tmp_path / "response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "b",
                "refinement_kind": "none",
                "predicted_image_dispositions": [
                    {
                        "image_id": "image_1",
                        "disposition": "covered_consistent",
                        "evidence": ["nearest pixel is covered and local support is coherent"],
                    },
                    {
                        "image_id": "image_2",
                        "disposition": "covered_consistent",
                        "evidence": ["nearest pixel is covered and local support is coherent"],
                    },
                ],
                "upstream_warning_updates": [
                    {
                        "warning_ref": "a:0:w0",
                        "status": "persisted",
                        "evidence": ["the Stage-B mask does not resolve this mass-prior warning"],
                    }
                ],
                "retry_repair": None,
                "component_selection": None,
                "development_recommendation": None,
                "reason": "the executed feature mask is scientifically acceptable",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "b",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )

    decision = json.loads((attempt_root / "decision.json").read_text(encoding="utf-8"))
    assert decision["decision"] == "accept"
    assert decision["unresolved_warnings"][0]["warning_ref"] == "a:0:w0"
    assert decision["unresolved_warnings"][0]["latest_update"]["status"] == "persisted"


@pytest.mark.parametrize(
    ("disposition", "reason_kind"),
    [
        ("unsupported_prediction", "scientific_blocker"),
        ("indeterminate", "scientific_uncertainty"),
    ],
)
def test_stage_b_human_review_reason_comes_from_per_image_dispositions(
    tmp_path: Path, disposition: str, reason_kind: str
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="b")
    response = tmp_path / "response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "b",
                "refinement_kind": "uncertain",
                "predicted_image_dispositions": [
                    {
                        "image_id": "image_1",
                        "disposition": disposition,
                        "evidence": ["the local data do not securely support this prediction"],
                    },
                    {
                        "image_id": "image_2",
                        "disposition": "covered_consistent",
                        "evidence": ["the nearest pixel is covered by coherent support"],
                    },
                ],
                "upstream_warning_updates": [],
                "retry_repair": None,
                "component_selection": None,
                "development_recommendation": None,
                "reason": "the predicted image family requires human scientific review",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review", "adjudicate", "--output-dir", str(output_dir),
            "--stage", "b", "--attempt", "0", "--response", str(response),
        ]
    )

    decision = json.loads((attempt_root / "decision.json").read_text())
    assert decision["decision"] == "human_review"
    assert decision["reason_kind"] == reason_kind


def test_stage_b_review_must_classify_each_audit_image_exactly_once(tmp_path: Path) -> None:
    output_dir, _ = _eligible_attempt(tmp_path, stage="b")
    response = tmp_path / "response.json"
    response.write_text(
        json.dumps(
            {
                "stage": "b",
                "refinement_kind": "none",
                "predicted_image_dispositions": [
                    {
                        "image_id": "image_1",
                        "disposition": "covered_consistent",
                        "evidence": ["covered"],
                    },
                    {
                        "image_id": "image_1",
                        "disposition": "covered_consistent",
                        "evidence": ["covered twice"],
                    },
                ],
                "upstream_warning_updates": [],
                "retry_repair": None,
                "component_selection": None,
                "development_recommendation": None,
                "reason": "invalid duplicate",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="exactly once"):
        main(
            [
                "review", "adjudicate", "--output-dir", str(output_dir),
                "--stage", "b", "--attempt", "0", "--response", str(response),
            ]
        )


def test_stage_retry_budget_is_reconstructed_from_completed_attempts(
    tmp_path: Path,
) -> None:
    output_dir, current = _eligible_attempt(tmp_path, stage="m1", attempt=5)
    for attempt in range(1, 6):
        root = output_dir / "attempts" / "m1" / str(attempt)
        root.mkdir(parents=True, exist_ok=True)
        (root / "proposal-validation.json").write_text(
            json.dumps({"status": "valid", "stage": "m1"}) + "\n",
            encoding="utf-8",
        )
        if attempt != 5:
            (root / "stage-result.json").write_text(
                json.dumps(
                    {
                        "stage": "m1",
                        "attempt": attempt,
                        "status": "success",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_m1_retry_review(5)) + "\n", encoding="utf-8")

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m1",
            "--attempt",
            "5",
            "--response",
            str(response),
        ]
    )

    decision = json.loads((current / "decision.json").read_text(encoding="utf-8"))
    assert decision["decision"] == "human_review"
    assert decision["reason_kind"] == "scientific_blocker"
    assert "retry budget" in decision["reason"]


def test_shared_retry_budget_is_reconstructed_across_physical_stages(
    tmp_path: Path,
) -> None:
    output_dir, current = _eligible_attempt(tmp_path, stage="m1")
    for stage in ("a", "m2", "m3"):
        _record_completed_retries(output_dir, stage, 5)
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_m1_retry_review()) + "\n", encoding="utf-8")

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m1",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )

    decision = json.loads((current / "decision.json").read_text(encoding="utf-8"))
    assert decision["decision"] == "human_review"
    assert "shared physical-stage retry budget" in decision["reason"]


def test_stage_b_retry_budget_is_independent_of_the_shared_physical_budget(
    tmp_path: Path,
) -> None:
    output_dir, current = _eligible_attempt(
        tmp_path, stage="b", stage_b_covered=(False, True)
    )
    for stage in ("a", "m2", "m3"):
        _record_completed_retries(output_dir, stage, 5)
    response = tmp_path / "response.json"
    response.write_text(
        json.dumps(_stage_b_retry_review()) + "\n", encoding="utf-8"
    )

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "b",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )

    decision = json.loads((current / "decision.json").read_text(encoding="utf-8"))
    assert decision["decision"] == "retry"


def test_adjudicate_requires_exact_upstream_warning_updates(tmp_path: Path) -> None:
    output_dir, current = _eligible_attempt(tmp_path, stage="m1")
    upstream = output_dir / "attempts" / "a" / "0"
    upstream.mkdir(parents=True)
    warning = {
        "warning_ref": "a:0:w0",
        "kind": "prior_boundary_contact",
        "evidence": ["theta_E support approaches the configured boundary"],
        "impact": "monitor whether downstream inference remains interior",
        "expected_resolution_stage": "m1",
    }
    (upstream / "decision.json").write_text(
        json.dumps({"decision": "accept", "unresolved_warnings": [warning]}) + "\n",
        encoding="utf-8",
    )
    accepted = output_dir / "accepted"
    accepted.mkdir()
    (accepted / "a.json").write_text(
        json.dumps(
            {
                "stage": "a",
                "accepted_attempt": 0,
                "attempt_path": "../attempts/a/0",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    response = tmp_path / "response.json"
    review = _accepted_review("m1")
    response.write_text(json.dumps(review) + "\n", encoding="utf-8")

    try:
        main(
            [
                "review",
                "adjudicate",
                "--output-dir",
                str(output_dir),
                "--stage",
                "m1",
                "--attempt",
                "0",
                "--response",
                str(response),
            ]
        )
    except ValueError as error:
        assert "exactly once" in str(error)
    else:
        raise AssertionError("missing warning update was accepted")
    assert not (current / "review.json").exists()
    assert not (current / "decision.json").exists()

    review["upstream_warning_updates"] = [
        {
            "warning_ref": "a:0:w0",
            "status": "persisted",
            "evidence": ["M1 remains close to the same boundary"],
        }
    ]
    review["handoff_warnings"] = [
        {
            "kind": "model_limited_residual",
            "evidence": ["a localized residual remains beside the principal arc"],
            "impact": "monitor its influence on the final mass result",
            "expected_resolution_stage": "m3",
        }
    ]
    response.write_text(json.dumps(review) + "\n", encoding="utf-8")
    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m1",
            "--attempt",
            "0",
            "--response",
            str(response),
        ]
    )

    unresolved = json.loads((current / "decision.json").read_text(encoding="utf-8"))[
        "unresolved_warnings"
    ]
    assert [item["warning_ref"] for item in unresolved] == ["a:0:w0", "m1:0:w0"]
    assert unresolved[0]["latest_update"]["status"] == "persisted"


def test_adjudicate_is_idempotent_but_rejects_conflicting_evidence(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_accepted_review()) + "\n", encoding="utf-8")
    command = [
        "review",
        "adjudicate",
        "--output-dir",
        str(output_dir),
        "--stage",
        "a",
        "--attempt",
        "0",
        "--response",
        str(response),
    ]

    main(command)
    original_review = (attempt_root / "review.json").read_text(encoding="utf-8")
    original_decision = (attempt_root / "decision.json").read_text(encoding="utf-8")
    result_path = attempt_root / "stage-result.json"
    original_result = result_path.read_text(encoding="utf-8")
    main(command)
    assert (attempt_root / "review.json").read_text(encoding="utf-8") == original_review
    assert (attempt_root / "decision.json").read_text(encoding="utf-8") == original_decision

    changed_result = json.loads(original_result)
    changed_result["metrics"] = {"audit_probe": 1}
    result_path.write_text(json.dumps(changed_result) + "\n", encoding="utf-8")
    try:
        main(command)
    except ValueError as error:
        assert "stage-result.json no longer matches" in str(error)
    else:
        raise AssertionError("changed stage evidence was treated as an idempotent adjudication")
    assert (attempt_root / "decision.json").read_text(encoding="utf-8") == original_decision
    result_path.write_text(original_result, encoding="utf-8")

    changed = _accepted_review()
    changed["reason"] = "a conflicting second scientific assessment"
    response.write_text(json.dumps(changed) + "\n", encoding="utf-8")
    try:
        main(command)
    except ValueError as error:
        assert "already adjudicated" in str(error)
    else:
        raise AssertionError("conflicting adjudication overwrote sealed evidence")
    assert (attempt_root / "review.json").read_text(encoding="utf-8") == original_review
    assert (attempt_root / "decision.json").read_text(encoding="utf-8") == original_decision


def test_adjudicate_rejects_replay_after_canonical_review_is_rewritten(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    response = tmp_path / "response.json"
    response.write_text(json.dumps(_accepted_review()) + "\n", encoding="utf-8")
    command = [
        "review",
        "adjudicate",
        "--output-dir",
        str(output_dir),
        "--stage",
        "a",
        "--attempt",
        "0",
        "--response",
        str(response),
    ]

    main(command)
    review_path = attempt_root / "review.json"
    decision_path = attempt_root / "decision.json"
    original_review = review_path.read_bytes()
    original_decision = decision_path.read_text(encoding="utf-8")
    decision = json.loads(original_decision)
    assert decision["evidence_sha256"]["review.json"] == hashlib.sha256(
        original_review
    ).hexdigest()

    review_path.write_text(
        json.dumps(json.loads(original_review)) + "\n", encoding="utf-8"
    )
    try:
        main(command)
    except ValueError as error:
        assert "no longer matches" in str(error)
    else:
        raise AssertionError("a byte-level review rewrite passed its recorded fingerprint")
    assert decision_path.read_text(encoding="utf-8") == original_decision
    review_path.write_bytes(original_review)

    changed_review = json.loads(original_review)
    changed_review["visual_findings"] = [
        "a conflicting scientific finding was written after adjudication"
    ]
    changed_text = json.dumps(changed_review, indent=2) + "\n"
    review_path.write_text(changed_text, encoding="utf-8")
    response.write_text(changed_text, encoding="utf-8")

    try:
        main(command)
    except ValueError as error:
        assert "no longer matches" in str(error)
    else:
        raise AssertionError("a rewritten canonical review was treated as an idempotent replay")
    assert decision_path.read_text(encoding="utf-8") == original_decision


def test_stage_command_cannot_overwrite_a_completed_attempt(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("lens_agent.stages.check_stage_input", lambda *_: None)
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    original = (attempt_root / "stage-result.json").read_text(encoding="utf-8")

    main(
        [
            "stage",
            "--lens-dir",
            str(tmp_path / "input" / "lens-001"),
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )
    assert (attempt_root / "stage-result.json").read_text(encoding="utf-8") == original


def test_stage_command_cannot_restart_an_interrupted_attempt(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("lens_agent.stages.check_stage_input", lambda *_: None)
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    (attempt_root / "stage-result.json").unlink()
    marker = attempt_root / "stage-execution.json"
    _write_execution_marker(attempt_root, "a", 0)
    original = marker.read_text(encoding="utf-8")

    try:
        main(
            [
                "stage",
                "--lens-dir",
                str(tmp_path / "input" / "lens-001"),
                "--output-dir",
                str(output_dir),
                "--stage",
                "a",
                "--attempt",
                "0",
            ]
        )
    except ValueError as error:
        assert "already started" in str(error)
    else:
        raise AssertionError("interrupted attempt was executed again")
    assert marker.read_text(encoding="utf-8") == original


def test_adjudicate_registers_a_closed_operational_failure_code(tmp_path: Path) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    (attempt_root / "stage-result.json").unlink()
    _write_execution_marker(attempt_root, "a", 0)

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
            "--failure",
            "stage_a_timeout",
        ]
    )

    assert _decision_without_evidence(attempt_root, has_stage_result=False) == {
        "schema_version": "stage_decision.v1",
        "stage": "a",
        "attempt": 0,
        "decision": "human_review",
        "reason_kind": "operational_failure",
        "failure_code": "stage_a_timeout",
        "reason": "Stage A exceeded 1800 seconds",
    }


def test_response_contract_failure_requires_and_uses_an_eligible_result(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path, stage="m3")

    main(
        [
            "review",
            "adjudicate",
            "--output-dir",
            str(output_dir),
            "--stage",
            "m3",
            "--attempt",
            "0",
            "--failure",
            "response_contract_failure",
        ]
    )

    decision = _decision_without_evidence(attempt_root)
    assert decision == {
        "schema_version": "stage_decision.v1",
        "stage": "m3",
        "attempt": 0,
        "decision": "human_review",
        "reason_kind": "operational_failure",
        "failure_code": "response_contract_failure",
        "reason": "Stage Expert failed the response contract after two corrections",
    }


def test_operational_execution_failure_requires_a_matching_start_marker(
    tmp_path: Path,
) -> None:
    output_dir, attempt_root = _eligible_attempt(tmp_path)
    (attempt_root / "stage-result.json").unlink()
    (attempt_root / "stage-execution.json").unlink()

    try:
        main(
            [
                "review",
                "adjudicate",
                "--output-dir",
                str(output_dir),
                "--stage",
                "a",
                "--attempt",
                "0",
                "--failure",
                "incomplete_stage_execution",
            ]
        )
    except ValueError as error:
        assert "execution marker" in str(error)
    else:
        raise AssertionError("an execution failure was registered without execution evidence")
    assert not (attempt_root / "decision.json").exists()
