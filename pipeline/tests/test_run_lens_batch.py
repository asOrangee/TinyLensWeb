from __future__ import annotations

import csv
import fcntl
import os
import subprocess
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY_ROOT / "scripts" / "run_lens_batch.sh"


def _write_json(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload + "\n", encoding="utf-8")


def _make_success(result_dir: Path) -> None:
    _write_json(result_dir / "preflight" / "inspection.json", "{}")
    _write_json(result_dir / "preflight" / "inspector.json", '{"disposition":"model"}')
    _write_json(
        result_dir / "attempts" / "m3" / "0" / "decision.json",
        '{"decision":"accept","reason":"accepted by fake Codex"}',
    )
    _write_json(
        result_dir / "attempts" / "m3" / "0" / "stage-result.json",
        '{"status":"success","eligible_for_review":true,"gate_failures":[],"metrics":{"posterior_quantiles":{}}}',
    )
    _write_json(
        result_dir / "accepted" / "m3.json",
        '{"stage":"m3","attempt_path":"../attempts/m3/0"}',
    )


def _make_human_review(result_dir: Path) -> None:
    _write_json(result_dir / "preflight" / "inspection.json", "{}")
    _write_json(
        result_dir / "preflight" / "inspector.json",
        '{"disposition":"human_review","reason":"fake preflight review"}',
    )


def _make_fake_codex(path: Path) -> None:
    path.write_text(
        f"""#!{sys.executable}
import json
import os
import re
import sys
from pathlib import Path

prompt = sys.stdin.read()
lens_id = re.search(r"^Lens ID: (.+)$", prompt, re.MULTILINE).group(1)
result_dir = Path(re.search(r"^Lens Result Directory: (.+)$", prompt, re.MULTILINE).group(1))
record = Path(os.environ["FAKE_CODEX_RECORD"])
record.parent.mkdir(parents=True, exist_ok=True)
with record.open("a", encoding="utf-8") as handle:
    handle.write(lens_id + "\\n")

count_path = record.parent / (lens_id + ".count")
count = int(count_path.read_text(encoding="utf-8")) + 1 if count_path.exists() else 1
count_path.write_text(str(count), encoding="utf-8")

args = sys.argv[1:]
(record.parent / (lens_id + ".args.json")).write_text(
    json.dumps(args) + "\\n", encoding="utf-8"
)
(record.parent / (lens_id + ".env.json")).write_text(
    json.dumps({{
        "require_gpu_lease": os.environ.get("LENS_AGENT_REQUIRE_GPU_LEASE"),
        "gpu_lease": os.environ.get("LENS_AGENT_GPU_LEASE"),
    }}) + "\\n",
    encoding="utf-8",
)
(record.parent / (lens_id + ".prompt.txt")).write_text(prompt, encoding="utf-8")
if "--output-last-message" in args:
    target = Path(args[args.index("--output-last-message") + 1])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("fake Codex final message\\n", encoding="utf-8")

behavior = os.environ.get("FAKE_CODEX_BEHAVIOR", "success")
incomplete_lens = os.environ.get("FAKE_INCOMPLETE_LENS", "")
if behavior == "launcher_fail":
    raise SystemExit(42)
elif behavior == "mixed" and lens_id == incomplete_lens:
    result_dir.mkdir(parents=True, exist_ok=True)
elif behavior == "mixed":
    (result_dir / "preflight").mkdir(parents=True, exist_ok=True)
    (result_dir / "preflight" / "inspection.json").write_text("{{}}\\n", encoding="utf-8")
    (result_dir / "preflight" / "inspector.json").write_text(
        json.dumps({{"disposition": "human_review", "reason": "fake review"}}) + "\\n",
        encoding="utf-8",
    )
else:
    (result_dir / "preflight").mkdir(parents=True, exist_ok=True)
    (result_dir / "preflight" / "inspection.json").write_text("{{}}\\n", encoding="utf-8")
    (result_dir / "preflight" / "inspector.json").write_text(
        json.dumps({{"disposition": "model"}}) + "\\n", encoding="utf-8"
    )
    attempt = result_dir / "attempts" / "m3" / "0"
    attempt.mkdir(parents=True, exist_ok=True)
    (attempt / "decision.json").write_text(
        json.dumps({{"decision": "accept", "reason": "fake accept"}}) + "\\n",
        encoding="utf-8",
    )
    (attempt / "stage-result.json").write_text(
        json.dumps({{
            "status": "success",
            "eligible_for_review": True,
            "gate_failures": [],
            "metrics": {{"posterior_quantiles": {{}}}},
        }}) + "\\n",
        encoding="utf-8",
    )
    accepted = result_dir / "accepted"
    accepted.mkdir(parents=True, exist_ok=True)
    (accepted / "m3.json").write_text(
        json.dumps({{"stage": "m3", "attempt_path": "../attempts/m3/0"}}) + "\\n",
        encoding="utf-8",
    )
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _run_script(
    input_dir: Path,
    output_dir: Path,
    fake_codex: Path,
    record: Path,
    *extra: str,
    behavior: str = "success",
    incomplete_lens: str = "",
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.update(
        CODEX_BIN=str(fake_codex),
        FAKE_CODEX_RECORD=str(record),
        FAKE_CODEX_BEHAVIOR=behavior,
        FAKE_INCOMPLETE_LENS=incomplete_lens,
        LENS_AGENT_GPU_LEASE="1",
    )
    return subprocess.run(
        [
            "bash",
            str(SCRIPT),
            "--input-dir",
            str(input_dir),
            "--output-dir",
            str(output_dir),
            "--conda-env",
            sys.prefix,
            "--limit",
            str(len(list(input_dir.iterdir()))),
            *extra,
        ],
        cwd=REPOSITORY_ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


def test_dry_run_sorts_lenses_and_does_not_start_codex(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    for lens_id in ("lens-c", "lens-a", "lens-b"):
        (input_dir / lens_id).mkdir(parents=True)
    _make_success(output_dir / "lens-a")
    _make_human_review(output_dir / "lens-b")
    fake_codex = tmp_path / "fake-codex"
    _make_fake_codex(fake_codex)
    record = tmp_path / "invocations.txt"

    result = _run_script(input_dir, output_dir, fake_codex, record, "--dry-run")

    assert result.returncode == 0, result.stderr
    selected = [line.strip().split()[0] for line in result.stdout.splitlines()[1:4]]
    assert selected == ["lens-a", "lens-b", "lens-c"]
    assert "lens-a" in result.stdout and "success" in result.stdout
    assert "lens-b" in result.stdout and "human_review" in result.stdout
    assert "lens-c" in result.stdout and "not_started" in result.stdout
    assert not record.exists()
    assert not (output_dir / ".orchestrator-logs").exists()


def test_incomplete_lens_is_retried_twice_and_batch_continues(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    for lens_id in ("lens-a", "lens-b"):
        (input_dir / lens_id).mkdir(parents=True)
    fake_codex = tmp_path / "fake-codex"
    _make_fake_codex(fake_codex)
    record = tmp_path / "invocations.txt"

    result = _run_script(
        input_dir,
        output_dir,
        fake_codex,
        record,
        "--max-resumes",
        "2",
        behavior="mixed",
        incomplete_lens="lens-a",
    )

    assert result.returncode == 1
    assert record.read_text(encoding="utf-8").splitlines() == [
        "lens-a",
        "lens-a",
        "lens-a",
        "lens-b",
    ]
    rows = list(csv.DictReader((output_dir / "batch-status.tsv").open(encoding="utf-8"), delimiter="\t"))
    assert [(row["lens_id"], row["state"], row["sessions"]) for row in rows] == [
        ("lens-a", "session_incomplete", "3"),
        ("lens-b", "human_review", "1"),
    ]
    assert not (output_dir / "summary.csv").exists()


def test_all_terminal_results_generate_one_summary(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    (input_dir / "lens-a").mkdir(parents=True)
    fake_codex = tmp_path / "fake-codex"
    _make_fake_codex(fake_codex)
    record = tmp_path / "invocations.txt"

    result = _run_script(input_dir, output_dir, fake_codex, record)

    assert result.returncode == 0, result.stderr
    assert record.read_text(encoding="utf-8").splitlines() == ["lens-a"]
    with (output_dir / "summary.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert [(row["lens_id"], row["status"]) for row in rows] == [("lens-a", "success")]


def test_launcher_passes_separate_lens_and_gpu_stage_commands_to_experts(
    tmp_path: Path,
) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    (input_dir / "lens-a").mkdir(parents=True)
    fake_codex = tmp_path / "fake-codex"
    _make_fake_codex(fake_codex)
    record = tmp_path / "invocations.txt"

    result = _run_script(input_dir, output_dir, fake_codex, record)

    assert result.returncode == 0, result.stderr
    args = __import__("json").loads((tmp_path / "lens-a.args.json").read_text(encoding="utf-8"))
    sandbox_index = args.index("-s")
    assert args[sandbox_index + 1] == "danger-full-access"
    prompt = (tmp_path / "lens-a.prompt.txt").read_text(encoding="utf-8")
    expected_command = f"{os.path.realpath(sys.prefix)}/bin/python -m lens_agent.cli"
    assert f"Lens Agent Command: {expected_command}" in prompt
    expected_stage_command = (
        f"{REPOSITORY_ROOT}/scripts/run_lens_stage_on_idle_gpu.sh "
        f"--python {os.path.realpath(sys.prefix)}/bin/python"
    )
    assert f"GPU Stage Command: {expected_stage_command}" in prompt
    assert "Pass this exact Lens Agent Command to every Stage Expert" in prompt
    assert "Pass this exact GPU Stage Command to every Stage Expert" in prompt
    inherited = __import__("json").loads(
        (tmp_path / "lens-a.env.json").read_text(encoding="utf-8")
    )
    assert inherited["require_gpu_lease"] == "1"
    assert inherited["gpu_lease"] is None


def test_dry_run_does_not_import_the_pipeline_or_probe_jax(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    (input_dir / "lens-a").mkdir(parents=True)
    fake_codex = tmp_path / "fake-codex"
    _make_fake_codex(fake_codex)
    record = tmp_path / "invocations.txt"
    fake_env = tmp_path / "fake-env"
    fake_python = fake_env / "bin" / "python"
    fake_python.parent.mkdir(parents=True)
    fake_python.write_text(
        f"""#!{sys.executable}
import os
import sys

if sys.argv[1:2] == ["-c"]:
    print("unexpected Python import probe", file=sys.stderr)
    raise SystemExit(91)
os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])
""",
        encoding="utf-8",
    )
    fake_python.chmod(0o755)

    environment = os.environ.copy()
    environment.update(CODEX_BIN=str(fake_codex), FAKE_CODEX_RECORD=str(record))
    result = subprocess.run(
        [
            "bash",
            str(SCRIPT),
            "--input-dir",
            str(input_dir),
            "--output-dir",
            str(output_dir),
            "--conda-env",
            str(fake_env),
            "--limit",
            "1",
            "--dry-run",
        ],
        cwd=REPOSITORY_ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Dry run only" in result.stdout
    assert not record.exists()


def test_output_lock_rejects_a_second_runner(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    (input_dir / "lens-a").mkdir(parents=True)
    output_dir.mkdir()
    fake_codex = tmp_path / "fake-codex"
    _make_fake_codex(fake_codex)
    record = tmp_path / "invocations.txt"

    with (output_dir / ".lens-batch.lock").open("w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = _run_script(input_dir, output_dir, fake_codex, record)

    assert result.returncode == 2
    assert "another batch runner already holds the lock" in result.stderr
    assert not record.exists()


def test_launcher_failure_is_recorded_and_does_not_abort_the_shell(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    (input_dir / "lens-a").mkdir(parents=True)
    fake_codex = tmp_path / "fake-codex"
    _make_fake_codex(fake_codex)
    record = tmp_path / "invocations.txt"

    result = _run_script(
        input_dir,
        output_dir,
        fake_codex,
        record,
        "--max-resumes",
        "0",
        behavior="launcher_fail",
    )

    assert result.returncode == 1
    rows = list(csv.DictReader((output_dir / "batch-status.tsv").open(encoding="utf-8"), delimiter="\t"))
    assert [(row["state"], row["sessions"], row["last_codex_exit"]) for row in rows] == [
        ("launcher_failed", "1", "42")
    ]
