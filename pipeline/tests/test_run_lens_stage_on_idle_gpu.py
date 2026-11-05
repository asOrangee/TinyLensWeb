from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY_ROOT / "scripts" / "run_lens_stage_on_idle_gpu.sh"
_UNSET = object()


def _make_fake_nvidia_smi(path: Path, output: str) -> None:
    path.write_text(
        f"#!{sys.executable}\n"
        "import os\n"
        "from pathlib import Path\n"
        "record = os.environ.get('FAKE_NVIDIA_RECORD')\n"
        "if record:\n"
        "    Path(record).write_text('called\\n', encoding='utf-8')\n"
        "status = int(os.environ.get('FAKE_NVIDIA_STATUS', '0'))\n"
        "if status:\n"
        "    raise SystemExit(status)\n"
        "import time\n"
        "time.sleep(float(os.environ.get('FAKE_NVIDIA_SLEEP', '0')))\n"
        f"print({output!r}, end='')\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _make_fake_python(path: Path) -> None:
    path.write_text(
        f"#!{sys.executable}\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "if '-c' in sys.argv:\n"
        "    exec(sys.argv[sys.argv.index('-c') + 1])\n"
        "    raise SystemExit(0)\n"
        "if '--prepare-only' in sys.argv:\n"
        "    print(json.dumps({'status': os.environ.get('FAKE_PREPARATION_STATUS', 'prepared')}))\n"
        "    raise SystemExit(int(os.environ.get('FAKE_PREPARATION_EXIT', '0')))\n"
        "Path(os.environ['FAKE_STAGE_RECORD']).write_text(json.dumps({\n"
        "    'argv': sys.argv[1:],\n"
        "    'cuda_visible_devices': os.environ.get('CUDA_VISIBLE_DEVICES'),\n"
        "    'cuda_device_order': os.environ.get('CUDA_DEVICE_ORDER'),\n"
        "    'gpu_lease': os.environ.get('LENS_AGENT_GPU_LEASE'),\n"
        "    'preallocate': os.environ.get('XLA_PYTHON_CLIENT_PREALLOCATE'),\n"
        "}) + '\\n', encoding='utf-8')\n"
        "import time\n"
        "time.sleep(float(os.environ.get('FAKE_STAGE_SLEEP', '0')))\n"
        "raise SystemExit(int(os.environ.get('FAKE_STAGE_STATUS', '0')))\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _runner_environment(
    tmp_path: Path,
    *,
    bin_dir: Path | None = None,
    cuda_visible_devices: str | object = _UNSET,
    **overrides: str,
) -> dict[str, str]:
    environment = os.environ.copy()
    environment.pop("CUDA_VISIBLE_DEVICES", None)
    environment.pop("XLA_PYTHON_CLIENT_PREALLOCATE", None)
    environment.update(
        GPU_LOCK_ROOT=str(tmp_path / "locks"),
        FAKE_STAGE_RECORD=str(tmp_path / "stage.json"),
    )
    if bin_dir is not None:
        environment["PATH"] = f"{bin_dir}:{environment['PATH']}"
    if cuda_visible_devices is not _UNSET:
        environment["CUDA_VISIBLE_DEVICES"] = str(cuda_visible_devices)
    environment.update(overrides)
    return environment


def _stage_command(
    python_path: Path,
    stage: str,
    *,
    timeout: bool = False,
    stage_options: tuple[str, ...] = (),
) -> list[str]:
    command = [str(SCRIPT), "--python", str(python_path)]
    if timeout:
        command.extend(("--timeout-seconds", "1800"))
    return [
        *command,
        "--",
        *stage_options,
        "--stage",
        stage,
        "--attempt",
        "0",
    ]


def _wait_for_path(path: Path, timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {path}")


def test_selects_the_least_used_idle_gpu_and_runs_only_a_lens_stage(
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(
        bin_dir / "nvidia-smi",
        "0, NVIDIA A, 450, 1\n"
        "2, NVIDIA C, 100, 8\n"
        "1, NVIDIA B, 100, 3\n"
        "3, TOO FULL, 2001, 0\n"
        "4, TOO BUSY, 0, 11\n",
    )
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    record = tmp_path / "stage.json"
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        FAKE_STAGE_RECORD=str(record),
    )

    result = subprocess.run(
        _stage_command(
            fake_python,
            "m1",
            stage_options=(
                "--lens-dir",
                "/data/lens-a",
                "--output-dir",
                "/results/lens-a",
            ),
        ),
        cwd=REPOSITORY_ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    invocation = json.loads(record.read_text(encoding="utf-8"))
    assert invocation == {
        "argv": [
            "-m",
            "lens_agent.cli",
            "stage",
            "--lens-dir",
            "/data/lens-a",
            "--output-dir",
            "/results/lens-a",
            "--stage",
            "m1",
            "--attempt",
            "0",
        ],
        "cuda_visible_devices": "1",
        "cuda_device_order": "PCI_BUS_ID",
        "gpu_lease": "1",
        "preallocate": None,
    }
    assert "Assigned GPU 1" in result.stderr


def test_default_memory_threshold_includes_2000_mib(
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(
        bin_dir / "nvidia-smi",
        "0, AT LIMIT, 2000, 0\n",
    )
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    record = tmp_path / "stage.json"

    result = subprocess.run(
        _stage_command(fake_python, "m1"),
        env=_runner_environment(
            tmp_path,
            bin_dir=bin_dir,
            FAKE_STAGE_RECORD=str(record),
        ),
        text=True,
        capture_output=True,
        check=False,
        timeout=2,
    )

    assert result.returncode == 0, result.stderr
    invocation = json.loads(record.read_text(encoding="utf-8"))
    assert invocation["cuda_visible_devices"] == "0"


def test_respects_an_existing_single_gpu_assignment_without_querying(
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    nvidia_record = tmp_path / "nvidia-called"
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, NVIDIA A, 0, 0\n")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    stage_record = tmp_path / "stage.json"
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        cuda_visible_devices="4",
        FAKE_NVIDIA_RECORD=str(nvidia_record),
        FAKE_STAGE_RECORD=str(stage_record),
    )

    result = subprocess.run(
        _stage_command(fake_python, "m0"),
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(stage_record.read_text(encoding="utf-8"))[
        "cuda_visible_devices"
    ] == "4"
    assert not nvidia_record.exists()


def test_rejects_an_existing_multi_gpu_assignment(tmp_path: Path) -> None:
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(tmp_path, cuda_visible_devices="2,3")

    result = subprocess.run(
        _stage_command(fake_python, "m2"),
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "exactly one GPU" in result.stderr
    assert not (tmp_path / "stage.json").exists()


def test_rejects_an_explicitly_empty_gpu_assignment(tmp_path: Path) -> None:
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(tmp_path, cuda_visible_devices="")

    result = subprocess.run(
        _stage_command(fake_python, "m2"),
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "exactly one GPU" in result.stderr
    assert not (tmp_path / "stage.json").exists()


def test_rejects_ambiguous_duplicate_stage_options(tmp_path: Path) -> None:
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(tmp_path, cuda_visible_devices="0")

    result = subprocess.run(
        [
            str(SCRIPT),
            "--python",
            str(fake_python),
            "--timeout-seconds",
            "1800",
            "--",
            "--stage",
            "a",
            "--stage",
            "m1",
            "--attempt",
            "0",
        ],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "exactly one --stage" in result.stderr
    assert not (tmp_path / "stage.json").exists()


def test_stage_a_requires_and_uses_the_fixed_timeout(tmp_path: Path) -> None:
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(tmp_path, cuda_visible_devices="0")

    without_timeout = subprocess.run(
        _stage_command(fake_python, "a"),
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    with_timeout = subprocess.run(
        _stage_command(fake_python, "a", timeout=True),
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert without_timeout.returncode == 2
    assert "Stage A requires --timeout-seconds 1800" in without_timeout.stderr
    assert with_timeout.returncode == 0, with_timeout.stderr


def test_auto_selected_stage_a_exits_after_one_execution(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, NVIDIA A, 0, 0\n")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    record = tmp_path / "stage.json"
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        FAKE_STAGE_RECORD=str(record),
    )

    result = subprocess.run(
        _stage_command(fake_python, "a", timeout=True),
        env=environment,
        text=True,
        capture_output=True,
        check=False,
        timeout=2,
    )

    assert result.returncode == 0, result.stderr
    assert record.exists()


def test_gpu_query_failure_is_an_operational_error(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        FAKE_NVIDIA_STATUS="7",
    )

    result = subprocess.run(
        _stage_command(fake_python, "m3"),
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "nvidia-smi failed" in result.stderr
    assert not (tmp_path / "stage.json").exists()


def test_partially_unparseable_gpu_inventory_is_an_operational_error(
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(
        bin_dir / "nvidia-smi",
        "0, NVIDIA A, 0, 0\nmalformed row\n",
    )
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(tmp_path, bin_dir=bin_dir)

    result = subprocess.run(
        _stage_command(fake_python, "m3"),
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "unparseable GPU inventory" in result.stderr
    assert not (tmp_path / "stage.json").exists()


def test_empty_gpu_inventory_is_an_operational_error(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)

    result = subprocess.run(
        _stage_command(fake_python, "m3"),
        env=_runner_environment(tmp_path, bin_dir=bin_dir),
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "no parseable whole GPUs" in result.stderr
    assert not (tmp_path / "stage.json").exists()


def test_waiting_for_the_allocation_lock_stops_on_termination(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    nvidia_record = tmp_path / "nvidia-called"
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, NVIDIA A, 0, 0\n")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    lock_root = tmp_path / "locks"
    lock_root.mkdir()
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        FAKE_NVIDIA_RECORD=str(nvidia_record),
    )

    with (lock_root / "allocation.lock").open("w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        process = subprocess.Popen(
            _stage_command(fake_python, "m2"),
            env=environment,
        )
        time.sleep(0.2)
        assert process.poll() is None
        assert not nvidia_record.exists()
        process.terminate()
        assert process.wait(timeout=2) == 130

    assert not (tmp_path / "stage.json").exists()


def test_one_gpu_lease_serializes_two_stage_processes(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, NVIDIA A, 0, 0\n")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    base_environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        GPU_POLL_INTERVAL_SECONDS="1",
    )
    first_record = tmp_path / "first.json"
    first_environment = base_environment | {
        "FAKE_STAGE_RECORD": str(first_record),
        "FAKE_STAGE_SLEEP": "0.8",
    }
    second_record = tmp_path / "second.json"
    second_environment = base_environment | {"FAKE_STAGE_RECORD": str(second_record)}
    command = _stage_command(fake_python, "m1")

    first = subprocess.Popen(
        command,
        env=first_environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    _wait_for_path(first_record)
    second = subprocess.Popen(
        command,
        env=second_environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    time.sleep(0.2)
    assert not second_record.exists()

    assert first.wait(timeout=3) == 0
    assert second.wait(timeout=4) == 0
    assert second_record.exists()


def test_stage_exit_status_is_propagated_and_the_lock_is_reusable(
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, NVIDIA A, 0, 0\n")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        FAKE_STAGE_RECORD=str(tmp_path / "stage.json"),
        FAKE_STAGE_STATUS="37",
    )
    command = _stage_command(fake_python, "m3")

    failed = subprocess.run(command, env=environment, check=False)
    environment.update(
        FAKE_STAGE_RECORD=str(tmp_path / "second.json"),
        FAKE_STAGE_STATUS="0",
    )
    succeeded = subprocess.run(command, env=environment, check=False)

    assert failed.returncode == 37
    assert succeeded.returncode == 0


def test_gpu_using_2001_mib_is_not_selected_and_waiting_stops_on_termination(
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, ABOVE LIMIT, 2001, 0\n")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        GPU_POLL_INTERVAL_SECONDS="5",
    )
    process = subprocess.Popen(
        _stage_command(fake_python, "m2"),
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stderr is not None
    assert "No idle unlocked GPU" in process.stderr.readline()

    process.terminate()

    assert process.wait(timeout=2) == 130
    assert not (tmp_path / "stage.json").exists()


def test_termination_during_gpu_query_never_starts_the_stage(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    query_started = tmp_path / "query-started"
    _make_fake_nvidia_smi(bin_dir / "nvidia-smi", "0, NVIDIA A, 0, 0\n")
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        FAKE_NVIDIA_RECORD=str(query_started),
        FAKE_NVIDIA_SLEEP="0.5",
    )
    process = subprocess.Popen(
        _stage_command(fake_python, "m2"),
        env=environment,
    )
    _wait_for_path(query_started)

    process.terminate()

    assert process.wait(timeout=2) == 130
    assert not (tmp_path / "stage.json").exists()


def test_two_idle_gpus_allow_two_distinct_stage_leases(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_fake_nvidia_smi(
        bin_dir / "nvidia-smi",
        "0, NVIDIA A, 0, 0\n1, NVIDIA B, 0, 0\n",
    )
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    base_environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        GPU_POLL_INTERVAL_SECONDS="1",
        FAKE_STAGE_SLEEP="0.7",
    )
    command = _stage_command(fake_python, "m3")
    first_record = tmp_path / "first.json"
    first = subprocess.Popen(
        command,
        env=base_environment | {"FAKE_STAGE_RECORD": str(first_record)},
    )
    _wait_for_path(first_record)
    second_record = tmp_path / "second.json"
    second = subprocess.Popen(
        command,
        env=base_environment | {"FAKE_STAGE_RECORD": str(second_record)},
    )
    _wait_for_path(second_record)

    assigned = {
        json.loads(first_record.read_text(encoding="utf-8"))["cuda_visible_devices"],
        json.loads(second_record.read_text(encoding="utf-8"))["cuda_visible_devices"],
    }
    assert assigned == {"0", "1"}
    assert first.wait(timeout=3) == 0
    assert second.wait(timeout=3) == 0


def test_stage_a_propagates_timeout_controller_status(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_timeout = bin_dir / "timeout"
    fake_timeout.write_text(
        f"#!{sys.executable}\n"
        "import os\n"
        "raise SystemExit(int(os.environ['FAKE_TIMEOUT_STATUS']))\n",
        encoding="utf-8",
    )
    fake_timeout.chmod(0o755)
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    command = _stage_command(fake_python, "a", timeout=True)

    for expected_status in (124, 137):
        environment = _runner_environment(
            tmp_path,
            bin_dir=bin_dir,
            cuda_visible_devices="0",
            FAKE_TIMEOUT_STATUS=str(expected_status),
        )
        result = subprocess.run(command, env=environment, check=False)
        assert result.returncode == expected_status


def test_stage_a_termination_reaps_its_timeout_process_group(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_timeout = bin_dir / "timeout"
    ready = tmp_path / "timeout-ready"
    terminated = tmp_path / "timeout-terminated"
    fake_timeout.write_text(
        f"#!{sys.executable}\n"
        "import os\n"
        "import signal\n"
        "import time\n"
        "from pathlib import Path\n"
        "terminated = Path(os.environ['FAKE_TIMEOUT_TERMINATED'])\n"
        "def stop(_signum, _frame):\n"
        "    terminated.write_text('terminated\\n', encoding='utf-8')\n"
        "    raise SystemExit(143)\n"
        "signal.signal(signal.SIGTERM, stop)\n"
        "Path(os.environ['FAKE_TIMEOUT_READY']).write_text('ready\\n', encoding='utf-8')\n"
        "while True:\n"
        "    time.sleep(0.1)\n",
        encoding="utf-8",
    )
    fake_timeout.chmod(0o755)
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    environment = _runner_environment(
        tmp_path,
        bin_dir=bin_dir,
        cuda_visible_devices="0",
        FAKE_TIMEOUT_READY=str(ready),
        FAKE_TIMEOUT_TERMINATED=str(terminated),
    )
    process = subprocess.Popen(
        _stage_command(fake_python, "a", timeout=True),
        env=environment,
    )
    _wait_for_path(ready, timeout=2.0)

    process.terminate()

    assert process.wait(timeout=3) == 130
    assert terminated.read_text(encoding="utf-8") == "terminated\n"


def test_query_library_override_does_not_leak_into_stage(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    compat = tmp_path / "nvml-compat"
    compat.mkdir()
    inherited = str(tmp_path / "inherited-libraries")
    query_record = tmp_path / "query-library-path.txt"
    stage_record = tmp_path / "stage-library-path.txt"
    nvidia = bin_dir / "nvidia-smi"
    nvidia.write_text(
        f"#!{sys.executable}\n"
        "import os\n"
        "from pathlib import Path\n"
        "Path(os.environ['FAKE_QUERY_LIBRARY_RECORD']).write_text(os.environ.get('LD_LIBRARY_PATH', ''))\n"
        "print('0, NVIDIA test, 0, 0')\n",
        encoding="utf-8",
    )
    nvidia.chmod(0o755)
    fake_python = tmp_path / "fake-python"
    _make_fake_python(fake_python)
    anchor = "Path(os.environ['FAKE_STAGE_RECORD']).write_text"
    source = fake_python.read_text(encoding="utf-8")
    assert source.count(anchor) == 1
    fake_python.write_text(
        source.replace(
            anchor,
            "Path(os.environ['FAKE_STAGE_LIBRARY_RECORD']).write_text(os.environ.get('LD_LIBRARY_PATH', ''))\n" + anchor,
        ),
        encoding="utf-8",
    )
    for override, expected in ((str(compat), f"{compat}:{inherited}"), ("", inherited)):
        environment = _runner_environment(
            tmp_path,
            bin_dir=bin_dir,
            GPU_QUERY_LD_LIBRARY_PATH=override,
            LD_LIBRARY_PATH=inherited,
            FAKE_QUERY_LIBRARY_RECORD=str(query_record),
            FAKE_STAGE_LIBRARY_RECORD=str(stage_record),
        )
        result = subprocess.run(
            _stage_command(fake_python, "m1"),
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert query_record.read_text() == expected
        assert stage_record.read_text() == inherited
