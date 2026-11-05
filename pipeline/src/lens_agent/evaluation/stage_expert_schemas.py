from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
from typing import Any

from ..review_vocabulary import BLOCKERS_BY_STAGE, WARNINGS_BY_STAGE


DEFAULT_EVAL_DIR = Path(__file__).resolve().parents[3] / ".codex" / "evals"


def render_review_vocabulary(
    schema: dict[str, Any], stage: str
) -> dict[str, Any]:
    """Return one expert schema with its closed vocabulary set from Python policy."""
    if stage not in BLOCKERS_BY_STAGE:
        raise ValueError(f"stage {stage} has no reviewed-stage vocabulary")
    rendered = deepcopy(schema)
    rendered["$defs"]["blocker_kind"]["enum"] = list(BLOCKERS_BY_STAGE[stage])
    rendered["properties"]["handoff_warnings"]["items"]["properties"]["kind"][
        "enum"
    ] = list(WARNINGS_BY_STAGE[stage])
    return rendered


def _schema_path(eval_dir: Path, stage: str) -> Path:
    return eval_dir / f"stage-{stage}-expert-output.schema.json"


def schemas_with_vocabulary_drift(eval_dir: Path) -> list[Path]:
    stale: list[Path] = []
    for stage in BLOCKERS_BY_STAGE:
        path = _schema_path(eval_dir, stage)
        schema = json.loads(path.read_text(encoding="utf-8"))
        if schema != render_review_vocabulary(schema, stage):
            stale.append(path)
    return stale


def synchronize_review_vocabularies(eval_dir: Path) -> list[Path]:
    changed: list[Path] = []
    for stage in BLOCKERS_BY_STAGE:
        path = _schema_path(eval_dir, stage)
        schema = json.loads(path.read_text(encoding="utf-8"))
        rendered = render_review_vocabulary(schema, stage)
        if rendered == schema:
            continue
        path.write_text(json.dumps(rendered, indent=2) + "\n", encoding="utf-8")
        changed.append(path)
    return changed


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Synchronize Stage Expert JSON schemas with Python review vocabulary."
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true")
    action.add_argument("--write", action="store_true")
    parser.add_argument("--eval-dir", type=Path, default=DEFAULT_EVAL_DIR)
    args = parser.parse_args(argv)

    if args.check:
        stale = schemas_with_vocabulary_drift(args.eval_dir)
        if stale:
            names = ", ".join(path.name for path in stale)
            raise SystemExit(f"Stage Expert schemas have stale vocabularies: {names}")
        return
    for path in synchronize_review_vocabularies(args.eval_dir):
        print(path)


if __name__ == "__main__":
    main()
