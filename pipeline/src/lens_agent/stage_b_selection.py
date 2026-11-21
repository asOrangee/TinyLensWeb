"""Register the Stage B expert's selection and an explicit Stage B-only restart."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits

from .configuration import ARC_SNR_THRESHOLD_MAX, ARC_SNR_THRESHOLD_MIN, validated_run_root
from .models import STAGE_DEPENDENCY_ORDER, StageName
from .operations import attempt_lock
from .workbench_display import _json, file_sha256


SELECTION_FILE = "stage-b-selection.json"
SCHEMA = "stage_b_candidate_selection.v1"


def _record_path(output_dir: Path, attempt: int) -> Path:
    return output_dir / "stage-b-candidates" / str(attempt) / "selection.json"


def _read_record(path: Path) -> dict[str, Any]:
    if path.resolve(strict=True) != path or not path.is_file():
        raise ValueError("Stage B selection must be a canonical file")
    record = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict):
        raise ValueError("Stage B selection must be an object")
    return record


def _restart_evidence(output_dir: Path, attempt: int) -> dict[str, str]:
    from .attempts import validate_decision_review_evidence

    parent = output_dir / "attempts" / "b" / str(attempt - 1)
    path = parent / "decision.json"
    decision = _read_record(path)
    if (decision.get("schema_version"), decision.get("stage"), decision.get("attempt"), decision.get("decision")) != (
        "stage_decision.v1", "b", attempt - 1, "human_review",
    ):
        raise ValueError("A Stage B-only restart requires the current terminal B Human Review")
    validate_decision_review_evidence(parent, decision)
    return {"path": path.relative_to(output_dir).as_posix(), "sha256": file_sha256(path)}


def stage_b_candidate_attempt(output_dir: Path, *, restart: bool) -> int:
    output_dir = validated_run_root(output_dir)
    protected = STAGE_DEPENDENCY_ORDER[STAGE_DEPENDENCY_ORDER.index(StageName.B):]
    for stage in protected:
        head = output_dir / "accepted" / f"{stage.value}.json"
        if head.exists() or head.is_symlink():
            raise ValueError("Stage B candidate selection requires no accepted B or downstream result")
        if stage == StageName.B:
            continue
        stage_root = output_dir / "attempts" / stage.value
        if stage_root.is_symlink() or (stage_root.exists() and (not stage_root.is_dir() or any(stage_root.iterdir()))):
            raise ValueError("Stage B-only restart cannot change the input to a downstream attempt")
    root = output_dir / "attempts" / "b"
    if root.resolve() != root:
        raise ValueError("Stage B attempts must belong to this Lens Run")
    attempts = sorted(int(item.name) for item in root.iterdir() if item.name.isdecimal()) if root.is_dir() else []
    if not attempts and not restart:
        return 0
    if not restart or not attempts:
        raise ValueError("Prescan requires a fresh Stage B or an explicit restart of its terminal Human Review")
    attempt = attempts[-1] + 1
    _restart_evidence(output_dir, attempt)
    return attempt


def _payload(output_dir: Path, attempt: int, threshold: int, reason: str) -> dict[str, Any]:
    from .stage_b_candidates import validate_stage_b_candidate

    if (
        type(threshold) is not int
        or not ARC_SNR_THRESHOLD_MIN <= threshold <= ARC_SNR_THRESHOLD_MAX
        or not isinstance(reason, str)
        or not 1 <= len(reason.strip()) <= 4000
    ):
        raise ValueError(
            f"Select one integer S/N threshold from {ARC_SNR_THRESHOLD_MIN} to "
            f"{ARC_SNR_THRESHOLD_MAX} and provide its scientific rationale"
        )
    candidate = validate_stage_b_candidate(output_dir, attempt, threshold)
    payload = {
        "schema_version": SCHEMA,
        "stage": "b",
        "attempt": attempt,
        "threshold": threshold,
        "reason": reason.strip(),
        "prescan_sha256": candidate["manifest_sha256"],
        "mask_sha256": candidate["mask_sha256"],
        "comparison_sha256": candidate["comparison_sha256"],
        "arc_ignor_size": candidate["arc_ignor_size"],
        "arc_ext_size": candidate["arc_ext_size"],
        "arc_close_size": candidate["arc_close_size"],
    }
    if attempt > 0:
        payload["restart_of"] = _restart_evidence(output_dir, attempt)
    return payload


def select_stage_b_candidate(output_dir: Path, attempt: int, threshold: int, reason: str, *, restart: bool) -> Path:
    output_dir = validated_run_root(output_dir)
    with attempt_lock(output_dir, StageName.B, attempt):
        if stage_b_candidate_attempt(output_dir, restart=restart) != attempt:
            raise ValueError("The chosen Stage B attempt is not the next eligible attempt")
        payload = _payload(output_dir, attempt, threshold, reason)
        path = _record_path(output_dir, attempt)
        _json(path, payload)
        return path


def load_stage_b_selection(output_dir: Path, attempt: int) -> dict[str, Any] | None:
    path = _record_path(output_dir, attempt)
    if not path.exists() and not path.is_symlink():
        return None
    record = _read_record(path)
    if record != _payload(output_dir, attempt, record.get("threshold"), record.get("reason")):
        raise ValueError("Stage B selection no longer matches its prescan or restart evidence")
    return record


def is_superseded_stage_b_review(output_dir: Path, decision_path: Path) -> bool:
    parent = decision_path.parent
    if parent.parent != output_dir / "attempts" / "b" or not parent.name.isdecimal():
        return False
    attempt = int(parent.name) + 1
    path = _record_path(output_dir, attempt)
    if not path.exists() and not path.is_symlink():
        return False
    record = _read_record(path)
    return (record.get("schema_version"), record.get("stage"), record.get("attempt"), record.get("restart_of")) == (
        SCHEMA, "b", attempt, _restart_evidence(output_dir, attempt),
    )


def attach_stage_b_prescan(output_dir: Path, attempt: int, attempt_root: Path) -> dict[str, str]:
    """Bind the executed mask and its comparison figure to the reviewed attempt."""
    from .stage_b_candidates import validate_stage_b_candidate

    record = _read_record(attempt_root / SELECTION_FILE)
    candidate = validate_stage_b_candidate(output_dir, attempt, record["threshold"])
    if (record["prescan_sha256"], record["mask_sha256"], record["comparison_sha256"]) != (
        candidate["manifest_sha256"], candidate["mask_sha256"], candidate["comparison_sha256"],
    ):
        raise ValueError("Stage B execution no longer matches its selected prescan")
    if not np.array_equal(fits.getdata(candidate["mask_path"]), fits.getdata(attempt_root / "artifacts" / "feature_mask.fits")):
        raise ValueError("Stage B execution produced different pixels from the chosen candidate")
    comparison = Path(candidate["comparison_path"]).read_bytes()
    if hashlib.sha256(comparison).hexdigest() != record["comparison_sha256"]:
        raise ValueError("Stage B comparison image changed during execution")
    relative = "diagnostics/stage_b_prescan.png"
    with (attempt_root / relative).open("xb") as handle:
        handle.write(comparison)
    return {"stage_b_candidate_selection": SELECTION_FILE, "stage_b_prescan_png": relative}
