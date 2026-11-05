from __future__ import annotations

import json
import os
from collections import Counter
from pathlib import Path
from typing import Any, Sequence

from .configuration import validated_run_root
from .inspector_decision import validate_inspector_decision


VOTE_COUNT = 3


def _read_decision(path: Path, *, expected_lens_id: str) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid inspector response {path}: {exc}") from exc
    try:
        return validate_inspector_decision(raw, expected_lens_id=expected_lens_id)
    except ValueError as exc:
        raise ValueError(f"invalid inspector response {path}: {exc}") from exc


def _write_json_atomic(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def record_inspector_votes(output_dir: Path, responses: Sequence[Path]) -> tuple[Path, ...]:
    """Validate exactly three responses before retaining any System Inspector Vote."""

    output_dir = validated_run_root(output_dir)
    if len(responses) != VOTE_COUNT:
        raise ValueError(f"preflight requires exactly {VOTE_COUNT} System Inspector votes")
    votes = [
        _read_decision(response.resolve(), expected_lens_id=output_dir.name)
        for response in responses
    ]
    vote_dir = output_dir / "preflight" / "inspector-votes"
    vote_dir.mkdir(parents=True, exist_ok=True)
    targets = tuple(vote_dir / f"{index}.json" for index in range(VOTE_COUNT))
    for target, vote in zip(targets, votes, strict=True):
        _write_json_atomic(target, vote)
    return targets


def _load_recorded_votes(output_dir: Path) -> list[dict[str, Any]]:
    vote_dir = output_dir / "preflight" / "inspector-votes"
    return [
        _read_decision(vote_dir / f"{index}.json", expected_lens_id=output_dir.name)
        for index in range(VOTE_COUNT)
    ]


def record_preflight_synthesis(output_dir: Path, response: Path) -> Path:
    """Validate an expert-authored synthesis without calculating or repairing it."""

    output_dir = validated_run_root(output_dir)
    votes = _load_recorded_votes(output_dir)
    synthesis = _read_decision(response.resolve(), expected_lens_id=output_dir.name)

    disposition_counts = Counter(vote["disposition"] for vote in votes)
    expected_disposition = disposition_counts.most_common(1)[0][0]
    if synthesis["disposition"] != expected_disposition:
        raise ValueError(
            "synthesis disposition does not match the two-of-three inspector majority"
        )

    id_counts = Counter(
        segment_id for vote in votes for segment_id in vote["contaminant_ids"]
    )
    expected_ids = sorted(
        segment_id for segment_id, count in id_counts.items() if count >= 2
    )
    if synthesis["contaminant_ids"] != expected_ids:
        raise ValueError(
            "synthesis contaminant_ids do not match per-ID two-of-three majorities"
        )

    if expected_disposition == "human_review":
        if synthesis["theta_E_hint"] is not None:
            raise ValueError("human_review synthesis requires theta_E_hint to be null")
    else:
        eligible_hints = [
            vote["theta_E_hint"]
            for vote in votes
            if vote["disposition"] == "model"
        ]
        if synthesis["theta_E_hint"] not in eligible_hints:
            raise ValueError(
                "model synthesis theta_E_hint must exactly match one majority model vote"
            )

    target = output_dir / "preflight" / "synthesis.json"
    _write_json_atomic(target, synthesis)
    return target
