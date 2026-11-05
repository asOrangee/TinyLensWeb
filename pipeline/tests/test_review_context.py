import hashlib
import json
from pathlib import Path

from lens_agent.attempts import CORE_EVIDENCE_FILES, prepare_attempt
from lens_agent.configuration import EffectiveConfig, PIPELINE_RELEASE_ID
from lens_agent.models import StageName
from lens_agent.modeling.predicted_image_family import build_predicted_image_family
from lens_agent.review_context import build_review_context
from tests.helpers import model_inspector_decision


def _write_family(root: Path, attempt: int = 0) -> dict:
    family = build_predicted_image_family(
        [[-0.5, 0.5], [0.5, -0.5]],
        medians={
            "theta_E": 1.2, "e1_mass": 0.0, "e2_mass": 0.0,
            "center_x_mass": 0.0, "center_y_mass": 0.0,
            "gamma1": 0.0, "gamma2": 0.0,
            "center_x_src": 0.0, "center_y_src": 0.0,
        },
        image_shape=(32, 32), pixel_scale_arcsec=0.1,
        stage_attempt=f"attempts/a/{attempt}", solver="optimization",
        solver_config={
            "initial_range": 4.0, "n_x": 400, "n_y": 400, "k_keep": 30,
            "num_iters": 20, "tolerance": 5.0e-4, "cluster_tol": 0.08,
        }, threshold_arcsec=0.1,
        min_log_like=-1.0e10,
    )
    artifact = root / "artifacts" / "stage_a_predicted_image_family.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps(family) + "\n", encoding="utf-8")
    diagnostic = root / "diagnostics" / "stage_a_model.png"
    diagnostic.parent.mkdir(parents=True, exist_ok=True)
    diagnostic.write_bytes(b"png")
    return family


def test_review_context_is_stage_scoped_and_recovers_retry_lineage(tmp_path: Path) -> None:
    output_dir = tmp_path / "lens-001"
    output_dir.mkdir()
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
    preflight = output_dir / "preflight"
    preflight.mkdir()
    (preflight / "inspector.json").write_text(
        json.dumps(model_inspector_decision(output_dir.name)) + "\n",
        encoding="utf-8",
    )
    prepare_attempt(output_dir, StageName.A, 0)
    parent = output_dir / "attempts" / "a" / "0"
    (parent / "stage-result.json").write_text(
        json.dumps(
            {
                "stage": "a",
                "attempt": 0,
                "eligible_for_review": True,
                "artifacts": {
                    "model_png": "diagnostics/stage_a_model.png",
                    "stage_pickle": "artifacts/stage_a.pkl",
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    review = parent / "review.json"
    review.write_text(
        json.dumps(
            {
                "stage": "a",
                "visual_findings": ["the principal image family is captured"],
                "numerical_findings": ["sampling support is unstable"],
                "progression_blockers": [
                    {
                        "kind": "sampling_pathology",
                        "evidence": ["effective sample support is unstable"],
                        "impact": "the downstream initialization is unreliable",
                    }
                ],
                "handoff_warnings": [],
                "upstream_warning_updates": [],
                "retry_repair": {
                    "hypothesis": {
                        "blocker_kind": "sampling_pathology",
                        "expected_improvement": "posterior sampling stabilizes",
                    },
                    "proposal": {
                        "base_config": "attempts/a/0/effective-config.json",
                        "parameter": "stage_a_n_live",
                        "old_value": 200,
                        "new_value": 320,
                    },
                },
                "development_recommendation": None,
                "reason": "one sampling setting can test the instability",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (parent / "decision.json").write_text(
        json.dumps(
            {
                "schema_version": "stage_decision.v1",
                "stage": "a",
                "attempt": 0,
                "decision": "retry",
                    "evidence_sha256": {
                        name: (
                            hashlib.sha256((parent / name).read_bytes()).hexdigest()
                            if (parent / name).is_file() else None
                        )
                        for name in CORE_EVIDENCE_FILES
                    },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    prepare_attempt(output_dir, StageName.A, 1)
    current = output_dir / "attempts" / "a" / "1"
    family = _write_family(current, attempt=1)
    (current / "stage-result.json").write_text(
        json.dumps(
            {
                "stage": "a",
                "attempt": 1,
                "eligible_for_review": True,
                "artifacts": {"model_png": "diagnostics/stage_a_model.png"},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    target = build_review_context(output_dir, StageName.A, 1)

    context = json.loads(target.read_text())
    assert context["stage"] == "a"
    assert context["attempt"] == 1
    assert context["effective_config"] == "attempts/a/1/effective-config.json"
    assert context["settings"]["stage_a_n_live"] == {
        "value": 320,
        "tunable": True,
        "type": "integer",
        "minimum": 1,
        "maximum": 800,
        "repairable_blockers": ["sampling_pathology"],
        "invalidates_from": "a",
        "cross_field_requirements": [
            {
                "operator": "<=",
                "parameter": "stage_a_n_eff",
                "current_value": 800,
            }
        ],
    }
    assert "stage_m3_n_live" not in context["settings"]
    assert context["preceding_retry"]["proposal"]["new_value"] == 320
    assert [entry["attempt"] for entry in context["lineage"]] == [0, 1]
    assert context["visual_prior_provenance"]["reference"] == (
        "attempts/a/0/visual-prior-provenance.json"
    )
    assert context["visual_prior_provenance"]["record"]["eligible"] is True
    assert context["stage_a_predicted_image_family"]["record"] == family
    assert context["stage_a_model_png"] == "attempts/a/1/diagnostics/stage_a_model.png"
    assert target == current / "review-context.json"


def test_stage_b_review_context_binds_the_accepted_family_to_current_audit(
    tmp_path: Path,
) -> None:
    output_dir = tmp_path / "lens-001"
    output_dir.mkdir()
    (output_dir / "run-manifest.json").write_text(
        json.dumps({
            "schema_version": "lens_run_manifest.v1",
            "pipeline_release_id": PIPELINE_RELEASE_ID,
        }) + "\n",
        encoding="utf-8",
    )
    accepted_a = output_dir / "attempts" / "a" / "0"
    family = _write_family(accepted_a)
    (output_dir / "accepted").mkdir()
    (output_dir / "accepted" / "a.json").write_text(
        json.dumps({"stage": "a", "attempt_path": "../attempts/a/0"}) + "\n",
        encoding="utf-8",
    )
    family_path = accepted_a / "artifacts" / "stage_a_predicted_image_family.json"
    current = output_dir / "attempts" / "b" / "0"
    (current / "artifacts").mkdir(parents=True)
    (current / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    audit = {
        "schema_version": "stage_b_morphology_audit.v2",
        "stage_attempt": "attempts/b/0",
        "predicted_image_family": {
            "reference": "attempts/a/0/artifacts/stage_a_predicted_image_family.json",
            "sha256": hashlib.sha256(family_path.read_bytes()).hexdigest(),
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
        "images": [
            {
                "image_id": item["image_id"], "position_arcsec": item["position_arcsec"],
                "nearest_pixel": [10, 10], "nearest_pixel_covered": True,
                "nearest_arc_pixel_distance_arcsec": 0.0, "local_peak_snr": 4.0,
                "local_peak_position_arcsec": item["position_arcsec"],
                "local_above_threshold_pixel_count": 0, "threshold_islands": [],
                "candidate_component_ids": [1], "selected_component_ids": [1],
                "local_selected_arc_pixel_count": 5, "local_valid_pixel_count": 10,
                "local_selected_arc_fraction": 0.5,
            }
            for item in family["images"]
        ],
    }
    audit_path = current / "artifacts" / "stage_b_morphology_audit.json"
    audit_path.write_text(json.dumps(audit) + "\n", encoding="utf-8")
    (current / "stage-result.json").write_text(
        json.dumps({"stage": "b", "attempt": 0, "artifacts": {
            "stage_b_morphology_audit_json": "artifacts/stage_b_morphology_audit.json"
        }}) + "\n",
        encoding="utf-8",
    )

    context = json.loads(build_review_context(output_dir, StageName.B, 0).read_text())

    assert context["stage_a_predicted_image_family"]["record"] == family
    assert context["stage_b_morphology_audit"]["record"] == audit
    assert context["stage_a_model_png"] == "attempts/a/0/diagnostics/stage_a_model.png"


def test_m0_review_context_uses_attempt_specific_grid_diagnostic_paths(
    tmp_path: Path,
) -> None:
    output_dir = tmp_path / "lens-001"
    output_dir.mkdir()
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
    for attempt, level in ((0, 0), (1, 1)):
        root = output_dir / "attempts" / "m0" / str(attempt)
        root.mkdir(parents=True)
        settings = EffectiveConfig().settings.model_copy(
            update={"source_grid_level": level}
        )
        (root / "effective-config.json").write_text(
            json.dumps(
                EffectiveConfig(settings=settings).model_dump(mode="json")
            )
            + "\n",
            encoding="utf-8",
        )
        (root / "stage-result.json").write_text(
            json.dumps(
                {
                    "stage": "m0",
                    "attempt": attempt,
                    "eligible_for_review": True,
                    "artifacts": {
                        "source_grid_png": "diagnostics/stage_m0_source_grid.png"
                    },
                    "metrics": {
                        "source_grid_spec": {"grid_level": level},
                        "source_sign_diagnostics": {},
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
    current = output_dir / "attempts" / "m0" / "1"
    (current / "proposal-validation.json").write_text(
        json.dumps({"kind": "source_grid_enlargement"}) + "\n",
        encoding="utf-8",
    )

    context = json.loads(
        build_review_context(output_dir, StageName.M0, 1).read_text()
    )

    assert [entry["source_grid_diagnostic"] for entry in context["lineage"]] == [
        "attempts/m0/0/diagnostics/stage_m0_source_grid.png",
        "attempts/m0/1/diagnostics/stage_m0_source_grid.png",
    ]


def test_review_context_does_not_reintroduce_a_resolved_upstream_warning(
    tmp_path: Path,
) -> None:
    output_dir = tmp_path / "lens-001"
    output_dir.mkdir()
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
    (output_dir / "accepted").mkdir()
    for stage in (StageName.A, StageName.M1):
        root = output_dir / "attempts" / stage.value / "0"
        root.mkdir(parents=True)
        (output_dir / "accepted" / f"{stage.value}.json").write_text(
            json.dumps(
                {
                    "schema_version": "accepted_stage_head.v1",
                    "stage": stage.value,
                    "accepted_attempt": 0,
                    "attempt_path": f"../attempts/{stage.value}/0",
                    "effective_config": f"../attempts/{stage.value}/0/effective-config.json",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (root / "decision.json").write_text(
            json.dumps({"decision": "accept"}) + "\n", encoding="utf-8"
        )
    (output_dir / "attempts" / "a" / "0" / "review.json").write_text(
        json.dumps(
            {
                "handoff_warnings": [
                    {
                        "kind": "model_limited_residual",
                        "evidence": ["localized residual"],
                        "impact": "monitor downstream",
                        "expected_resolution_stage": "m1",
                    }
                ],
                "upstream_warning_updates": [],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (output_dir / "attempts" / "m1" / "0" / "review.json").write_text(
        json.dumps(
            {
                "handoff_warnings": [],
                "upstream_warning_updates": [
                    {
                        "warning_ref": "a:0:w0",
                        "status": "resolved",
                        "evidence": ["M1 absorbs the localized residual"],
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    current = output_dir / "attempts" / "m2" / "0"
    current.mkdir(parents=True)
    (current / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    (current / "stage-result.json").write_text(
        json.dumps(
            {
                "stage": "m2",
                "attempt": 0,
                "eligible_for_review": True,
                "artifacts": {},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    context = json.loads(build_review_context(output_dir, StageName.M2, 0).read_text())

    assert context["unresolved_upstream_warnings"] == []
