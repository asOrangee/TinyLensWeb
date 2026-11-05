import csv
import hashlib
import json
import sys
from types import SimpleNamespace
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

from lens_agent.cli import main
from lens_agent import cli
from lens_agent.configuration import (
    CONFIG_SCHEMA_VERSION,
    EffectiveConfig,
    PIPELINE_RELEASE_ID,
    PipelineConfig,
)
from lens_agent.models import StageName
from lens_agent.modeling.source_grid import source_grid_spec
from lens_agent.modeling.predicted_image_family import build_predicted_image_family
from tests.helpers import make_lens_dir, model_inspector_decision


def _write_model_inspector(output_dir: Path) -> None:
    preflight = output_dir / "preflight"
    (preflight / "inspector.json").write_text(
        json.dumps(model_inspector_decision(output_dir.name)) + "\n",
        encoding="utf-8",
    )


def test_orchestrated_stage_requires_a_gpu_lease_before_execution(
    monkeypatch,
) -> None:
    called = False

    def fake_run_stage(*_args):
        nonlocal called
        called = True
        return {"status": "success", "stage": "m1", "attempt": 0}

    monkeypatch.setattr(cli, "run_stage", fake_run_stage)
    monkeypatch.setenv("LENS_AGENT_REQUIRE_GPU_LEASE", "1")
    monkeypatch.delenv("LENS_AGENT_GPU_LEASE", raising=False)

    with pytest.raises(RuntimeError, match="GPU Stage Runner"):
        main(
            [
                "stage",
                "--lens-dir",
                "/tmp/lens",
                "--output-dir",
                "/tmp/output",
                "--stage",
                "m1",
                "--attempt",
                "0",
            ]
        )

    assert called is False


def test_orchestrated_gpu_lease_exposes_exactly_one_jax_gpu(monkeypatch) -> None:
    result = {"status": "success", "stage": "m1", "attempt": 0}
    monkeypatch.setattr(cli, "run_stage", lambda *_args, **_kwargs: result)
    monkeypatch.setenv("LENS_AGENT_REQUIRE_GPU_LEASE", "1")
    monkeypatch.setenv("LENS_AGENT_GPU_LEASE", "1")
    monkeypatch.setitem(
        sys.modules,
        "jax",
        SimpleNamespace(devices=lambda: [SimpleNamespace(platform="gpu")]),
    )

    main(
        [
            "stage",
            "--lens-dir",
            "/tmp/lens",
            "--output-dir",
            "/tmp/output",
            "--stage",
            "m1",
            "--attempt",
            "0",
        ]
    )


@pytest.mark.parametrize("gpu_count", [0, 2])
def test_orchestrated_gpu_lease_rejects_a_non_single_jax_view(
    monkeypatch, gpu_count: int
) -> None:
    called = False

    def fake_run_stage(*_args):
        nonlocal called
        called = True
        return {"status": "success", "stage": "m1", "attempt": 0}

    monkeypatch.setattr(cli, "run_stage", fake_run_stage)
    monkeypatch.setenv("LENS_AGENT_REQUIRE_GPU_LEASE", "1")
    monkeypatch.setenv("LENS_AGENT_GPU_LEASE", "1")
    monkeypatch.setitem(
        sys.modules,
        "jax",
        SimpleNamespace(
            devices=lambda: [SimpleNamespace(platform="gpu") for _ in range(gpu_count)]
        ),
    )

    with pytest.raises(RuntimeError, match="exactly one JAX GPU"):
        main(
            [
                "stage",
                "--lens-dir",
                "/tmp/lens",
                "--output-dir",
                "/tmp/output",
                "--stage",
                "m1",
                "--attempt",
                "0",
            ]
        )

    assert called is False


def test_stage_cli_keeps_result_exit_status_when_stdout_disconnects(
    monkeypatch,
) -> None:
    result = {"status": "success", "stage": "a", "attempt": 0}
    monkeypatch.setattr(cli, "run_stage", lambda *_args, **_kwargs: result)

    class DisconnectedStdout:
        def write(self, text: str) -> int:
            return len(text)

        def flush(self) -> None:
            raise BrokenPipeError(32, "Broken pipe")

    disconnected = DisconnectedStdout()
    monkeypatch.setattr(cli.sys, "stdout", disconnected)

    main(
        [
            "stage",
            "--lens-dir",
            "/tmp/lens",
            "--output-dir",
            "/tmp/output",
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )

    assert cli.sys.stdout is not disconnected


def test_stage_cli_prints_the_result_when_stdout_is_available(
    monkeypatch, capsys
) -> None:
    result = {"status": "success", "stage": "a", "attempt": 0}
    monkeypatch.setattr(cli, "run_stage", lambda *_args, **_kwargs: result)

    main(
        [
            "stage",
            "--lens-dir",
            "/tmp/lens",
            "--output-dir",
            "/tmp/output",
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )

    assert json.loads(capsys.readouterr().out) == result


def _write_eligible_result(
    attempt_dir: Path,
    stage: str,
    attempt: int,
    *,
    artifact: str | None = None,
    extra_artifacts: tuple[str, ...] = (),
) -> None:
    artifact = artifact or f"artifacts/stage_{stage}.pkl"
    artifact_path = attempt_dir / artifact
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    if not artifact_path.exists():
        artifact_path.write_bytes(b"test artifact")
    (attempt_dir / "stage-execution.json").write_text(
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
    all_artifacts = (artifact, *extra_artifacts)
    (attempt_dir / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": "attempt_artifact_manifest.v1",
                "artifacts": [
                    {
                        "path": item,
                        "role": "test_artifact",
                        "media_type": "application/json" if item.endswith(".json") else "application/octet-stream",
                    }
                    for item in all_artifacts
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (attempt_dir / "stage-result.json").write_text(
        json.dumps(
            {
                "stage": stage,
                "attempt": attempt,
                "status": "success",
                "eligible_for_review": True,
                "gate_failures": [],
                "artifacts": {
                    "test_artifact": artifact,
                    **{
                        "stage_b_morphology_audit_json": item
                        for item in extra_artifacts
                        if item.endswith("stage_b_morphology_audit.json")
                    },
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_removed_stage_l_is_not_publicly_selectable(tmp_path: Path) -> None:
    assert tuple(stage.value for stage in StageName) == (
        "a",
        "b",
        "m0",
        "m1",
        "m2",
        "m3",
        "subhalo",
    )

    with pytest.raises(SystemExit) as error:
        main(
            [
                "stage",
                "--lens-dir",
                str(tmp_path / "lens"),
                "--output-dir",
                str(tmp_path / "output"),
                "--stage",
                "l",
            ]
        )

    assert error.value.code == 2


def test_stage_cli_requires_attempt_and_rejects_pipeline_override(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as missing_attempt:
        main(
            [
                "stage",
                "--lens-dir",
                str(tmp_path / "lens"),
                "--output-dir",
                str(tmp_path / "output"),
                "--stage",
                "a",
            ]
        )
    assert missing_attempt.value.code == 2

    with pytest.raises(SystemExit) as pipeline_override:
        main(
            [
                "stage",
                "--lens-dir",
                str(tmp_path / "lens"),
                "--output-dir",
                str(tmp_path / "output"),
                "--stage",
                "a",
                "--attempt",
                "0",
                "--pipeline",
                str(tmp_path / "pipeline.py"),
            ]
        )
    assert pipeline_override.value.code == 2


def test_retry_preparation_has_no_external_review_response_option(
    tmp_path: Path,
) -> None:
    with pytest.raises(SystemExit) as error:
        main(
            [
                "attempt",
                "prepare",
                "--output-dir",
                str(tmp_path / "output" / "lens-001"),
                "--stage",
                "m1",
                "--attempt",
                "1",
                "--response",
                str(tmp_path / "unregistered-review.json"),
            ]
        )

    assert error.value.code == 2


def test_preflight_pins_pipeline_release_without_copying_pipeline(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name

    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])

    assert not (output_dir / "pipeline.py").exists()
    assert json.loads((output_dir / "run-manifest.json").read_text(encoding="utf-8")) == {
        "schema_version": "lens_run_manifest.v1",
        "pipeline_release_id": PIPELINE_RELEASE_ID,
        "lens_dir": str(lens_dir.resolve()),
        "input_geometry": {
            "pixel_scale_arcsec": 0.1,
            "input_x_direction": "increasing",
            "input_y_direction": "increasing",
        },
        "geometry_evidence": None,
    }
    assert (output_dir / "preflight" / "inspection.json").is_file()
    assert (output_dir / "preflight" / "preflight_2panel.png").is_file()
    assert (output_dir / "preflight" / "preflight_6panel.png").is_file()
    decision = tmp_path / "inspector.json"
    decision.write_text(
        json.dumps(model_inspector_decision(lens_dir.name)),
        encoding="utf-8",
    )

    main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    mask = np.asarray(fits.getdata(output_dir / "preflight" / "modeling_mask.fits"), dtype=bool)
    assert not mask[mask.shape[0] // 2, mask.shape[1] // 2]


def test_mask_writes_human_readable_unicode_to_canonical_inspector(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    raw = model_inspector_decision(lens_dir.name)
    raw["reason"] = "segment crosses the 4″ modeling boundary"
    decision = tmp_path / "inspector-response.json"
    decision.write_text(json.dumps(raw), encoding="utf-8")

    main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    canonical = (output_dir / "preflight" / "inspector.json").read_text(encoding="utf-8")
    assert "4″" in canonical
    assert "\\u2033" not in canonical


def test_human_review_removes_an_existing_modeling_mask(tmp_path: Path) -> None:
    output_dir = tmp_path / "output" / "lens-a"
    preflight_dir = output_dir / "preflight"
    preflight_dir.mkdir(parents=True)
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
    previous_mask = preflight_dir / "modeling_mask.fits"
    fits.writeto(previous_mask, np.zeros((2, 2), dtype=np.uint8))
    decision = tmp_path / "inspector.json"
    decision.write_text(
        json.dumps(
            {
                "lens_id": "lens-a",
                "disposition": "human_review",
                "contaminant_ids": [],
                "reason": "multiple deflectors",
                "theta_E_hint": None,
            }
        ),
        encoding="utf-8",
    )

    main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    assert not previous_mask.exists()


def test_mask_rejects_model_decision_without_theta_e_hint(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    decision = tmp_path / "inspector.json"
    decision.write_text(
        json.dumps(
            {
                "lens_id": lens_dir.name,
                "disposition": "model",
                "contaminant_ids": [],
                "reason": "one coherent simple lens",
                "theta_E_hint": None,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="requires theta_E_hint"):
        main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    assert not (output_dir / "preflight" / "inspector.json").exists()


def test_mask_removes_an_invalid_decision_written_to_the_authoritative_path(
    tmp_path: Path,
) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    decision = output_dir / "preflight" / "inspector.json"
    decision.write_text(
        json.dumps(
            {
                "lens_id": lens_dir.name,
                "disposition": "model",
                "contaminant_ids": [],
                "reason": "one coherent simple lens",
                "theta_E_hint": None,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="requires theta_E_hint"):
        main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    assert not decision.exists()


def test_mask_refuses_to_mutate_a_historical_output_root(tmp_path: Path) -> None:
    output_dir = tmp_path / "output" / "lens-a"
    preflight_dir = output_dir / "preflight"
    preflight_dir.mkdir(parents=True)
    previous_mask = preflight_dir / "modeling_mask.fits"
    fits.writeto(previous_mask, np.zeros((2, 2), dtype=np.uint8))
    decision = tmp_path / "inspector.json"
    decision.write_text(
        json.dumps(
            {
                "lens_id": "lens-a",
                "disposition": "human_review",
                "contaminant_ids": [],
                "reason": "multiple deflectors",
                "theta_E_hint": None,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="no current Lens Run Manifest"):
        main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    assert previous_mask.is_file()


def test_mask_rejects_a_preflight_symlink_into_an_archive(tmp_path: Path) -> None:
    output_dir = tmp_path / "output" / "lens-a"
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
    archive_preflight = tmp_path / "output" / "_archive" / "lens-a_old_0" / "preflight"
    archive_preflight.mkdir(parents=True)
    (output_dir / "preflight").symlink_to(archive_preflight, target_is_directory=True)
    decision = tmp_path / "inspector.json"
    decision.write_text(
        json.dumps(
            {
                "lens_id": "lens-a",
                "disposition": "human_review",
                "contaminant_ids": [],
                "reason": "multiple deflectors",
                "theta_E_hint": None,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="must not contain symbolic links"):
        main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    assert not (archive_preflight / "inspector.json").exists()


def test_attempt_prepare_materializes_complete_initial_configuration(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    decision = tmp_path / "inspector.json"
    decision.write_text(
        json.dumps(model_inspector_decision(lens_dir.name)), encoding="utf-8"
    )
    main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    main(
        [
            "attempt",
            "prepare",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )

    config = json.loads(
        (output_dir / "attempts" / "a" / "0" / "effective-config.json").read_text(
            encoding="utf-8"
        )
    )
    assert config["schema_version"] == CONFIG_SCHEMA_VERSION
    assert config["pipeline_release_id"] == PIPELINE_RELEASE_ID
    assert config["parent_config"] is None
    assert config["settings"]["stage_a_n_live"] == 200
    assert config["settings"]["stage_m3_n_eff"] == 600
    assert "arc_drop_component_ids" not in config["settings"]


def test_stage_a_attempt_derives_and_records_visual_prior(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    decision = tmp_path / "inspector.json"
    decision.write_text(
        json.dumps(model_inspector_decision(lens_dir.name)), encoding="utf-8"
    )
    main(["mask", "--output-dir", str(output_dir), "--inspection", str(decision)])

    main(
        [
            "attempt", "prepare", "--output-dir", str(output_dir),
            "--stage", "a", "--attempt", "0",
        ]
    )

    root = output_dir / "attempts" / "a" / "0"
    config = json.loads((root / "effective-config.json").read_text(encoding="utf-8"))
    provenance = json.loads(
        (root / "visual-prior-provenance.json").read_text(encoding="utf-8")
    )
    assert config["settings"]["stage_a_theta_E_prior"] == {
        "prior_type": "truncated_gaussian_uniform_mixture",
        "prior_settings": [1.35, 0.2, 0.8],
        "limits": [0.5, 3.0],
    }
    assert config["settings"]["stage_a_theta_E_initial"] == 1.35
    assert provenance["source_inspector"] == "preflight/inspector.json"
    assert provenance["eligible"] is True


def test_attempt_prepare_applies_one_typed_reviewer_proposal(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    parent_dir = output_dir / "attempts" / "m1" / "0"
    parent_dir.mkdir(parents=True)
    (parent_dir / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    _write_eligible_result(parent_dir, "m1", 0)
    review = tmp_path / "review.json"
    review.write_text(
        json.dumps(
            {
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
                        "base_config": "attempts/m1/0/effective-config.json",
                        "parameter": "stage_m1_n_eff",
                        "old_value": 600,
                        "new_value": 1000,
                    },
                },
                "development_recommendation": None,
                "scientific_uncertainty": None,
                "reason": "one sampling parameter can test the blocker",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review", "adjudicate", "--output-dir", str(output_dir),
            "--stage", "m1", "--attempt", "0", "--response", str(review),
        ]
    )
    canonical_review = parent_dir / "review.json"
    original_review = canonical_review.read_text(encoding="utf-8")
    canonical_review.write_text(original_review + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="review no longer matches"):
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
    assert not (output_dir / "attempts" / "m1" / "1").exists()
    canonical_review.write_text(original_review, encoding="utf-8")
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

    parent = json.loads(
        (output_dir / "attempts" / "m1" / "0" / "effective-config.json").read_text()
    )
    candidate_dir = output_dir / "attempts" / "m1" / "1"
    candidate = json.loads((candidate_dir / "effective-config.json").read_text())
    assert candidate["parent_config"] == "attempts/m1/0/effective-config.json"
    assert candidate["settings"]["stage_m1_n_eff"] == 1000
    assert {
        key: value
        for key, value in candidate["settings"].items()
        if key != "stage_m1_n_eff"
    } == {
        key: value
        for key, value in parent["settings"].items()
        if key != "stage_m1_n_eff"
    }
    validation = json.loads((candidate_dir / "proposal-validation.json").read_text())
    assert validation == {
        "status": "valid",
        "stage": "m1",
        "parameter": "stage_m1_n_eff",
        "old_value": 600,
        "new_value": 1000,
    }


def test_m0_retry_prepare_advances_only_the_fixed_source_grid_level(
    tmp_path: Path,
) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    parent = output_dir / "attempts" / "m0" / "0"
    parent.mkdir(parents=True)
    (parent / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n", encoding="utf-8"
    )
    _write_eligible_result(parent, "m0", 0)
    initial_grid = source_grid_spec(center_x=0.1, center_y=-0.2, level=0)
    (parent / "artifacts" / "source_grid_spec.json").write_text(
        json.dumps(initial_grid) + "\n", encoding="utf-8"
    )
    response = tmp_path / "m0-review.json"
    response.write_text(
        json.dumps(
            {
                "stage": "m0",
                "grid_judgment": "source_bbox_truncation",
                "visual_findings": ["coherent emission visibly clips the right edge"],
                "numerical_findings": ["right-edge flux supports the continuation"],
                "reason": "the current source footprint is insufficient",
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
    main(
        [
            "attempt", "prepare", "--output-dir", str(output_dir),
            "--stage", "m0", "--attempt", "1",
        ]
    )

    candidate = output_dir / "attempts" / "m0" / "1"
    config = json.loads((candidate / "effective-config.json").read_text())
    assert config["settings"]["source_grid_level"] == 1
    assert config["parent_config"] == "attempts/m0/0/effective-config.json"
    assert json.loads((candidate / "proposal-validation.json").read_text()) == {
        "status": "valid",
        "stage": "m0",
        "kind": "source_grid_enlargement",
        "old_grid_level": 0,
        "new_grid_level": 1,
        "old_source_grid_spec": initial_grid,
        "new_source_grid_spec": source_grid_spec(center_x=0.1, center_y=-0.2, level=1),
    }


def test_adjudication_rejects_an_incomplete_expert_response(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    parent = output_dir / "attempts" / "a" / "0"
    parent.mkdir(parents=True)
    (parent / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n", encoding="utf-8"
    )
    _write_eligible_result(parent, "a", 0)
    response = tmp_path / "incomplete-review.json"
    response.write_text(
        json.dumps(
            {
                "stage": "a",
                "progression_blockers": [],
                "retry_repair": None,
                "reason": "required evidence fields were accidentally omitted",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="visual_findings"):
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

    assert not (output_dir / "attempts" / "a" / "1").exists()


def test_adjudication_rejects_a_cross_field_sampling_violation(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    parent = output_dir / "attempts" / "a" / "0"
    parent.mkdir(parents=True)
    (parent / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n", encoding="utf-8"
    )
    _write_eligible_result(parent, "a", 0)
    review = tmp_path / "review.json"
    review.write_text(
        json.dumps(
            {
                "stage": "a",
                "visual_findings": ["the image family is captured"],
                "numerical_findings": ["sampling remains unstable"],
                "progression_blockers": [
                    {
                        "kind": "sampling_pathology",
                        "evidence": ["effective sample support is unstable"],
                        "impact": "downstream initialization would be unreliable",
                    }
                ],
                "handoff_warnings": [],
                "upstream_warning_updates": [],
                    "retry_repair": {
                    "hypothesis": {
                        "blocker_kind": "sampling_pathology",
                        "expected_improvement": "sampling stabilizes",
                    },
                    "proposal": {
                        "base_config": "attempts/a/0/effective-config.json",
                        "parameter": "stage_a_n_live",
                        "old_value": 200,
                        "new_value": 900,
                        },
                    },
                    "development_recommendation": None,
                    "reason": "one sampling parameter can test the blocker",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="n_live <= n_eff"):
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
                str(review),
            ]
        )

    assert not (output_dir / "attempts" / "a" / "1").exists()


def test_initial_stage_attempt_copies_previous_accepted_configuration(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    accepted_attempt = output_dir / "attempts" / "m0" / "2"
    accepted_attempt.mkdir(parents=True)
    settings = PipelineConfig().model_copy(update={"stage_a_n_live": 311})
    (accepted_attempt / "effective-config.json").write_text(
        json.dumps(EffectiveConfig(settings=settings).model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    (output_dir / "accepted").mkdir()
    (output_dir / "accepted" / "m0.json").write_text(
        json.dumps(
            {
                "schema_version": "accepted_stage_head.v1",
                "stage": "m0",
                "accepted_attempt": 2,
                "attempt_path": "../attempts/m0/2",
                "effective_config": "../attempts/m0/2/effective-config.json",
            }
        )
        + "\n",
        encoding="utf-8",
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
            "0",
        ]
    )

    candidate = json.loads(
        (output_dir / "attempts" / "m1" / "0" / "effective-config.json").read_text()
    )
    assert candidate["settings"]["stage_a_n_live"] == 311
    assert candidate["parent_config"] == "attempts/m0/2/effective-config.json"


def test_attempt_promote_checks_result_decision_manifest_and_chain_end(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    _write_model_inspector(output_dir)
    main(
        [
            "attempt",
            "prepare",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )
    attempt_dir = output_dir / "attempts" / "a" / "0"
    (attempt_dir / "artifacts").mkdir()
    (attempt_dir / "artifacts" / "stage_a.pkl").write_bytes(b"pickle")
    (attempt_dir / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": "attempt_artifact_manifest.v1",
                "artifacts": [
                    {
                        "path": "artifacts/stage_a.pkl",
                        "role": "stage_pickle",
                        "media_type": "application/octet-stream",
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (attempt_dir / "stage-execution.json").write_text(
        json.dumps(
            {
                "schema_version": "stage_execution.v1",
                "stage": "a",
                "attempt": 0,
                "pipeline_release_id": PIPELINE_RELEASE_ID,
                "status": "started",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (attempt_dir / "stage-result.json").write_text(
        json.dumps(
            {
                "stage": "a",
                "attempt": 0,
                "status": "success",
                "eligible_for_review": True,
                "gate_failures": [],
                "artifacts": {"stage_pickle": "artifacts/stage_a.pkl"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    review_text = json.dumps(
        {
            "stage": "a",
            "visual_findings": ["the result is scientifically sound"],
            "reason": "scientifically sound",
        },
        indent=2,
    ) + "\n"
    review_path = attempt_dir / "review.json"
    review_path.write_text(review_text, encoding="utf-8")
    evidence = {}
    for name in (
        "effective-config.json", "stage-execution.json", "stage-result.json",
        "manifest.json", "arc-component-selection.json", "review.json",
        "stage.log", "traceback.log",
    ):
        path = attempt_dir / name
        evidence[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    evidence["artifact:artifacts/stage_a.pkl"] = hashlib.sha256(
        (attempt_dir / "artifacts" / "stage_a.pkl").read_bytes()
    ).hexdigest()
    (attempt_dir / "decision.json").write_text(
        json.dumps(
            {
                "schema_version": "stage_decision.v1",
                "stage": "a",
                "attempt": 0,
                "decision": "accept",
                "reason": "scientifically sound",
                "evidence_sha256": evidence,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    review_path.write_text(review_text + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="review no longer matches"):
        main(
            [
                "attempt",
                "promote",
                "--output-dir",
                str(output_dir),
                "--stage",
                "a",
                "--attempt",
                "0",
            ]
        )
    assert not (output_dir / "accepted" / "a.json").exists()
    review_path.write_text(review_text, encoding="utf-8")

    main(
        [
            "attempt",
            "promote",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )

    assert json.loads((output_dir / "accepted" / "a.json").read_text()) == {
        "schema_version": "accepted_stage_head.v1",
        "stage": "a",
        "accepted_attempt": 0,
        "attempt_path": "../attempts/a/0",
        "effective_config": "../attempts/a/0/effective-config.json",
    }
    later = output_dir / "attempts" / "a" / "1"
    later.mkdir()
    (later / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="current chain end"):
        main(
            [
                "attempt",
                "promote",
                "--output-dir",
                str(output_dir),
                "--stage",
                "a",
                "--attempt",
                "0",
            ]
        )


def test_preflight_rejects_historical_shared_cache_root(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    output_dir.mkdir(parents=True)
    (output_dir / "pipeline.py").write_text("# historical\n", encoding="utf-8")

    with pytest.raises(ValueError, match="historical output root"):
        main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])

    assert not (output_dir / "run-manifest.json").exists()


def test_preflight_rejects_a_root_pinned_to_another_release(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    output_dir.mkdir(parents=True)
    (output_dir / "run-manifest.json").write_text(
        json.dumps(
            {
                "schema_version": "lens_run_manifest.v1",
                "pipeline_release_id": "historical.v0",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="different Pipeline Release"):
        main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])


def test_preflight_accepts_a_current_lens_id_with_an_archive_suffix(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / f"{lens_dir.name}_old_0"

    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])

    assert (output_dir / "run-manifest.json").is_file()


def test_preflight_rejects_a_result_nested_inside_an_archive(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    archive_dir = tmp_path / "output" / "_archive"
    archive_dir.mkdir(parents=True)
    output_dir = archive_dir / "nested-run"

    with pytest.raises(ValueError, match="Archive Directory is read-only"):
        main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])

    assert not output_dir.exists()


def test_rerun_prepare_archives_current_lens_run_with_next_monotonic_number(
    tmp_path: Path,
) -> None:
    lens_dir = make_lens_dir(tmp_path)
    batch_dir = tmp_path / "output"
    output_dir = batch_dir / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    (output_dir / "current-run-marker.txt").write_text("current\n", encoding="utf-8")
    archive_root = batch_dir / "_archive"
    (archive_root / f"{lens_dir.name}_old_0").mkdir(parents=True)
    (archive_root / f"{lens_dir.name}_old_2").mkdir()
    (archive_root / "notes.txt").write_text("manual note\n", encoding="utf-8")
    (archive_root / f"{lens_dir.name}_old_incomplete").mkdir()
    (archive_root / "another-lens_old_99").mkdir()

    main(["rerun", "prepare", "--output-dir", str(output_dir)])

    archive_dir = archive_root / f"{lens_dir.name}_old_3"
    assert not output_dir.exists()
    assert (archive_dir / "current-run-marker.txt").read_text(encoding="utf-8") == "current\n"
    assert (archive_dir / "run-manifest.json").is_file()
    assert (archive_root / f"{lens_dir.name}_old_0").is_dir()
    assert (archive_root / f"{lens_dir.name}_old_2").is_dir()
    assert (archive_root / "notes.txt").read_text(encoding="utf-8") == "manual note\n"


def test_rerun_prepare_rejects_a_missing_current_lens_run(tmp_path: Path) -> None:
    output_dir = tmp_path / "output" / "lens-001"

    with pytest.raises(ValueError, match="does not exist"):
        main(["rerun", "prepare", "--output-dir", str(output_dir)])

    assert not output_dir.exists()
    assert not (output_dir.parent / "_archive" / "lens-001_old_0").exists()


def test_rerun_prepare_archives_a_different_pipeline_release(tmp_path: Path) -> None:
    output_dir = tmp_path / "output" / "lens-001"
    output_dir.mkdir(parents=True)
    manifest = output_dir / "run-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "lens_run_manifest.v1",
                "pipeline_release_id": "historical.v0",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(["rerun", "prepare", "--output-dir", str(output_dir)])

    archive = output_dir.parent / "_archive" / "lens-001_old_0"
    assert not output_dir.exists()
    assert (archive / manifest.name).is_file()


def test_rerun_prepare_rejects_a_manifest_without_a_pipeline_release(tmp_path: Path) -> None:
    output_dir = tmp_path / "output" / "lens-001"
    output_dir.mkdir(parents=True)
    manifest = output_dir / "run-manifest.json"
    manifest.write_text(
        json.dumps({"schema_version": "lens_run_manifest.v1", "pipeline_release_id": ""})
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="Lens Run Manifest has no Pipeline Release"):
        main(["rerun", "prepare", "--output-dir", str(output_dir)])

    assert output_dir.is_dir()
    assert not (output_dir.parent / "_archive").exists()


def test_rerun_prepare_rejects_an_archived_lens_run(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    main(["rerun", "prepare", "--output-dir", str(output_dir)])
    archive_dir = output_dir.parent / "_archive" / f"{lens_dir.name}_old_0"

    with pytest.raises(ValueError, match="Archive Directory is read-only"):
        main(["rerun", "prepare", "--output-dir", str(archive_dir)])

    assert archive_dir.is_dir()
    assert not (archive_dir.parent / f"{lens_dir.name}_old_0_old_0").exists()


def test_rerun_prepare_rejects_current_manifest_with_historical_layout(
    tmp_path: Path,
) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    historical_marker = output_dir / "pipeline.py"
    historical_marker.write_text("# historical layout\n", encoding="utf-8")

    with pytest.raises(ValueError, match="historical output root"):
        main(["rerun", "prepare", "--output-dir", str(output_dir)])

    assert output_dir.is_dir()
    assert historical_marker.is_file()
    assert not (output_dir.parent / "_archive" / f"{lens_dir.name}_old_0").exists()


def test_rerun_prepare_rejects_internal_symbolic_links(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    source = output_dir / "source.txt"
    source.write_text("current run\n", encoding="utf-8")
    (output_dir / "source-link.txt").symlink_to(source)

    with pytest.raises(ValueError, match="must not contain symbolic links"):
        main(["rerun", "prepare", "--output-dir", str(output_dir)])

    assert output_dir.is_dir()
    assert not (output_dir.parent / "_archive" / f"{lens_dir.name}_old_0").exists()


def test_rerun_prepare_rejects_a_symbolic_link_archive_directory(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    archive_target = tmp_path / "other-output"
    archive_target.mkdir()
    (output_dir.parent / "_archive").symlink_to(archive_target, target_is_directory=True)

    with pytest.raises(ValueError, match="Archive Directory must not be a symbolic link"):
        main(["rerun", "prepare", "--output-dir", str(output_dir)])

    assert output_dir.is_dir()
    assert not (archive_target / f"{lens_dir.name}_old_0").exists()


def test_rerun_prepare_rejects_a_non_directory_archive_path(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    archive_root = output_dir.parent / "_archive"
    archive_root.write_text("not a directory\n", encoding="utf-8")

    with pytest.raises(ValueError, match="Archive Directory must be a directory"):
        main(["rerun", "prepare", "--output-dir", str(output_dir)])

    assert output_dir.is_dir()
    assert archive_root.read_text(encoding="utf-8") == "not a directory\n"


def test_stage_rejects_an_archived_lens_run_without_writing_a_result(
    tmp_path: Path, capsys,
) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    _write_model_inspector(output_dir)
    main(
        [
            "attempt",
            "prepare",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )
    main(["rerun", "prepare", "--output-dir", str(output_dir)])
    archive_dir = output_dir.parent / "_archive" / f"{lens_dir.name}_old_0"
    stage_result = archive_dir / "attempts" / "a" / "0" / "stage-result.json"

    with pytest.raises(SystemExit) as error:
        main(
            [
                "stage",
                "--lens-dir",
                str(lens_dir),
                "--output-dir",
                str(archive_dir),
                "--stage",
                "a",
                "--attempt",
                "0",
            ]
        )

    assert error.value.code == 2
    assert "Archive Directory is read-only" in capsys.readouterr().err
    assert not stage_result.exists()


def test_stage_rejects_a_path_below_an_archive_symbolic_link_without_writing_a_result(
    tmp_path: Path, capsys,
) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    _write_model_inspector(output_dir)
    main(
        [
            "attempt",
            "prepare",
            "--output-dir",
            str(output_dir),
            "--stage",
            "a",
            "--attempt",
            "0",
        ]
    )
    archive_root = output_dir.parent / "_archive"
    archive_root.mkdir()
    archive_link = archive_root / f"{lens_dir.name}_old_0"
    archive_link.symlink_to(output_dir, target_is_directory=True)
    stage_result = output_dir / "attempts" / "a" / "0" / "stage-result.json"

    with pytest.raises(SystemExit) as error:
        main(
            [
                "stage",
                "--lens-dir",
                str(lens_dir),
                "--output-dir",
                str(archive_link),
                "--stage",
                "a",
                "--attempt",
                "0",
            ]
        )

    assert error.value.code == 2
    assert "Archive Directory is read-only" in capsys.readouterr().err
    assert not stage_result.exists()


def test_stage_b_selection_retry_binds_parent_component_catalog(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    main(["preflight", "--lens-dir", str(lens_dir), "--output-dir", str(output_dir)])
    parent = output_dir / "attempts" / "b" / "0"
    parent.mkdir(parents=True)
    (parent / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n", encoding="utf-8"
    )
    (parent / "artifacts").mkdir()
    catalog_ref = "attempts/b/0/artifacts/stage_b_components.json"
    component_labels = np.zeros((64, 64), dtype=np.int32)
    component_labels[10, 10] = 1
    component_labels[20, 20] = 2
    component_labels[30, 30] = 3
    labels_ref = "artifacts/stage_b_component_labels.fits"
    fits.writeto(parent / labels_ref, component_labels)
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
            "initial_range": 4.0, "n_x": 400, "n_y": 400, "k_keep": 30,
            "num_iters": 20, "tolerance": 5.0e-4, "cluster_tol": 0.08,
        },
        threshold_arcsec=0.1, min_log_like=-1.0e10,
    )
    family_path = output_dir / "attempts/a/0/artifacts/stage_a_predicted_image_family.json"
    family_path.parent.mkdir(parents=True)
    family_path.write_text(json.dumps(family) + "\n", encoding="utf-8")
    (output_dir / "accepted").mkdir(exist_ok=True)
    (output_dir / "accepted" / "a.json").write_text(
        json.dumps({
            "stage": "a", "accepted_attempt": 0,
            "attempt_path": "../attempts/a/0",
        }) + "\n",
        encoding="utf-8",
    )
    audit_ref = "artifacts/stage_b_morphology_audit.json"
    audit_images = []
    for image_id, position, component_id, pixel in (
        ("image_1", [1.0, 0.0], 3, 30), ("image_2", [2.0, 0.0], 1, 10)
    ):
        audit_images.append(
            {
                "image_id": image_id, "position_arcsec": position,
                "nearest_pixel": [pixel, pixel],
                "nearest_pixel_covered": True,
                "nearest_arc_pixel_distance_arcsec": 0.0,
                "local_peak_snr": 4.0, "local_peak_position_arcsec": position,
                "local_above_threshold_pixel_count": 0, "threshold_islands": [],
                "candidate_component_ids": [component_id],
                "selected_component_ids": [component_id],
                "local_selected_arc_pixel_count": 1,
                "local_valid_pixel_count": 10,
                "local_selected_arc_fraction": 0.1,
            }
        )
    (parent / audit_ref).write_text(
        json.dumps(
            {
                "schema_version": "stage_b_morphology_audit.v2",
                "stage_attempt": "attempts/b/0",
                "predicted_image_family": {
                    "reference": "attempts/a/0/artifacts/stage_a_predicted_image_family.json",
                    "sha256": hashlib.sha256(family_path.read_bytes()).hexdigest(),
                },
                "parameters": {"threshold": 2.0, "ignor_size": 5, "ext_size": 5, "close_size": 3},
                "pixel_scale_arcsec": 0.1, "local_radius_arcsec": 0.3,
                "mask_convention": "selected_arc_region True includes pixels",
                "valid_modeling_domain": {
                    "mask_convention": "modeling_mask True excludes pixels",
                    "valid_pixel_count": 4096,
                    "excluded_pixel_count": 0,
                    "excluded_above_threshold_pixel_count": 0,
                },
                "images": audit_images,
            }
        ) + "\n",
        encoding="utf-8",
    )
    components = []
    for component_id, pixel in enumerate((10, 20, 30), start=1):
        components.append(
            {
                "id": component_id, "status": "kept", "pixel_count": 1,
                "bbox_rows": [pixel, pixel], "bbox_cols": [pixel, pixel],
                "centroid_pixel": [float(pixel), float(pixel)],
                "centroid_arcsec": [0.0, 0.0], "peak_snr": 4.0,
                "mean_snr": 4.0, "arc_seed_ids": [component_id],
                "arc_seed_pixel_count": 1, "has_arc_seed": True,
            }
        )
    (parent / "artifacts" / "stage_b_components.json").write_text(
        json.dumps(
            {
                "schema_version": "stage_b_arc_components.v2",
                "stage_attempt": "attempts/b/0",
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
                        (parent / labels_ref).read_bytes()
                    ).hexdigest(),
                },
                "morphology_audit": {
                    "reference": "stage_b_morphology_audit.json",
                    "sha256": hashlib.sha256(
                        (parent / audit_ref).read_bytes()
                    ).hexdigest(),
                },
                "candidate_component_count": 3,
                "all_components_have_arc_seed": True,
                "excluded_above_threshold_pixel_count": 0,
                "components": components,
            }
        ) + "\n",
        encoding="utf-8",
    )
    _write_eligible_result(
        parent, "b", 0, artifact="artifacts/stage_b_components.json",
        extra_artifacts=(audit_ref, labels_ref),
    )
    review = tmp_path / "review.json"
    review.write_text(
        json.dumps(
            {
                "stage": "b",
                "refinement_kind": "selection",
                "predicted_image_dispositions": [
                    {
                        "image_id": "image_1",
                        "disposition": "covered_consistent",
                        "evidence": ["the predicted position and credible extended support are selected"],
                    },
                    {
                        "image_id": "image_2",
                        "disposition": "covered_consistent",
                        "evidence": ["nearest pixel is selected"],
                    },
                ],
                "upstream_warning_updates": [],
                "retry_repair": None,
                    "component_selection": {
                        "component_catalog": catalog_ref,
                        "drop_component_ids": [2],
                    },
                    "development_recommendation": None,
                    "reason": "component 2 is an unrelated island",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(
        [
            "review", "adjudicate", "--output-dir", str(output_dir),
            "--stage", "b", "--attempt", "0", "--response", str(review),
        ]
    )
    main(
        [
            "attempt",
            "prepare",
            "--output-dir",
            str(output_dir),
            "--stage",
            "b",
            "--attempt",
            "1",
        ]
    )

    candidate = output_dir / "attempts" / "b" / "1"
    assert json.loads((candidate / "arc-component-selection.json").read_text()) == {
        "schema_version": "arc_component_selection.v1",
        "component_catalog": catalog_ref,
        "drop_component_ids": [2],
    }
    assert json.loads((candidate / "proposal-validation.json").read_text()) == {
        "status": "valid",
        "stage": "b",
        "kind": "component_selection",
        "component_catalog": catalog_ref,
        "drop_component_ids": [2],
    }


def test_summary_contains_success_and_human_review_rows(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    success = output_dir / "lens-a"
    human = output_dir / "lens-b"
    for lens_dir in (success, human):
        (lens_dir / "preflight").mkdir(parents=True)
        (lens_dir / "preflight" / "inspection.json").write_text("{}\n", encoding="utf-8")
    (success / "preflight" / "inspector.json").write_text(
        json.dumps({"disposition": "model", "reason": "simple"}) + "\n", encoding="utf-8"
    )
    success_attempt = success / "attempts" / "m3" / "1"
    success_attempt.mkdir(parents=True)
    (success_attempt / "decision.json").write_text(
        json.dumps({"decision": "accept", "reason": "fit accepted"}) + "\n", encoding="utf-8"
    )
    (success_attempt / "stage-result.json").write_text(
        json.dumps(
            {
                "status": "success",
                "eligible_for_review": True,
                "gate_failures": [],
                "metrics": {
                    "posterior_quantiles": {
                        "theta_E": {"q16": 1.1, "q50": 1.2, "q84": 1.3},
                        "gamma": {"q16": 1.9, "q50": 2.0, "q84": 2.1},
                    }
                }
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (success / "accepted").mkdir()
    (success / "accepted" / "m3.json").write_text(
        json.dumps(
            {
                "schema_version": "accepted_stage_head.v1",
                "stage": "m3",
                "accepted_attempt": 1,
                "attempt_path": "../attempts/m3/1",
                "effective_config": "../attempts/m3/1/effective-config.json",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (human / "preflight" / "inspector.json").write_text(
        json.dumps({"disposition": "human_review", "reason": "multiple deflectors"}) + "\n",
        encoding="utf-8",
    )

    main(["summary", "--output-dir", str(output_dir)])

    with (output_dir / "summary.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert [(row["lens_id"], row["status"]) for row in rows] == [
        ("lens-a", "success"),
        ("lens-b", "human_review"),
    ]
    assert rows[0]["theta_E"] == "1.2 [1.1, 1.3]"
    assert rows[1]["diagnosis"] == "multiple deflectors"


def test_summary_ignores_archived_lens_runs(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    current = output_dir / "lens-a"
    archive = output_dir / "_archive" / "lens-a_old_0"
    for lens_dir in (current, archive):
        (lens_dir / "preflight").mkdir(parents=True)
        (lens_dir / "preflight" / "inspection.json").write_text("{}\n", encoding="utf-8")
        (lens_dir / "preflight" / "inspector.json").write_text(
            json.dumps(
                {
                    "disposition": "human_review",
                    "reason": "multiple deflectors",
                    "theta_E_hint": None,
                }
            )
            + "\n",
            encoding="utf-8",
        )
    (output_dir / "archive-alias").symlink_to(archive, target_is_directory=True)

    main(["summary", "--output-dir", str(output_dir)])

    with (output_dir / "summary.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert [row["lens_id"] for row in rows] == ["lens-a"]


def test_summary_rejects_an_archive_as_its_output_directory(tmp_path: Path) -> None:
    archive_dir = tmp_path / "output" / "_archive"
    archive_dir.mkdir(parents=True)
    existing_summary = archive_dir / "summary.csv"
    existing_summary.write_text("archived evidence\n", encoding="utf-8")

    with pytest.raises(ValueError, match="Archive Directory is read-only"):
        main(["summary", "--output-dir", str(archive_dir)])

    assert existing_summary.read_text(encoding="utf-8") == "archived evidence\n"


def test_summary_rejects_a_summary_symlink_into_an_archive(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    archived_summary = output_dir / "_archive" / "lens-a_old_0" / "summary.csv"
    archived_summary.parent.mkdir(parents=True)
    archived_summary.write_text("archived evidence\n", encoding="utf-8")
    (output_dir / "summary.csv").symlink_to(archived_summary)

    with pytest.raises(ValueError, match="summary.csv must not be a symbolic link"):
        main(["summary", "--output-dir", str(output_dir)])

    assert archived_summary.read_text(encoding="utf-8") == "archived evidence\n"


def test_summary_rejects_an_accepted_but_ineligible_m3_result(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    lens_dir = output_dir / "lens-a"
    (lens_dir / "preflight").mkdir(parents=True)
    (lens_dir / "preflight" / "inspection.json").write_text("{}\n", encoding="utf-8")
    (lens_dir / "preflight" / "inspector.json").write_text(
        json.dumps({"disposition": "model", "reason": "simple"}) + "\n", encoding="utf-8"
    )
    candidate = lens_dir / "attempts" / "m3" / "1"
    candidate.mkdir(parents=True)
    (candidate / "decision.json").write_text(
        json.dumps({"decision": "accept", "reason": "accepted by mistake"}) + "\n",
        encoding="utf-8",
    )
    (candidate / "stage-result.json").write_text(
        json.dumps(
            {
                "status": "success",
                "eligible_for_review": False,
                "gate_failures": ["non-finite numerical output: metrics.log_z"],
                "metrics": {"posterior_quantiles": {}},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (lens_dir / "accepted").mkdir()
    (lens_dir / "accepted" / "m3.json").write_text(
        json.dumps(
            {
                "schema_version": "accepted_stage_head.v1",
                "stage": "m3",
                "accepted_attempt": 1,
                "attempt_path": "../attempts/m3/1",
                "effective_config": "../attempts/m3/1/effective-config.json",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(["summary", "--output-dir", str(output_dir)])

    with (output_dir / "summary.csv").open(encoding="utf-8") as handle:
        row = next(csv.DictReader(handle))
    assert row["status"] == "human_review"
    assert row["diagnosis"] == "non-finite numerical output: metrics.log_z"


def test_summary_reports_stage_a_timeout_human_review_reason(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    lens_dir = output_dir / "lens-a"
    (lens_dir / "preflight").mkdir(parents=True)
    (lens_dir / "preflight" / "inspection.json").write_text("{}\n", encoding="utf-8")
    (lens_dir / "preflight" / "inspector.json").write_text(
        json.dumps({"disposition": "model", "reason": "simple"}) + "\n",
        encoding="utf-8",
    )
    (lens_dir / "attempts" / "a" / "0").mkdir(parents=True)
    (lens_dir / "attempts" / "a" / "0" / "decision.json").write_text(
        json.dumps(
            {
                "decision": "human_review",
                "reason": "Stage A exceeded 1800 seconds",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    main(["summary", "--output-dir", str(output_dir)])

    with (output_dir / "summary.csv").open(encoding="utf-8") as handle:
        row = next(csv.DictReader(handle))
    assert row["status"] == "human_review"
    assert row["diagnosis"] == "Stage A exceeded 1800 seconds"
