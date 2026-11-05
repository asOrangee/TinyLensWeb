"""Real preparation and process exclusion, with scientific computation replaced by a stub."""

import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from lens_agent import attempts, cli, stages
from lens_agent.models import StageName
from lens_agent.models import STAGE_ORDER
from lens_agent.operations import PreparationBlocked, StageBusy
from tests.test_stage_input import _input_record, _options


@pytest.fixture
def computation(monkeypatch):
    calls = []
    monkeypatch.setattr(stages, "_load_packaged_pipeline", lambda: SimpleNamespace(
        configure_runtime=lambda **kw: None))
    monkeypatch.setitem(stages.RUNNERS, StageName.A, lambda *args: calls.append(args))
    monkeypatch.setattr(stages, "_summarize", lambda *args: ({}, {}))
    monkeypatch.setattr(stages, "_gate_failures", lambda *args: [])
    return calls


def test_missing_config_automatically_prepares_and_runs_once(tmp_path, computation):
    lens, output = _input_record(tmp_path)
    expected = attempts.configuration_bundle(output, StageName.A, 0)
    result = stages.run_stage(lens, output, StageName.A, 0)
    assert result["status"] == "success"
    root = output / "attempts/a/0"
    for name, payload in expected.items():
        assert json.loads((root / name).read_text()) == payload
    assert (root / "stage-execution.json").exists()
    assert stages.run_stage(lens, output, StageName.A, 0) == result
    assert len(computation) == 1


@pytest.mark.parametrize("boundary", ["effective-config.json", "visual-prior-provenance.json", "publish"])
def test_interrupted_preparation_is_not_published_and_next_call_recovers(
    tmp_path, monkeypatch, computation, boundary
):
    lens, output = _input_record(tmp_path)
    write_text = Path.write_text
    with monkeypatch.context() as interruption:
        if boundary == "publish":
            interruption.setattr(attempts.os, "rename", lambda *args: (_ for _ in ()).throw(
                OSError("interrupted before publication")))
        else:
            def write(path, *args, **kwargs):
                result = write_text(path, *args, **kwargs)
                if path.name == boundary and path.parent.name.startswith(".prepare-"):
                    raise OSError("interrupted during preparation")
                return result
            interruption.setattr(Path, "write_text", write)
        with pytest.raises(PreparationBlocked, match="interrupted"):
            stages.run_stage(lens, output, StageName.A, 0)
    assert not (output / "attempts/a/0").exists()
    assert computation == []
    assert stages.run_stage(lens, output, StageName.A, 0)["status"] == "success"
    assert len(computation) == 1


def test_missing_input_is_correctable_without_a_failed_attempt(tmp_path, computation):
    lens, output = _input_record(tmp_path)
    fits = lens / f"{lens.name}.fits"
    saved = fits.with_suffix(".saved")
    fits.rename(saved)
    with pytest.raises(PreparationBlocked, match="Input FITS is missing"):
        stages.run_stage(lens, output, StageName.A, 0)
    assert not (output / "attempts").exists()
    evidence = json.loads((output / ".operations/a-0.jsonl").read_text())
    assert evidence["status"] == "preparation_blocked"
    saved.rename(fits)
    assert stages.run_stage(lens, output, StageName.A, 0)["status"] == "success"
    assert len(computation) == 1
    assert not (output / "attempts/a/1").exists()


@pytest.mark.parametrize("target", ["input", "mask"])
@pytest.mark.parametrize("prepare_only", [True, False])
def test_unreadable_input_blocks_before_sealing_and_can_resume(
    tmp_path, monkeypatch, computation, target, prepare_only
):
    lens, output = _input_record(tmp_path)
    path = (lens / f"{lens.name}.fits" if target == "input"
            else output / "preflight/modeling_mask.fits")
    original_open = Path.open
    with monkeypatch.context() as denied:
        def open_file(candidate, *args, **kwargs):
            if candidate == path:
                raise PermissionError(f"Read permission denied: {path}")
            return original_open(candidate, *args, **kwargs)
        denied.setattr(Path, "open", open_file)
        with pytest.raises(PreparationBlocked, match="Read permission denied"):
            stages.run_stage(lens, output, StageName.A, 0, prepare_only=prepare_only)
    assert computation == []
    assert not list(output.rglob("stage-execution.json"))
    assert not list(output.rglob("stage-result.json"))
    assert not list(output.rglob("decision.json"))
    assert stages.run_stage(lens, output, StageName.A, 0)["status"] == "success"
    assert len(computation) == 1


@pytest.mark.parametrize("authorized", [False, True])
def test_stage_b_selection_must_be_in_the_authorized_preparation_bundle(
    tmp_path, monkeypatch, authorized
):
    lens, output = _input_record(tmp_path)
    config = attempts.configuration_bundle(output, StageName.A, 0)["effective-config.json"]
    config["parent_config"] = "attempts/b/0/effective-config.json"
    bundle = {"effective-config.json": config}
    selection = {"schema_version": "arc_component_selection.v1",
                 "component_catalog": "attempts/b/0/artifacts/stage_b_components.json",
                 "drop_component_ids": [1]}
    if authorized:
        bundle["arc-component-selection.json"] = selection
    # Supply the authorization boundary; exercise real prepared-file and catalog checks.
    monkeypatch.setattr(stages, "configuration_bundle", lambda *args: bundle)
    monkeypatch.setattr(stages, "_accepted_upstream_dirs", lambda *args, **kwargs: {})
    root = output / "attempts/b/1"
    root.mkdir(parents=True)
    (root / "effective-config.json").write_text(json.dumps(config))
    selection_path = root / "arc-component-selection.json"
    selection_path.write_text(json.dumps(selection))
    original = selection_path.read_bytes()
    catalog = output / selection["component_catalog"]
    catalog.parent.mkdir(parents=True)
    catalog.write_text(json.dumps({"components": [{"id": 1}]}))
    assert stages._arc_component_selection(output, root, 1) == (1,)
    if authorized:
        assert stages.run_stage(lens, output, StageName.B, 1, prepare_only=True)["status"] == "prepared"
    else:
        with pytest.raises(PreparationBlocked, match="not authorized"):
            stages.run_stage(lens, output, StageName.B, 1, prepare_only=True)
    assert selection_path.read_bytes() == original
    assert not (root / "stage-execution.json").exists()
    assert not (root / "stage-result.json").exists()


@pytest.mark.parametrize("damage", ["missing", "malformed", "changed", "provenance"])
def test_existing_prepared_config_is_never_silently_repaired(tmp_path, computation, damage):
    lens, output = _input_record(tmp_path)
    stages.run_stage(lens, output, StageName.A, 0, prepare_only=True)
    root = output / "attempts/a/0"
    config = root / "effective-config.json"
    if damage == "missing":
        config.unlink()
    elif damage == "malformed":
        config.write_text("{")
    elif damage == "changed":
        value = json.loads(config.read_text())
        value["settings"]["stage_a_n_live"] += 100
        config.write_text(json.dumps(value))
    else:
        (root / "visual-prior-provenance.json").unlink()
    before = {p.name: p.read_bytes() for p in root.iterdir()}
    with pytest.raises(PreparationBlocked):
        stages.run_stage(lens, output, StageName.A, 0)
    assert {p.name: p.read_bytes() for p in root.iterdir()} == before
    assert computation == []


def test_retry_without_decision_and_downstream_without_acceptance_do_not_prepare(tmp_path):
    lens, output = _input_record(tmp_path)
    for stage, attempt in [(StageName.A, 1), (StageName.B, 0)]:
        with pytest.raises(PreparationBlocked):
            stages.run_stage(lens, output, stage, attempt, prepare_only=True)
    assert not (output / "attempts").exists()


def test_process_lock_blocks_preparation_and_execution_and_releases_on_death(tmp_path, computation):
    lens, output = _input_record(tmp_path)
    code = """
import sys
from pathlib import Path
from lens_agent.operations import attempt_lock
from lens_agent.models import StageName
with attempt_lock(Path(sys.argv[1]), StageName.A, 0):
    print('locked', flush=True)
    sys.stdin.read()
"""
    process = subprocess.Popen([sys.executable, "-c", code, str(output)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline().strip() == "locked"
        for prepare_only in [True, False]:
            with pytest.raises(StageBusy):
                stages.run_stage(lens, output, StageName.A, 0, prepare_only=prepare_only)
        with pytest.raises(StageBusy):
            attempts.prepare_attempt(output, StageName.A, 0)
        assert computation == []
    finally:
        process.kill()
        process.communicate(timeout=10)
    assert stages.run_stage(lens, output, StageName.A, 0)["status"] == "success"


def test_cli_preparation_blocked_is_structured_and_not_adjudicated(tmp_path, capsys):
    lens, output = _input_record(tmp_path)
    (output / "preflight/modeling_mask.fits").unlink()
    with pytest.raises(SystemExit) as exit:
        cli.main(["stage", *_options(lens, output), "--prepare-only"])
    assert exit.value.code == 2
    report = json.loads(capsys.readouterr().err)
    assert report["status"] == "preparation_blocked"
    assert report["next_action"]
    assert not list(output.rglob("decision.json"))


@pytest.mark.parametrize("manifest", [[], None, "invalid", 1, True])
@pytest.mark.parametrize("prepare_only", [True, False])
def test_non_object_run_manifest_blocks_and_same_attempt_can_resume(
    tmp_path, capsys, monkeypatch, computation, manifest, prepare_only
):
    lens, output = _input_record(tmp_path)
    monkeypatch.delenv("LENS_AGENT_REQUIRE_GPU_LEASE", raising=False)
    manifest_path = output / "run-manifest.json"
    original = manifest_path.read_bytes()
    manifest_path.write_text(json.dumps(manifest))
    before = {p.relative_to(output): p.read_bytes() for p in output.rglob("*") if p.is_file()}
    command = ["stage", *_options(lens, output)]
    if prepare_only:
        command.append("--prepare-only")

    with pytest.raises(SystemExit) as error:
        cli.main(command)

    assert error.value.code == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    report = json.loads(captured.err)
    assert report["status"] == "preparation_blocked"
    assert "JSON object" in report["reason"]
    assert report["next_action"]
    assert computation == []
    assert not (output / "attempts").exists()
    assert {p.relative_to(output): p.read_bytes() for p in output.rglob("*") if p.is_file()} == before

    manifest_path.write_bytes(original)
    cli.main(command)
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == ("prepared" if prepare_only else "success")
    assert result["attempt"] == 0
    assert len(computation) == (0 if prepare_only else 1)


def test_standalone_prepare_still_refuses_overwriting(tmp_path):
    _, output = _input_record(tmp_path)
    attempts.prepare_attempt(output, StageName.A, 0)
    with pytest.raises(ValueError, match="already exists"):
        attempts.prepare_attempt(output, StageName.A, 0)


def test_configuration_rechecked_after_gpu_wait(tmp_path, computation):
    lens, output = _input_record(tmp_path)
    stages.run_stage(lens, output, StageName.A, 0, prepare_only=True)
    config = output / "attempts/a/0/effective-config.json"
    value = json.loads(config.read_text())
    value["settings"]["stage_a_n_live"] += 1
    config.write_text(json.dumps(value))
    with pytest.raises(PreparationBlocked):
        stages.run_stage(lens, output, StageName.A, 0)
    assert computation == []
    assert not (config.parent / "stage-execution.json").exists()


def test_computation_retains_lock_until_result_written(tmp_path, computation, monkeypatch):
    lens, output = _input_record(tmp_path)
    def concurrent_request(*args):
        with pytest.raises(StageBusy):
            stages.run_stage(lens, output, StageName.A, 0)
        computation.append(True)
    monkeypatch.setitem(stages.RUNNERS, StageName.A, concurrent_request)
    assert stages.run_stage(lens, output, StageName.A, 0)["status"] == "success"
    assert len(computation) == 1


def test_preparation_permission_failure_is_unsealed(tmp_path, monkeypatch):
    lens, output = _input_record(tmp_path)
    original = Path.write_text
    def deny(path, *args, **kwargs):
        if path.parent.name.startswith(".prepare-"):
            raise PermissionError("simulated write permission failure")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "write_text", deny)
    with pytest.raises(PreparationBlocked, match="permission"):
        stages.run_stage(lens, output, StageName.A, 0)
    assert not list(output.rglob("stage-execution.json"))
    assert not list(output.rglob("decision.json"))


def test_unsealed_scientific_output_is_preserved(tmp_path, computation):
    lens, output = _input_record(tmp_path)
    stages.run_stage(lens, output, StageName.A, 0, prepare_only=True)
    artifact = output / "attempts/a/0/artifacts/stage_a.pkl"
    artifact.parent.mkdir()
    artifact.write_bytes(b"unexplained previous output")
    with pytest.raises(PreparationBlocked, match="already contains scientific output"):
        stages.run_stage(lens, output, StageName.A, 0)
    assert artifact.read_bytes() == b"unexplained previous output"
    assert computation == []


@pytest.mark.parametrize("stage", STAGE_ORDER[1:])
def test_initial_downstream_preparation_inherits_accepted_settings(tmp_path, monkeypatch, stage):
    lens, output = _input_record(tmp_path)
    base = attempts.configuration_bundle(output, StageName.A, 0)["effective-config.json"]
    previous = STAGE_ORDER[STAGE_ORDER.index(stage) - 1]
    parent = output / "attempts" / previous.value / "0"
    parent.mkdir(parents=True)
    (parent / "effective-config.json").write_text(json.dumps(base))
    heads = output / "accepted"
    heads.mkdir()
    (heads / f"{previous.value}.json").write_text(json.dumps({
        "stage": previous.value,
        "effective_config": f"../attempts/{previous.value}/0/effective-config.json",
    }))
    # Scientific acceptance is a separate tested boundary; exercise real config inheritance here.
    monkeypatch.setattr(stages, "_accepted_upstream_dirs", lambda *args, **kwargs: {})
    assert stages.run_stage(lens, output, stage, 0, prepare_only=True)["status"] == "prepared"
    config = json.loads((output / "attempts" / stage.value / "0/effective-config.json").read_text())
    assert config["settings"] == base["settings"]
    assert config["parent_config"] == f"attempts/{previous.value}/0/effective-config.json"


@pytest.mark.parametrize("status,exit_code", [
    ("success", 0), ("failed", 1), ("preparation_blocked", 2), ("busy", 75),
])
def test_runner_stops_before_gpu_when_preparation_does_not_request_execution(
    tmp_path, status, exit_code
):
    from tests.test_run_lens_stage_on_idle_gpu import (
        _make_fake_python, _make_fake_nvidia_smi, _runner_environment, _stage_command,
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    python = bin_dir / "python"
    _make_fake_python(python)
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, GPU, 0, 0\n")
    queried = tmp_path / "queried"
    env = _runner_environment(tmp_path, bin_dir=bin_dir,
                              FAKE_PREPARATION_STATUS=status,
                              FAKE_PREPARATION_EXIT=str(exit_code),
                              FAKE_NVIDIA_RECORD=str(queried))
    result = subprocess.run(_stage_command(python, "a", timeout=True), env=env,
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == exit_code
    assert json.loads(result.stdout)["status"] == status
    assert not queried.exists()
    assert not (tmp_path / "stage.json").exists()
