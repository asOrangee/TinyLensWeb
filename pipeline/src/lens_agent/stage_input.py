"""Read-only checks binding stage input to the preflight input directory."""

from __future__ import annotations

import json
from pathlib import Path

from .configuration import run_input_geometry


class StageInputError(ValueError):
    """An input error that must not start or seal a stage attempt."""


def check_stage_input(lens_dir: Path, output_dir: Path) -> None:
    record = output_dir.resolve() / "preflight" / "inspection.json"
    try:
        packet = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise StageInputError(
            f"Cannot read preflight input directory from {record}: {error}. "
            "Provide a valid preflight record before running a stage."
        ) from error
    expected = packet.get("lens_dir") if isinstance(packet, dict) else None
    if not isinstance(expected, str) or not expected.strip() or not Path(expected).is_absolute():
        raise StageInputError(
            f"Invalid preflight lens_dir in {record}: expected a non-empty absolute path."
        )
    try:
        actual_path = lens_dir.resolve()
        expected_path = Path(expected).resolve()
    except (OSError, ValueError, RuntimeError) as error:
        raise StageInputError(
            f"Cannot resolve stage input directory: actual={lens_dir}, "
            f"expected={expected}, preflight={record}: {error}"
        ) from error
    if actual_path != expected_path:
        raise StageInputError(
            f"Stage input directory mismatch: actual={lens_dir} "
            f"(resolved={actual_path}); expected={expected} "
            f"(resolved={expected_path}); preflight={record}. "
            "Correct --lens-dir to match the preflight input directory."
        )

    try:
        run_input_geometry(output_dir)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise StageInputError(f"Input geometry is inconsistent: {error}") from error
