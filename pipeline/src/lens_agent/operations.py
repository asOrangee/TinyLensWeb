"""Process exclusion and operational evidence, separate from scientific attempts."""

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path

from .configuration import validated_run_root
from .models import StageName


class StageBusy(ValueError):
    """Another process owns this attempt."""


class PreparationBlocked(ValueError):
    """A correctable prerequisite failed before execution was sealed."""


def control_dir(output_dir: Path) -> Path:
    root = validated_run_root(output_dir)
    control = root / ".operations"
    if control.is_symlink():
        raise ValueError("operation directory must not be a symbolic link")
    control.mkdir(exist_ok=True)
    return control


@contextmanager
def attempt_lock(output_dir: Path, stage: StageName, attempt: int):
    if attempt < 0:
        raise ValueError("attempt must be non-negative")
    try:
        path = control_dir(output_dir) / f"{stage.value}-{attempt}.lock"
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    except (OSError, ValueError) as error:
        raise PreparationBlocked(str(error)) from error
    with os.fdopen(fd, "a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise StageBusy("This stage attempt is being prepared or executed") from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def operation_result(status: str, error: Exception) -> dict:
    return {
        "status": status,
        "error_code": type(error).__name__,
        "reason": str(error),
        "next_action": (
            "Wait for the active process, then check the same attempt."
            if status == "busy" else
            "Correct the reported prerequisite, then invoke the same stage command. "
            "Preserve existing attempt evidence; do not adjudicate a preparation error."
        ),
    }


def record_preparation_error(output_dir: Path, stage: StageName, attempt: int, error: Exception):
    payload = operation_result("preparation_blocked", error)
    payload.update(stage=stage.value, attempt=attempt,
                   timestamp=datetime.now(timezone.utc).isoformat())
    try:
        path = control_dir(output_dir) / f"{stage.value}-{attempt}.jsonl"
        fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a") as handle:
            handle.write(json.dumps(payload) + "\n")
    except (OSError, ValueError):
        # The CLI still reports the original error when evidence cannot be written.
        pass
