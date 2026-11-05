import json
import hashlib
import pickle
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from astropy.io import fits

from lens_agent.configuration import EffectiveConfig, PIPELINE_RELEASE_ID
from lens_agent.models import StageName
from lens_agent.modeling.source_grid import source_grid_spec
from lens_agent.modeling.predicted_image_family import build_predicted_image_family
from lens_agent import stages
from tests.helpers import make_lens_dir


@pytest.fixture(autouse=True)
def authorized_computation_fixture(monkeypatch):
    """These computation tests supply configs; preparation is tested end-to-end separately."""
    def bundle(output, stage, attempt):
        return {"effective-config.json": json.loads(
            (output / "attempts" / stage.value / str(attempt) / "effective-config.json").read_text()
        )}
    monkeypatch.setattr(stages, "configuration_bundle", bundle)


def _prepared_output(tmp_path: Path) -> tuple[Path, Path]:
    lens_dir = make_lens_dir(tmp_path)
    output_dir = tmp_path / "output" / lens_dir.name
    (output_dir / "preflight").mkdir(parents=True)
    (output_dir / "preflight" / "inspection.json").write_text(
        json.dumps({"lens_dir": str(lens_dir.resolve())}) + "\n", encoding="utf-8"
    )
    fits.writeto(output_dir / "preflight" / "modeling_mask.fits", np.zeros((32, 32), dtype=np.uint8))
    (output_dir / "preflight" / "inspector.json").write_text(
        json.dumps({"disposition": "model"}) + "\n", encoding="utf-8"
    )
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
    return lens_dir, output_dir


def _write_attempt_config(output_dir: Path, stage: StageName, attempt: int = 0) -> Path:
    attempt_dir = output_dir / "attempts" / stage.value / str(attempt)
    attempt_dir.mkdir(parents=True)
    (attempt_dir / "effective-config.json").write_text(
        json.dumps(EffectiveConfig().model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    return attempt_dir


def _write_predicted_image_family(artifact_dir: Path, shape=(32, 32)) -> None:
    family = build_predicted_image_family(
        [[-0.05, 0.05], [0.05, -0.05]],
        medians={
            "theta_E": 1.2, "e1_mass": 0.0, "e2_mass": 0.0,
            "center_x_mass": 0.0, "center_y_mass": 0.0,
            "gamma1": 0.0, "gamma2": 0.0,
            "center_x_src": 0.0, "center_y_src": 0.0,
        },
        image_shape=shape,
        pixel_scale_arcsec=0.1,
        stage_attempt="attempts/a/0",
        solver="optimization",
        solver_config={
            "initial_range": 4.0, "n_x": 400, "n_y": 400, "k_keep": 30,
            "num_iters": 20, "tolerance": 5.0e-4, "cluster_tol": 0.08,
        },
        threshold_arcsec=0.1,
        min_log_like=-1.0e10,
    )
    (artifact_dir / "stage_a_predicted_image_family.json").write_text(
        json.dumps(family) + "\n", encoding="utf-8"
    )


def _write_decision_evidence(attempt_root: Path) -> None:
    # Accepted fixtures include the configuration whose geometry is validated
    # before their scientific artifacts are reused by a downstream stage.
    config_path = attempt_root / "effective-config.json"
    if not config_path.exists():
        config_path.write_text(EffectiveConfig().model_dump_json() + "\n", encoding="utf-8")
    artifact_paths = [
        path for path in sorted((attempt_root / "artifacts").glob("*"))
        if path.is_file()
    ]
    (attempt_root / "manifest.json").write_text(
        json.dumps({
            "schema_version": "attempt_artifact_manifest.v1",
            "artifacts": [
                {
                    "path": path.relative_to(attempt_root).as_posix(),
                    "role": path.stem,
                    "media_type": "application/octet-stream",
                }
                for path in artifact_paths
            ],
        }) + "\n",
        encoding="utf-8",
    )
    core_names = (
        "effective-config.json", "stage-execution.json", "stage-result.json",
        "manifest.json", "arc-component-selection.json", "review.json",
        "stage.log", "traceback.log",
    )
    evidence = {
        name: (
            hashlib.sha256((attempt_root / name).read_bytes()).hexdigest()
            if (attempt_root / name).is_file() else None
        )
        for name in core_names
    }
    for path in artifact_paths:
        reference = path.relative_to(attempt_root).as_posix()
        evidence[f"artifact:{reference}"] = hashlib.sha256(path.read_bytes()).hexdigest()
    (attempt_root / "decision.json").write_text(
        json.dumps({"evidence_sha256": evidence}) + "\n", encoding="utf-8"
    )


def test_stage_writes_attempt_local_artifacts_and_manifest(
    tmp_path: Path, monkeypatch
) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    attempt_dir = _write_attempt_config(output_dir, StageName.A)
    pipeline = SimpleNamespace()

    def configure_runtime(
        *, config, artifact_dir, diagnostics_dir, upstream_dirs,
        stage_attempt_reference,
    ):
        pipeline.OUT_DIR = artifact_dir
        pipeline.DIAGNOSTICS_DIR = diagnostics_dir
        assert config.stage_a_n_live == 200
        assert upstream_dirs == {}
        assert stage_attempt_reference == "attempts/a/0"

    def run_stage_a(*_args, **_kwargs) -> None:
        payload = {
            "log_z": 3.0,
            "samples": np.zeros((1, 1)),
            "weights": np.ones(1),
            "param_names": ["theta_E"],
            "extra": {"medians": {"theta_E": 1.2}},
        }
        with (pipeline.OUT_DIR / "stage_a.pkl").open("wb") as handle:
            pickle.dump(payload, handle)
        (pipeline.DIAGNOSTICS_DIR / "stage_a_model.png").write_bytes(b"png")
        family = build_predicted_image_family(
            [[-0.5, 0.5], [0.5, -0.5]],
            medians={
                "theta_E": 1.2,
                "e1_mass": 0.0,
                "e2_mass": 0.0,
                "center_x_mass": 0.0,
                "center_y_mass": 0.0,
                "gamma1": 0.0,
                "gamma2": 0.0,
                "center_x_src": 0.0,
                "center_y_src": 0.0,
            },
            image_shape=(32, 32),
            pixel_scale_arcsec=0.1,
            stage_attempt="attempts/a/0",
            solver="optimization",
            solver_config={
                "initial_range": 4.0, "n_x": 400, "n_y": 400, "k_keep": 30,
                "num_iters": 20, "tolerance": 5.0e-4, "cluster_tol": 0.08,
            },
            threshold_arcsec=0.1,
            min_log_like=-1.0e10,
        )
        (pipeline.OUT_DIR / "stage_a_predicted_image_family.json").write_text(
            json.dumps(family) + "\n", encoding="utf-8"
        )

    pipeline.configure_runtime = configure_runtime
    pipeline.run_stage_a = run_stage_a
    monkeypatch.setattr(stages, "_load_packaged_pipeline", lambda: pipeline)

    before = {p.relative_to(attempt_dir): p.read_bytes() for p in attempt_dir.rglob("*")
              if p.is_file()}
    with pytest.raises(ValueError, match="input directory mismatch"):
        stages.run_stage(tmp_path / "wrong" / lens_dir.name, output_dir, StageName.A, 0)
    assert {p.relative_to(attempt_dir): p.read_bytes() for p in attempt_dir.rglob("*")
            if p.is_file()} == before
    assert not (attempt_dir / "stage-execution.json").exists()

    result = stages.run_stage(lens_dir, output_dir, StageName.A, 0)

    assert result["status"] == "success"
    assert stages.run_stage(lens_dir, output_dir, StageName.A, 0) == result
    assert result["artifacts"] == {
        "stage_pickle": "artifacts/stage_a.pkl",
        "predicted_image_family": "artifacts/stage_a_predicted_image_family.json",
        "model_png": "diagnostics/stage_a_model.png",
    }
    assert json.loads((attempt_dir / "stage-execution.json").read_text()) == {
        "schema_version": "stage_execution.v1",
        "stage": "a",
        "attempt": 0,
        "pipeline_release_id": PIPELINE_RELEASE_ID,
        "status": "started",
    }
    assert (attempt_dir / "stage-result.json").is_file()
    manifest = json.loads((attempt_dir / "manifest.json").read_text())
    assert manifest == {
        "schema_version": "attempt_artifact_manifest.v1",
        "artifacts": [
            {
                "path": "artifacts/stage_a.pkl",
                "role": "stage_pickle",
                "media_type": "application/octet-stream",
            },
            {
                "path": "artifacts/stage_a_predicted_image_family.json",
                "role": "predicted_image_family",
                "media_type": "application/json",
            },
            {
                "path": "diagnostics/stage_a_model.png",
                "role": "model_png",
                "media_type": "image/png",
            },
        ],
    }


def test_stage_result_embeds_eligibility_gate(tmp_path: Path, monkeypatch) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    attempt_dir = _write_attempt_config(output_dir, StageName.A)
    pipeline = SimpleNamespace(
        configure_runtime=lambda **_: None,
    )
    monkeypatch.setattr(stages, "_load_packaged_pipeline", lambda: pipeline)
    monkeypatch.setitem(
        stages.RUNNERS,
        StageName.A,
        lambda *_: (
            (attempt_dir / "artifacts" / "stage_a.pkl").write_bytes(b"cache"),
            (attempt_dir / "diagnostics" / "stage_a_model.png").write_bytes(b"plot"),
        ),
    )
    monkeypatch.setattr(
        stages,
        "_summarize",
        lambda *_: (
            {
                "stage_pickle": "artifacts/stage_a.pkl",
                "model_png": "diagnostics/stage_a_model.png",
            },
            {"log_z": 3.0},
        ),
    )

    result = stages.run_stage(lens_dir, output_dir, StageName.A, 0)

    assert result["status"] == "success"
    assert result["eligible_for_review"] is True
    assert result["gate_failures"] == []
    assert (attempt_dir / "stage-result.json").is_file()


def test_stage_survives_disconnected_stdout_and_records_progress(
    tmp_path: Path, monkeypatch
) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    attempt_dir = _write_attempt_config(output_dir, StageName.A)
    pipeline = SimpleNamespace(configure_runtime=lambda **_: None)
    monkeypatch.setattr(stages, "_load_packaged_pipeline", lambda: pipeline)

    def run_with_progress(*_args) -> None:
        print("sampling progress: 1/1")
        (attempt_dir / "artifacts" / "stage_a.pkl").write_bytes(b"cache")
        (attempt_dir / "diagnostics" / "stage_a_model.png").write_bytes(b"plot")

    monkeypatch.setitem(stages.RUNNERS, StageName.A, run_with_progress)
    monkeypatch.setattr(
        stages,
        "_summarize",
        lambda *_: (
            {
                "stage_pickle": "artifacts/stage_a.pkl",
                "model_png": "diagnostics/stage_a_model.png",
            },
            {"log_z": 3.0},
        ),
    )

    class DisconnectedStdout:
        def write(self, _text: str) -> int:
            raise BrokenPipeError(32, "Broken pipe")

        def flush(self) -> None:
            raise BrokenPipeError(32, "Broken pipe")

    monkeypatch.setattr(sys, "stdout", DisconnectedStdout())

    result = stages.run_stage(lens_dir, output_dir, StageName.A, 0)

    assert result["status"] == "success"
    assert json.loads((attempt_dir / "stage-result.json").read_text())["status"] == "success"
    log_text = (attempt_dir / "stage.log").read_text(encoding="utf-8")
    assert "sampling progress: 1/1" in log_text
    assert "status=success" in log_text


def test_stage_exception_records_attempt_local_traceback(
    tmp_path: Path, monkeypatch
) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    attempt_dir = _write_attempt_config(output_dir, StageName.A)
    monkeypatch.setattr(
        stages,
        "_load_packaged_pipeline",
        lambda: SimpleNamespace(configure_runtime=lambda **_: None),
    )

    def fail_stage(*_args) -> None:
        raise RuntimeError("scientific solver exploded")

    monkeypatch.setitem(stages.RUNNERS, StageName.A, fail_stage)

    result = stages.run_stage(lens_dir, output_dir, StageName.A, 0)

    assert result["status"] == "failed"
    assert result["error"] == "RuntimeError: scientific solver exploded"
    assert result["traceback_log"] == "traceback.log"
    traceback_text = (attempt_dir / "traceback.log").read_text(encoding="utf-8")
    assert "RuntimeError: scientific solver exploded" in traceback_text
    assert "fail_stage" in traceback_text
    log_text = (attempt_dir / "stage.log").read_text(encoding="utf-8")
    assert "status=failed" in log_text
    assert "traceback=traceback.log" in log_text


def test_stage_result_marks_nonfinite_output_ineligible(tmp_path: Path, monkeypatch) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    attempt_dir = _write_attempt_config(output_dir, StageName.M0)
    monkeypatch.setattr(
        stages, "_accepted_upstream_dirs", lambda *_, **__: {}
    )
    monkeypatch.setattr(
        stages,
        "_load_packaged_pipeline",
        lambda: SimpleNamespace(configure_runtime=lambda **_: None),
    )
    monkeypatch.setitem(
        stages.RUNNERS,
        StageName.M0,
        lambda *_: (
            (attempt_dir / "artifacts" / "stage_m0.pkl").write_bytes(b"cache"),
            (attempt_dir / "diagnostics" / "stage_m0_model.png").write_bytes(b"plot"),
        ),
    )
    monkeypatch.setattr(
        stages,
        "_summarize",
        lambda *_: (
            {
                "stage_pickle": "artifacts/stage_m0.pkl",
                "model_png": "diagnostics/stage_m0_model.png",
            },
            {
                "log_z": float("nan"),
                "source_grid_spec": source_grid_spec(
                    center_x=0.0, center_y=0.0, level=0
                ),
            },
        ),
    )

    result = stages.run_stage(lens_dir, output_dir, StageName.M0, 0)

    assert result["status"] == "success"
    assert result["eligible_for_review"] is False
    assert result["gate_failures"] == ["non-finite numerical output: metrics.log_z"]


def test_stage_b_gate_requires_expert_diagnostics(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    diagnostics_dir = tmp_path / "diagnostics"
    artifact_dir.mkdir()
    diagnostics_dir.mkdir()
    fits.writeto(artifact_dir / "feature_mask.fits", np.zeros((4, 4), dtype=np.uint8))
    (diagnostics_dir / "stage_b_mask.png").write_bytes(b"mask")

    artifacts, metrics = stages._summarize(artifact_dir, diagnostics_dir, StageName.B)

    assert set(artifacts) == {
        "feature_mask_fits",
        "stage_b_mask_png",
        "stage_b_components_png",
        "stage_b_components_json",
        "stage_b_morphology_audit_json",
        "stage_b_morphology_audit_png",
    }
    assert stages._gate_failures(StageName.B, artifacts, metrics, tmp_path) == [
        "missing artifact: stage_b_components_png",
        "missing artifact: stage_b_components_json",
        "missing artifact: stage_b_morphology_audit_json",
        "missing artifact: stage_b_morphology_audit_png",
    ]


def test_stage_a_gate_requires_a_valid_predicted_image_family(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    diagnostics_dir = tmp_path / "diagnostics"
    artifact_dir.mkdir()
    diagnostics_dir.mkdir()
    with (artifact_dir / "stage_a.pkl").open("wb") as handle:
        pickle.dump(
            {
                "log_z": 1.0, "samples": np.zeros((1, 1)),
                "weights": np.ones(1), "param_names": ["theta_E"],
                "extra": {"medians": {"theta_E": 1.2}},
            },
            handle,
        )
    (diagnostics_dir / "stage_a_model.png").write_bytes(b"png")

    artifacts, metrics = stages._summarize(
        artifact_dir, diagnostics_dir, StageName.A
    )
    assert stages._gate_failures(
        StageName.A, artifacts, metrics, tmp_path
    ) == ["missing artifact: predicted_image_family"]

    (artifact_dir / "stage_a_predicted_image_family.json").write_text(
        json.dumps({"schema_version": "wrong"}) + "\n", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="Predicted Image Family"):
        stages._summarize(artifact_dir, diagnostics_dir, StageName.A)


def test_m0_grid_edge_is_ineligible(tmp_path: Path, monkeypatch) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    attempt_dir = _write_attempt_config(output_dir, StageName.M0)
    monkeypatch.setattr(stages, "_accepted_upstream_dirs", lambda *_, **__: {})
    monkeypatch.setattr(
        stages,
        "_load_packaged_pipeline",
        lambda: SimpleNamespace(configure_runtime=lambda **_: None),
    )
    monkeypatch.setitem(
        stages.RUNNERS,
        StageName.M0,
        lambda *_: (
            (attempt_dir / "artifacts" / "stage_m0.pkl").write_bytes(b"cache"),
            (attempt_dir / "diagnostics" / "stage_m0_model.png").write_bytes(b"plot"),
        ),
    )
    monkeypatch.setattr(
        stages,
        "_summarize",
        lambda *_: (
            {
                "stage_pickle": "artifacts/stage_m0.pkl",
                "model_png": "diagnostics/stage_m0_model.png",
            },
            {
                "m0_lambda_search": {"fine_grid_best_at_edge": True},
                "source_grid_spec": source_grid_spec(
                    center_x=0.0, center_y=0.0, level=0
                ),
            },
        ),
    )

    result = stages.run_stage(lens_dir, output_dir, StageName.M0, 0)

    assert result["eligible_for_review"] is False
    assert result["gate_failures"] == ["M0 regularization optimum lies on the fine-grid boundary"]


def test_m0_uses_stage_a_lens_light_without_stage_l_cache(
    tmp_path: Path, monkeypatch
) -> None:
    artifact_dir = tmp_path / "current-artifacts"
    a_dir = tmp_path / "a-artifacts"
    b_dir = tmp_path / "b-artifacts"
    artifact_dir.mkdir()
    a_dir.mkdir()
    b_dir.mkdir()
    _write_predicted_image_family(a_dir)
    fits.writeto(b_dir / "feature_mask.fits", np.ones((32, 32), dtype=np.uint8))
    stage_a_lens_light = np.full((32, 32), 7.0)
    stage_a_payload = {
        "extra": {
            "lens_light_model": stage_a_lens_light,
            "medians": {"theta_E": 1.2},
            "source_grid_anchor": {"center_x": 0.1, "center_y": -0.2},
        }
    }
    received: dict[str, object] = {}

    def load_stage(tag: str):
        if tag != "a":
            raise AssertionError(f"unexpected upstream stage: {tag}")
        return stage_a_payload

    def run_stage_m0(
        image,
        noise,
        psf,
        feature_mask,
        lens_light,
        stage_a,
        position,
        source_grid_anchor,
        *,
        circular_mask,
    ) -> None:
        received["lens_light"] = lens_light
        received["source_grid_anchor"] = source_grid_anchor
        payload = {
            "log_z": 1.0,
            "samples": None,
            "weights": None,
            "param_names": [],
            "extra": {
                "log_lambda_best": 0.0,
                "evidence_lambda_best": 1.0,
                "log_ev_coarse": [0.0, 1.0, 0.0],
                "log_ev_fine": [0.0, 1.0, 0.0],
            },
        }
        with (artifact_dir / "stage_m0.pkl").open("wb") as handle:
            pickle.dump(payload, handle)
        (artifact_dir / "stage_m0_model.png").write_bytes(b"plot")

    pipeline = SimpleNamespace(
        OUT_DIR=artifact_dir,
        stage_output_dir=lambda tag: {"a": a_dir, "b": b_dir}[tag],
        _load_stage=load_stage,
        _stage_from_payload=lambda payload: "stage-a-model",
        run_stage_m0=run_stage_m0,
    )
    stages._stage_m0(
        pipeline,
        np.zeros((32, 32)),
        np.ones((32, 32)),
        np.ones((3, 3)),
        np.zeros((32, 32), dtype=bool),
    )

    assert received["lens_light"] is stage_a_lens_light
    assert received["source_grid_anchor"] == {
        "center_x": 0.1,
        "center_y": -0.2,
    }
    assert not (artifact_dir / "stage_l.pkl").exists()


def test_downstream_uses_the_saved_stage_a_predicted_image_family(tmp_path: Path) -> None:
    a_dir = tmp_path / "a-artifacts"
    b_dir = tmp_path / "b-artifacts"
    a_dir.mkdir()
    b_dir.mkdir()
    fits.writeto(b_dir / "feature_mask.fits", np.ones((40, 40), dtype=np.uint8))
    family = build_predicted_image_family(
        [[-0.8, 1.7], [-0.7, -1.0], [1.2, 1.1], [1.7, -0.4]],
        medians={
            "theta_E": 1.6,
            "e1_mass": -0.1,
            "e2_mass": 0.06,
            "center_x_mass": 0.05,
            "center_y_mass": 0.06,
            "gamma1": -0.05,
            "gamma2": -0.06,
            "center_x_src": 0.12,
            "center_y_src": 0.18,
        },
        image_shape=(40, 40),
        pixel_scale_arcsec=0.1,
        stage_attempt="attempts/a/0",
        solver="optimization",
        solver_config={
            "initial_range": 4.0, "n_x": 400, "n_y": 400, "k_keep": 30,
            "num_iters": 20, "tolerance": 5.0e-4, "cluster_tol": 0.08,
        },
        threshold_arcsec=0.1,
        min_log_like=-1.0e10,
    )
    (a_dir / "stage_a_predicted_image_family.json").write_text(
        json.dumps(family) + "\n", encoding="utf-8"
    )
    payload = {
        "extra": {
            "medians": family["provenance"]["medians"],
            "lens_light_model": np.zeros((40, 40)),
        }
    }
    pipeline = SimpleNamespace(
        stage_output_dir=lambda tag: {"a": a_dir, "b": b_dir}[tag],
        _load_stage=lambda _tag: payload,
        _stage_from_payload=lambda _payload: "stage-a",
    )

    _, _, _, _, position_likelihood = stages._common_mass_inputs(pipeline)

    assert position_likelihood == {
        "positions": [[-0.8, 1.7], [-0.7, -1.0], [1.2, 1.1], [1.7, -0.4]],
        "threshold_arcsec": 0.1,
        "min_log_like": -1.0e10,
    }


def test_m0_receives_stage_a_anchor_and_downstream_receives_m0_sealed_grid(
    tmp_path: Path,
) -> None:
    b_dir = tmp_path / "b-artifacts"
    b_dir.mkdir()
    _write_predicted_image_family(tmp_path, shape=(4, 4))
    fits.writeto(b_dir / "feature_mask.fits", np.ones((4, 4), dtype=np.uint8))
    source_grid_anchor = {"center_x": 0.1, "center_y": -0.2}
    sealed_grid = source_grid_spec(center_x=0.1, center_y=-0.2, level=1)
    s1 = {"source_bbox": sealed_grid["pixel_center_bbox"]}
    payloads = {
        "a": {
            "tag": "a",
            "extra": {
                "medians": {"center_x_mass": 0.0, "center_y_mass": 0.0},
                "lens_light_model": np.zeros((4, 4)),
                "source_grid_anchor": source_grid_anchor,
            },
        },
        "m0": {"tag": "m0", "extra": {"log_lambda_best": 0.0}},
        "m1": {
            "tag": "m1",
            "extra": {
                "medians": {
                    "theta_E": 1.2,
                    "e1_mass": 0.0,
                    "e2_mass": 0.0,
                    "gamma1": 0.0,
                    "gamma2": 0.0,
                },
                "s1": s1,
            },
        },
        "m2": {
            "tag": "m2",
            "extra": {
                "medians": {"log_lambda_reg": 0.0, "adaptive_reg_rho": 2.0}
            },
        },
    }
    received: dict[str, object] = {}

    def validate_package(package, expected_grid):
        assert package is s1
        assert expected_grid == sealed_grid
        return package

    pipeline = SimpleNamespace(
        stage_output_dir=lambda tag: b_dir if tag == "b" else tmp_path,
        _load_stage=lambda tag: payloads[tag],
        _stage_from_payload=lambda payload: f"stage-{payload['tag']}",
        _load_source_grid_spec=lambda _path: sealed_grid,
        _validate_source_template_package=validate_package,
        _reg_hyperparams_from_m2_payload=lambda _payload: {
            "log_lambda_reg": 0.0,
            "adaptive_reg_rho": 2.0,
        },
        run_stage_m0=lambda *args, **_kwargs: received.update(m0=args[7]),
        run_stage_m1=lambda *args, **_kwargs: received.update(m1=args[8]),
        run_stage_m2=lambda *args, **_kwargs: received.update(m2=args[8]),
        run_stage_m3=lambda *args, **_kwargs: received.update(m3=args[10]),
    )
    image = np.zeros((4, 4))
    noise = np.ones((4, 4))
    psf = np.ones((3, 3))
    mask = np.zeros((4, 4), dtype=bool)

    stages._stage_m0(pipeline, image, noise, psf, mask)
    stages._stage_m1(pipeline, image, noise, psf, mask)
    stages._stage_m2(pipeline, image, noise, psf, mask)
    stages._stage_m3(pipeline, image, noise, psf, mask)

    assert received == {
        "m0": source_grid_anchor,
        "m1": sealed_grid,
        "m2": sealed_grid,
        "m3": sealed_grid,
    }


def test_downstream_rejects_m0_grid_from_a_different_configuration_level(
    tmp_path: Path,
) -> None:
    _, output_dir = _prepared_output(tmp_path)
    for stage, artifact_name in (
        ("a", "stage_a.pkl"),
        ("b", "feature_mask.fits"),
        ("m0", "stage_m0.pkl"),
    ):
        attempt_root = output_dir / "attempts" / stage / "0"
        artifact_dir = attempt_root / "artifacts"
        artifact_dir.mkdir(parents=True)
        (artifact_dir / artifact_name).write_bytes(b"artifact")
        if stage == "a":
            _write_predicted_image_family(artifact_dir)
        (output_dir / "accepted").mkdir(exist_ok=True)
        (output_dir / "accepted" / f"{stage}.json").write_text(
            json.dumps(
                {
                    "stage": stage,
                    "accepted_attempt": 0,
                    "attempt_path": f"../attempts/{stage}/0",
                }
            )
            + "\n",
            encoding="utf-8",
        )
    m0_grid_path = output_dir / "attempts" / "m0" / "0" / "artifacts" / "source_grid_spec.json"
    m0_grid_path.write_text(
        json.dumps(source_grid_spec(center_x=0.0, center_y=0.0, level=1)) + "\n",
        encoding="utf-8",
    )
    for stage in ("a", "b", "m0"):
        _write_decision_evidence(output_dir / "attempts" / stage / "0")

    with pytest.raises(ValueError, match="does not match its configuration"):
        stages._accepted_upstream_dirs(
            output_dir, StageName.M1, expected_source_grid_level=0
        )


def test_downstream_rejects_a_family_changed_after_stage_a_acceptance(
    tmp_path: Path,
) -> None:
    _, output_dir = _prepared_output(tmp_path)
    accepted_a = output_dir / "attempts" / "a" / "0"
    artifacts = accepted_a / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "stage_a.pkl").write_bytes(b"stage a")
    _write_predicted_image_family(artifacts)
    _write_decision_evidence(accepted_a)
    (output_dir / "accepted").mkdir()
    (output_dir / "accepted" / "a.json").write_text(
        json.dumps({
            "stage": "a", "accepted_attempt": 0,
            "attempt_path": "../attempts/a/0",
        }) + "\n",
        encoding="utf-8",
    )
    family_path = artifacts / "stage_a_predicted_image_family.json"
    family_path.write_text(family_path.read_text() + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="stage_a_predicted_image_family.json"):
        stages._accepted_upstream_dirs(
            output_dir, StageName.B, expected_source_grid_level=0
        )


def test_stage_refuses_a_human_review_lens_even_with_a_stale_mask(tmp_path: Path) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    _write_attempt_config(output_dir, StageName.A)
    (output_dir / "preflight" / "inspector.json").write_text(
        json.dumps({"disposition": "human_review"}) + "\n", encoding="utf-8"
    )

    with pytest.raises(stages.PreparationBlocked, match="human_review"):
        stages.run_stage(lens_dir, output_dir, StageName.A, 0)
    assert not (output_dir / "attempts/a/0/stage-execution.json").exists()


def test_stage_refuses_a_run_pinned_to_another_pipeline_release(tmp_path: Path) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    _write_attempt_config(output_dir, StageName.A)
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

    stage_result = output_dir / "attempts" / "a" / "0" / "stage-result.json"

    with pytest.raises(ValueError, match="different Pipeline Release"):
        stages.run_stage(lens_dir, output_dir, StageName.A, 0)

    assert not stage_result.exists()


def test_stage_b_refuses_a_selection_not_bound_to_its_parent_catalog(tmp_path: Path) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    candidate = _write_attempt_config(output_dir, StageName.B)
    accepted_a = output_dir / "attempts" / "a" / "0"
    (accepted_a / "artifacts").mkdir(parents=True)
    (accepted_a / "artifacts" / "stage_a.pkl").write_bytes(
        b"selection validation fails before this placeholder is opened"
    )
    _write_predicted_image_family(accepted_a / "artifacts")
    _write_decision_evidence(accepted_a)
    (output_dir / "accepted").mkdir()
    (output_dir / "accepted" / "a.json").write_text(
        json.dumps(
            {
                "schema_version": "accepted_stage_head.v1",
                "stage": "a",
                "accepted_attempt": 0,
                "attempt_path": "../attempts/a/0",
                "effective_config": "../attempts/a/0/effective-config.json",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (candidate / "arc-component-selection.json").write_text(
        json.dumps(
            {
                "schema_version": "arc_component_selection.v1",
                "component_catalog": "attempts/b/99/artifacts/stage_b_components.json",
                "drop_component_ids": [1],
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="parent component catalog"):
        stages._arc_component_selection(output_dir, candidate, 0)
    with pytest.raises(stages.PreparationBlocked, match="not authorized"):
        stages.run_stage(lens_dir, output_dir, StageName.B, 0)
    assert not (candidate / "stage-execution.json").exists()


def test_stage_refuses_accepted_artifacts_symlinked_outside_the_lens_root(
    tmp_path: Path,
) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    _write_attempt_config(output_dir, StageName.B)
    accepted_a = output_dir / "attempts" / "a" / "0"
    accepted_a.mkdir(parents=True)
    external = tmp_path / "external-artifacts"
    external.mkdir()
    (accepted_a / "artifacts").symlink_to(external, target_is_directory=True)
    (output_dir / "accepted").mkdir()
    (output_dir / "accepted" / "a.json").write_text(
        json.dumps(
            {
                "schema_version": "accepted_stage_head.v1",
                "stage": "a",
                "accepted_attempt": 0,
                "attempt_path": "../attempts/a/0",
                "effective_config": "../attempts/a/0/effective-config.json",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    stage_result = output_dir / "attempts" / "b" / "0" / "stage-result.json"

    with pytest.raises(ValueError, match="must not contain symbolic links"):
        stages.run_stage(lens_dir, output_dir, StageName.B, 0)

    assert not stage_result.exists()


def test_stage_refuses_an_accepted_artifact_file_symlinked_outside_the_lens_root(
    tmp_path: Path,
) -> None:
    lens_dir, output_dir = _prepared_output(tmp_path)
    _write_attempt_config(output_dir, StageName.B)
    accepted_a = output_dir / "attempts" / "a" / "0"
    artifacts = accepted_a / "artifacts"
    artifacts.mkdir(parents=True)
    external_pickle = tmp_path / "external-stage-a.pkl"
    external_pickle.write_bytes(b"external pickle must never be opened")
    (artifacts / "stage_a.pkl").symlink_to(external_pickle)
    (output_dir / "accepted").mkdir()
    (output_dir / "accepted" / "a.json").write_text(
        json.dumps(
            {
                "schema_version": "accepted_stage_head.v1",
                "stage": "a",
                "accepted_attempt": 0,
                "attempt_path": "../attempts/a/0",
                "effective_config": "../attempts/a/0/effective-config.json",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    stage_result = output_dir / "attempts" / "b" / "0" / "stage-result.json"

    with pytest.raises(ValueError, match="must not contain symbolic links"):
        stages.run_stage(lens_dir, output_dir, StageName.B, 0)

    assert not stage_result.exists()
