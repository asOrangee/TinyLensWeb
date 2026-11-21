import hashlib
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile

from .attempts import validate_decision_review_evidence
from .configuration import validate_run_manifest, validated_run_root


COMMENT_STAGES = ("preflight", "a", "b", "m0", "m1", "m2", "m3")
MAX_STAGE_COMMENT_BYTES = 2_000
MAX_COMMENT_DRAFT_BYTES = 96 * 1024


def _read_stage_comments(source: Path) -> dict[str, str]:
    with source.open("rb") as handle:
        data = handle.read(MAX_COMMENT_DRAFT_BYTES + 1)
    if len(data) > MAX_COMMENT_DRAFT_BYTES:
        raise ValueError("The modeling comment is too large")
    try:
        entries = json.loads(data.decode("utf-8"), object_pairs_hook=tuple)
    except (ValueError, RecursionError) as error:
        raise ValueError("The modeling comment draft must be a UTF-8 JSON object") from error
    if not isinstance(entries, tuple) or len(entries) != len(COMMENT_STAGES):
        raise ValueError("Provide one modeling comment for each stage: " + ", ".join(COMMENT_STAGES))
    comments = dict(entries)
    if set(comments) != set(COMMENT_STAGES):
        raise ValueError("Provide one modeling comment for each stage: " + ", ".join(COMMENT_STAGES))
    for stage, text in comments.items():
        if (not isinstance(text, str) or not text or text != text.strip() or "\x00" in text
                or len(text.splitlines()) != 1 or len(text.encode("utf-8")) > MAX_STAGE_COMMENT_BYTES):
            raise ValueError(f"Stage {stage} needs one nonempty comment line of at most 2000 UTF-8 bytes")
    return {stage: comments[stage] for stage in COMMENT_STAGES}


def record_modeling_comment(output_dir: Path, source: Path) -> tuple[Path, int]:
    run = validated_run_root(output_dir)
    manifest = validate_run_manifest(run)
    source = source.resolve(strict=True)
    if source.is_relative_to(run):
        raise ValueError("Write the comment draft outside the Lens Result Directory")
    comments = _read_stage_comments(source)

    head = json.loads((run / "accepted/m3.json").read_bytes())
    attempt = head.get("accepted_attempt")
    if (type(attempt) is not int or attempt < 0 or head.get("schema_version") != "accepted_stage_head.v1"
            or head.get("stage") != "m3" or head.get("attempt_path") != f"../attempts/m3/{attempt}"):
        raise ValueError("The modeling comment requires an accepted Stage M3")
    folder = run / "attempts" / "m3" / str(attempt)
    decision_bytes = (folder / "decision.json").read_bytes()
    decision = json.loads(decision_bytes)
    result_bytes = (folder / "stage-result.json").read_bytes()
    result = json.loads(result_bytes)
    if ((decision.get("schema_version"), decision.get("stage"), decision.get("attempt"), decision.get("decision"))
            != ("stage_decision.v1", "m3", attempt, "accept")
            or (result.get("stage"), result.get("attempt"), result.get("lens_id"), result.get("status"))
            != ("m3", attempt, run.name, "success") or result.get("eligible_for_review") is not True
            or result.get("gate_failures")):
        raise ValueError("The modeling comment requires a verified M3 result")
    validate_decision_review_evidence(folder, decision)
    if not isinstance(manifest.get("run_id"), str):
        raise ValueError("The modeling comment requires a run ID")

    record = {"schema": "tinylens.modeling-comment.v2", "run_id": manifest["run_id"], "lens_id": run.name,
              "stage": "m3", "attempt": attempt, "result_sha256": hashlib.sha256(result_bytes).hexdigest(),
              "decision_sha256": hashlib.sha256(decision_bytes).hexdigest(), "stage_comments": comments}
    destination = run / "modeling-comment.json"
    data = (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode()
    with NamedTemporaryFile(dir=run, prefix=".modeling-comment-", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(data)
    try:
        try:
            os.link(temporary, destination)
        except FileExistsError:
            if destination.is_symlink() or destination.read_bytes() != data:
                raise ValueError("A different modeling comment is already registered") from None
    finally:
        temporary.unlink()
    return destination, attempt
