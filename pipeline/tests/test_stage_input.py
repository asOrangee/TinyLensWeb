import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from lens_agent import cli, stages
from lens_agent.configuration import PIPELINE_RELEASE_ID
from lens_agent.models import StageName
from tests.helpers import make_lens_dir, model_inspector_decision
from astropy.io import fits
import numpy as np


def _input_record(tmp_path):
    (tmp_path / "data").mkdir()
    expected = make_lens_dir(tmp_path / "data", "lens-a")
    output = tmp_path / "results" / "lens-a"
    (output / "preflight").mkdir(parents=True)
    (output / "preflight" / "inspection.json").write_text(
        json.dumps({"lens_dir": str(expected)})
    )
    (output / "run-manifest.json").write_text(json.dumps({
        "schema_version": "lens_run_manifest.v1",
        "pipeline_release_id": PIPELINE_RELEASE_ID,
    }))
    (output / "preflight/inspector.json").write_text(json.dumps(model_inspector_decision("lens-a")))
    fits.writeto(output / "preflight/modeling_mask.fits", np.zeros((32, 32), dtype=np.uint8))
    return expected, output


def _snapshot(output):
    return {str(p.relative_to(output)): p.read_bytes() if p.is_file() else None
            for p in output.rglob("*")}


def _options(lens, output, stage="a"):
    return ["--lens-dir", str(lens), "--output-dir", str(output),
            "--stage", stage, "--attempt", "0"]


@pytest.mark.parametrize("stage", list(StageName))
def test_direct_stage_rejects_wrong_path_without_writing(tmp_path, stage):
    expected, output = _input_record(tmp_path)
    wrong = tmp_path / "wrong" / expected.name
    before = _snapshot(output)
    with pytest.raises(ValueError, match="input directory mismatch") as error:
        stages.run_stage(wrong, output, stage, 0)
    assert str(expected) in str(error.value)
    assert str(wrong) in str(error.value)
    assert "inspection.json" in str(error.value)
    assert _snapshot(output) == before


def test_prepare_only_requires_no_gpu_and_prepares_without_execution(tmp_path, monkeypatch):
    expected, output = _input_record(tmp_path)
    monkeypatch.setenv("LENS_AGENT_REQUIRE_GPU_LEASE", "1")
    monkeypatch.delenv("LENS_AGENT_GPU_LEASE", raising=False)
    before = _snapshot(output)
    cli.main(["stage", *_options(expected, output), "--prepare-only"])
    assert (output / "attempts/a/0/effective-config.json").exists()
    assert not (output / "attempts/a/0/stage-execution.json").exists()


@pytest.mark.parametrize("mutation", [None, "changed_old", "missing_old", "changed_new"])
def test_legacy_prepared_config_resumes_without_rewriting_evidence(tmp_path, mutation):
    from lens_agent.operations import PreparationBlocked

    lens, output = _input_record(tmp_path)
    stages.run_stage(lens, output, StageName.A, 0, prepare_only=True)
    root = output / "attempts/a/0"
    path = root / "effective-config.json"
    config = json.loads(path.read_text())
    for name in ("stage_subhalo_n_live", "stage_subhalo_n_eff"):
        del config["settings"][name]
    if mutation == "changed_old":
        config["settings"]["stage_a_n_eff"] += 1
    elif mutation == "missing_old":
        del config["settings"]["stage_a_n_eff"]
    elif mutation == "changed_new":
        config["settings"]["stage_subhalo_n_live"] = 700
    path.write_text(json.dumps(config))
    before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
    if mutation is None:
        result = stages.run_stage(lens, output, StageName.A, 0, prepare_only=True)
        assert result == {"status": "prepared", "stage": "a", "attempt": 0}
    else:
        with pytest.raises(PreparationBlocked, match="does not match"):
            stages.run_stage(lens, output, StageName.A, 0, prepare_only=True)
    assert {p: p.read_bytes() for p in root.rglob("*") if p.is_file()} == before
    assert not (root / "stage-execution.json").exists()


@pytest.mark.parametrize("contents", [None, "{", "[]", "{}", '{"lens_dir": null}',
                                     '{"lens_dir": ""}', '{"lens_dir": "relative/lens"}',
                                     '{"lens_dir": 123}'])
def test_invalid_preflight_is_rejected_without_writes(tmp_path, contents, capsys):
    expected, output = _input_record(tmp_path)
    record = output / "preflight" / "inspection.json"
    if contents is None:
        record.unlink()
    else:
        record.write_text(contents)
    before = _snapshot(output)
    with pytest.raises(SystemExit) as error:
        cli.main(["stage", *_options(expected, output), "--prepare-only"])
    assert error.value.code == 2
    assert str(record) in capsys.readouterr().err
    assert _snapshot(output) == before


def test_equivalent_input_paths_pass(tmp_path):
    expected, output = _input_record(tmp_path)
    alias = tmp_path / "input-link"
    alias.symlink_to(expected, target_is_directory=True)
    cli.main(["stage", *_options(expected, output), "--prepare-only"])
    before = _snapshot(output)
    for lens in [expected, expected / ".." / expected.name, alias]:
        cli.main(["stage", *_options(lens, output), "--prepare-only"])
    assert _snapshot(output) == before


def test_execution_cli_reports_input_error_without_traceback(tmp_path, monkeypatch, capsys):
    expected, output = _input_record(tmp_path)
    monkeypatch.delenv("LENS_AGENT_REQUIRE_GPU_LEASE", raising=False)
    monkeypatch.delenv("LENS_AGENT_GPU_LEASE", raising=False)
    before = _snapshot(output)
    with pytest.raises(SystemExit) as error:
        cli.main(["stage", *_options(tmp_path / "wrong" / expected.name, output)])
    assert error.value.code == 2
    assert "input directory mismatch" in capsys.readouterr().err
    assert _snapshot(output) == before


def test_execution_rechecks_after_successful_input_check(tmp_path, monkeypatch):
    expected, output = _input_record(tmp_path)
    cli.main(["stage", *_options(expected, output), "--prepare-only"])
    record = output / "preflight" / "inspection.json"
    record.write_text(json.dumps({"lens_dir": str(tmp_path / "changed" / expected.name)}))
    monkeypatch.delenv("LENS_AGENT_REQUIRE_GPU_LEASE", raising=False)
    before = _snapshot(output)
    with pytest.raises(SystemExit) as error:
        cli.main(["stage", *_options(expected, output)])
    assert error.value.code == 2
    assert _snapshot(output) == before


@pytest.mark.parametrize("gpu", [None, "0"])
@pytest.mark.parametrize(
    "check_flag,valid_input,exit_code",
    [
        (None, False, 2),
        ("--prepare-only", False, 2),
        ("--prepare-only", True, 0),
        ("--prepare-only-only", True, 2),
        ("--check", True, 2),
        ("--check-in", True, 2),
    ],
)
def test_runner_input_checks_do_not_use_gpu_or_write_results(
    tmp_path, gpu, check_flag, valid_input, exit_code
):
    expected, output = _input_record(tmp_path)
    wrong = tmp_path / "wrong" / expected.name
    from tests.test_run_lens_stage_on_idle_gpu import SCRIPT, _make_fake_nvidia_smi
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, GPU, 0, 0\n")
    query_record = tmp_path / "queried"
    locks = tmp_path / "locks"
    env = os.environ.copy()
    env.pop("CUDA_VISIBLE_DEVICES", None)
    if gpu is not None:
        env["CUDA_VISIBLE_DEVICES"] = gpu
    env.update(PATH=str(bin_dir) + os.pathsep + env["PATH"],
               FAKE_NVIDIA_RECORD=str(query_record), GPU_LOCK_ROOT=str(locks))
    before = _snapshot(output)
    result = subprocess.run(
        [str(SCRIPT), "--python", sys.executable, "--timeout-seconds", "1800",
         "--", *_options(expected if valid_input else wrong, output),
         *([check_flag] if check_flag else [])],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == exit_code
    if not valid_input:
        assert "input directory mismatch" in result.stderr
        assert str(expected) in result.stderr and str(wrong) in result.stderr
    elif exit_code == 2:
        assert "unrecognized arguments" in result.stderr
    assert "Traceback" not in result.stderr
    assert "Assigned GPU" not in result.stderr
    assert not query_record.exists()
    assert not locks.exists()
    if valid_input and exit_code == 0:
        assert (output / "attempts/a/0/effective-config.json").exists()
        assert not (output / "attempts/a/0/stage-execution.json").exists()
    else:
        assert _snapshot(output) == before


@pytest.mark.parametrize("flag", ["--check-input", "--prepare", "--check", "--check-in", "--lens-d"])
def test_stage_parser_rejects_old_flag_and_abbreviations(tmp_path, flag):
    options = _options(tmp_path / "lens", tmp_path / "output")
    if flag == "--lens-d":
        options[0] = flag
    else:
        options.append(flag)
    with pytest.raises(SystemExit) as error:
        cli.build_parser().parse_args(["stage", *options])
    assert error.value.code == 2
