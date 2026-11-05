"""Bounded-input scientific review evaluation; never executes production stages."""
from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from threading import Event
import tomllib
from typing import Any

import jsonschema

from ..contracts import validate_reviewer_response
from ..models import StageName
from .system_inspector import REPOSITORY_ROOT, codex_generation_schema, sha256_file

DEFAULT_MANIFEST = REPOSITORY_ROOT / ".codex/evals/stage-review-real-cases.toml"
REFERENCES = ".codex/skills/lens-model-orchestrator/references"
FORBIDDEN = {"review.json", "decision.json", "manifest.json", "stage-execution.json"}
FORBIDDEN_KEYS = {"expected_outcome", "expected_disposition", "decision", "review", "accepted_heads", "accepted_head"}
PROTOCOL_VERSION = "stage_review_only.v1"


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def generation_schema(value: Any) -> Any:
    """Supply explicit const types required by Structured Outputs, without editing contracts."""
    projected = codex_generation_schema(value)

    def visit(item: Any) -> Any:
        if isinstance(item, list):
            return [visit(child) for child in item]
        if not isinstance(item, dict):
            return item
        result = {key: visit(child) for key, child in item.items() if not key.startswith("x-")}
        if "const" in result and "type" not in result:
            constant = result["const"]
            result["type"] = "null" if constant is None else "boolean" if isinstance(constant, bool) else "integer" if isinstance(constant, int) else "number" if isinstance(constant, float) else "string"
        return result

    return visit(projected)


def load_manifest(path: Path) -> dict[str, Any]:
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    if raw.get("schema_version") != "stage_review_golden.v1":
        raise ValueError("unsupported stage review manifest version")
    seen = set()
    for case in raw["cases"]:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", case["id"]) or case["id"] in seen:
            raise ValueError("case IDs must be unique safe directory names")
        seen.add(case["id"])
        if case["stage"] not in {"a", "m1"} or case["expected_outcome"] not in {"continue", "stop"}:
            raise ValueError("unsupported stage or expected outcome")
        case["attempt_dir"] = str(Path(case["attempt_dir"]).resolve())
        if not case.get("evidence"):
            raise ValueError("explicit evidence allowlist is required")
    if not seen:
        raise ValueError("manifest has no cases")
    return raw


def sanitize(value: Any) -> Any:
    """Remove labels and absolute paths without interpreting historical science fields."""
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items() if key not in FORBIDDEN_KEYS}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"(?<![\w])/(?:[^\s\"'<>;,]+)", "[absolute-path-redacted]", value)
    return value


def _source_paths(case: dict[str, Any]) -> list[tuple[str, Path]]:
    root = Path(case["attempt_dir"])
    sources = []
    for item in case["evidence"]:
        relative = Path(item)
        source = (root / relative).resolve()
        if relative.is_absolute() or ".." in relative.parts or not source.is_relative_to(root):
            raise ValueError("current-stage evidence must stay inside its attempt")
        sources.append((relative.as_posix(), source))
    for index, item in enumerate(case.get("upstream_evidence", [])):
        source = Path(item).resolve()
        if source.is_relative_to(root):
            raise ValueError("upstream evidence cannot reference current-stage files")
        sources.append((f"upstream/{index}-{source.name}", source))
    for name, source in sources:
        if source.name in FORBIDDEN or source.suffix not in {".png", ".json"} or any("accepted" in part or "review" == part or "decisions" == part for part in source.parts):
            raise ValueError(f"forbidden evidence file: {name}")
    return sources


def _prompt_file(relative: str, ref: str | None) -> str:
    if ref is None:
        return (REPOSITORY_ROOT / relative).read_text(encoding="utf-8")
    return subprocess.run(["git", "show", f"{ref}:{relative}"], cwd=REPOSITORY_ROOT, text=True, capture_output=True, check=True).stdout


def prepare(manifest: Path, output: Path, variant: str, prompt_ref: str | None = None) -> Path:
    config = load_manifest(manifest)
    output = output.resolve()
    for case in config["cases"]:
        root = Path(case["attempt_dir"])
        lens_root = root.parents[3] if root.parent.parent.name == "attempts" else root
        if output.is_relative_to(lens_root) or lens_root.is_relative_to(output):
            raise ValueError("evaluation output must be separate from original run directories")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", variant):
        raise ValueError("unsafe variant name")
    destination = output / variant
    if destination.exists():
        raise FileExistsError(f"refusing to replace evaluation snapshot: {destination}")
    # Validate all paths before creating any files.
    paths = {case["id"]: _source_paths(case) for case in config["cases"]}
    for case in config["cases"]:
        if "stage-result.json" not in case["evidence"]:
            raise ValueError("stage-result.json is required to verify hard-gate eligibility")
        result = json.loads((Path(case["attempt_dir"]) / "stage-result.json").read_text())
        if result.get("status") != "success" or result.get("eligible_for_review") is not True or result.get("gate_failures"):
            raise ValueError("review evaluation requires a hard-gate-eligible attempt")
    prompts = {}
    for stage in sorted({case["stage"] for case in config["cases"]}):
        agent_text = _prompt_file(f".codex/agents/stage-{stage}-expert.toml", prompt_ref)
        agent = tomllib.loads(agent_text)
        prompts[stage] = {"agent_config": agent_text, "model": agent["model"], "reasoning_effort": agent["model_reasoning_effort"], "developer_instructions": agent["developer_instructions"], "loop": _prompt_file(f"{REFERENCES}/stage-expert-loop.md", prompt_ref), "glossary": _prompt_file(f"{REFERENCES}/stage-review-glossary.md", prompt_ref)}
    metadata = {"manifest": config, "prompt_ref": prompt_ref, "prompts": prompts, "evidence": {}, "protocol_version": PROTOCOL_VERSION, "evaluator_sha256": sha256_file(Path(__file__))}
    for case in config["cases"]:
        records = []
        for relative, source in paths[case["id"]]:
            target = destination / "evidence" / case["id"] / relative
            before = sha256_file(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.suffix == ".json":
                _write(target, sanitize(json.loads(source.read_text(encoding="utf-8"))))
            else:
                shutil.copy2(source, target)
            if sha256_file(source) != before:
                raise ValueError("source changed during preparation")
            records.append({"path": relative, "source": str(source), "source_sha256": before, "sha256": sha256_file(target)})
        metadata["evidence"][case["id"]] = records
    metadata["schema_sha256"] = {}
    for stage in prompts:
        schema = REPOSITORY_ROOT / f".codex/evals/stage-{stage}-expert-output.schema.json"
        _write(destination / f"stage-{stage}.schema.json", json.loads(schema.read_text()))
        metadata["schema_sha256"][stage] = sha256_file(destination / f"stage-{stage}.schema.json")
    metadata["prompt_sha256"] = hashlib.sha256(json.dumps(prompts, sort_keys=True).encode()).hexdigest()
    _write(destination / "snapshot.json", metadata)
    return destination


def verify_evidence(snapshot: Path, metadata: dict[str, Any]) -> None:
    for stage, checksum in metadata["schema_sha256"].items():
        if sha256_file(snapshot / f"stage-{stage}.schema.json") != checksum:
            raise ValueError("schema snapshot checksum changed")
    for case_id, records in metadata["evidence"].items():
        for item in records:
            if sha256_file(snapshot / "evidence" / case_id / item["path"]) != item["sha256"]:
                raise ValueError("isolated evidence checksum changed")
            if sha256_file(Path(item["source"])) != item["source_sha256"]:
                raise ValueError("original evidence checksum changed")
    digest = hashlib.sha256(json.dumps(metadata["prompts"], sort_keys=True).encode()).hexdigest()
    if digest != metadata["prompt_sha256"]:
        raise ValueError("prompt snapshot checksum changed")


def trial_inputs(snapshot: Path, case: dict[str, Any], metadata: dict[str, Any]) -> tuple[str, str, list[Path]]:
    prompt = metadata["prompts"][case["stage"]]
    override = ("REVIEW-ONLY EVALUATION. The following production instructions are supplied as scientific context. "
                "All operational preparation, execution, filesystem inspection, adjudication, retry and promotion instructions are inactive here. "
                "Use only inline evidence and attached images. Do not call any tools or read files. Return the existing strict stage review JSON in English. "
                "Do not ask questions. Evidence can come from an older run: do not invent absent fields or infer failure from historical metadata format.\n")
    developer = prompt["developer_instructions"] + "\n" + prompt["loop"] + "\n" + prompt["glossary"] + "\n" + override
    evidence = {}
    images = []
    for record in metadata["evidence"][case["id"]]:
        path = snapshot / "evidence" / case["id"] / record["path"]
        if path.suffix == ".png":
            images.append(path)
        else:
            evidence[record["path"]] = json.loads(path.read_text())
    user = f"Review stage {case['stage']}. Fixture provenance: {sanitize(case.get('fixture_note', 'Current production evidence.'))}\nAttached PNG order: {json.dumps([str(p.relative_to(snapshot / 'evidence' / case['id'])) for p in images])}.\nEvidence:\n{json.dumps(evidence, sort_keys=True)}"
    return developer, user, images


def score_prediction(case: dict[str, Any], prediction: Any, schema: dict[str, Any], error: str | None = None, *, context: dict[str, Any] | None = None) -> dict[str, Any]:
    outcome = None
    retry = False
    try:
        if error:
            raise ValueError(error)
        jsonschema.Draft202012Validator(schema).validate(prediction)
        review = validate_reviewer_response(prediction, StageName(case["stage"]))
        if context is not None:
            expected = {item["warning_ref"] for item in context.get("unresolved_upstream_warnings", [])}
            received = [item["warning_ref"] for item in review["upstream_warning_updates"]]
            if len(received) != len(set(received)) or set(received) != expected:
                raise ValueError("every unresolved upstream warning must be updated exactly once")
        blockers, repair, uncertainty = review["progression_blockers"], review["retry_repair"], review.get("scientific_uncertainty")
        if uncertainty and (blockers or repair):
            raise ValueError("scientific uncertainty cannot include blockers or repair")
        if not blockers and repair:
            raise ValueError("repair requires a blocker")
        outcome = "stop" if blockers or uncertainty else "continue"
        if outcome == "continue" and review["development_recommendation"] is not None:
            raise ValueError("development recommendation requires human review")
        retry = bool(len(blockers) == 1 and repair)
    except (ValueError, TypeError, KeyError, jsonschema.ValidationError) as exc:
        error = str(exc)
        outcome = None
    return {"case_id": case["id"], "contract_valid": error is None, "error": error, "expected_outcome": case["expected_outcome"], "outcome": outcome, "retry_requested": retry, "exact_match": error is None and outcome == case["expected_outcome"]}


def forbidden_tool_events(stdout: str) -> bool:
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = event.get("item", {})
        if item.get("type") in {"command_execution", "mcp_tool_call", "web_search", "file_change", "tool_call", "collab_tool_call", "image_view", "view_image"} or "tool_call" in str(event.get("type", "")):
            return True
    return False


def run(snapshot: Path, *, trials: int = 3, jobs: int = 1, model: str | None = None, reasoning_effort: str | None = None, codex_bin: str = "codex", timeout: int = 900) -> dict[str, Any]:
    if trials < 1 or jobs < 1:
        raise ValueError("trials and jobs must be positive")
    metadata = json.loads((snapshot / "snapshot.json").read_text())
    verify_evidence(snapshot, metadata)
    if (snapshot / "run.json").exists():
        raise FileExistsError("run already exists; prepare a new variant")
    runtime = {stage: {"model": model or prompt["model"], "reasoning_effort": reasoning_effort or prompt["reasoning_effort"]} for stage, prompt in metadata["prompts"].items()}
    _write(snapshot / "run.json", {"trials": trials, "jobs": jobs, "runtime": runtime, "protocol_version": PROTOCOL_VERSION, "evaluator_sha256": sha256_file(Path(__file__))})
    stop = Event()

    def run_case(case: dict[str, Any]) -> None:
        developer, user, images = trial_inputs(snapshot, case, metadata)
        full_schema = json.loads((snapshot / f"stage-{case['stage']}.schema.json").read_text())
        for trial in range(1, trials + 1):
            if stop.is_set():
                return
            target = snapshot / "trials" / case["id"] / str(trial)
            target.mkdir(parents=True)
            error = None
            with tempfile.TemporaryDirectory(prefix="stage-review-eval-") as tmp:
                isolated = Path(tmp)
                _write(isolated / "schema.json", generation_schema(full_schema))
                command = [codex_bin, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "--model", runtime[case["stage"]]["model"], "-c", f'model_reasoning_effort="{runtime[case["stage"]]["reasoning_effort"]}"', "-c", "features.shell_tool=false", "-c", f"developer_instructions={json.dumps(developer)}", "--cd", tmp, "--output-schema", str(isolated / "schema.json"), "--output-last-message", str(isolated / "prediction.json")]
                for index, source in enumerate(images):
                    copied = isolated / f"image-{index}.png"
                    shutil.copy2(source, copied)
                    command.extend(["--image", str(copied)])
                command.extend(["-c", 'web_search="disabled"', "-c", "features.apps=false", "-c", "features.multi_agent=false"])
                try:
                    completed = subprocess.run(command + ["-"], input=user, capture_output=True, text=True, timeout=timeout, check=False)
                    (target / "stdout.jsonl").write_text(completed.stdout)
                    (target / "stderr.log").write_text(completed.stderr)
                    if completed.returncode:
                        error = f"Codex exited with status {completed.returncode}"
                    if forbidden_tool_events(completed.stdout):
                        error = "review-only isolation violated: child invoked a tool"
                    if (isolated / "prediction.json").exists():
                        shutil.copy2(isolated / "prediction.json", target / "prediction.json")
                except (OSError, subprocess.TimeoutExpired) as exc:
                    error = str(exc)
                if error:
                    _write(target / "error.json", {"error": error})
            verify_evidence(snapshot, metadata)
            if error and ("Codex exited" in error or "No such file" in error):
                # Missing remaining trials are scored as failures; do not repeat a broken backend.
                stop.set()
                return

    cases = iter(metadata["manifest"]["cases"])
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        pending = {executor.submit(run_case, case) for case in [next(cases, None) for _ in range(jobs)] if case is not None}
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                try:
                    future.result()
                except Exception:
                    stop.set()
                    raise
            if not stop.is_set():
                for _ in done:
                    case = next(cases, None)
                    if case is not None:
                        pending.add(executor.submit(run_case, case))
    return score(snapshot)


def score(snapshot: Path) -> dict[str, Any]:
    metadata = json.loads((snapshot / "snapshot.json").read_text())
    verify_evidence(snapshot, metadata)
    run_metadata = json.loads((snapshot / "run.json").read_text())
    results = []
    for case in metadata["manifest"]["cases"]:
        schema = json.loads((snapshot / f"stage-{case['stage']}.schema.json").read_text())
        evidence_root = snapshot / "evidence" / case["id"]
        context_path = evidence_root / "review-context.json"
        context = json.loads(context_path.read_text()) if context_path.exists() else {}
        stage_result = json.loads((evidence_root / "stage-result.json").read_text())
        hard_gate_passed = stage_result.get("status") == "success" and stage_result.get("eligible_for_review") is True and not stage_result.get("gate_failures")
        for trial in range(1, run_metadata["trials"] + 1):
            target = snapshot / "trials" / case["id"] / str(trial)
            prediction, error = None, None
            try:
                prediction = json.loads((target / "prediction.json").read_text())
            except (OSError, ValueError) as exc:
                error = str(exc)
            if (target / "error.json").exists():
                error = json.loads((target / "error.json").read_text())["error"]
            if not hard_gate_passed:
                error = "case failed numerical hard-gate eligibility"
            results.append({"trial": trial, **score_prediction(case, prediction, schema, error, context=context)})
    report = {"prompt_sha256": metadata["prompt_sha256"], "runtime": run_metadata["runtime"], "jobs": run_metadata.get("jobs", 1), "results": results, "all_passed": all(item["exact_match"] for item in results), "scorer_sha256": sha256_file(Path(__file__)), "protocol_version": PROTOCOL_VERSION, "run_evaluator_sha256": run_metadata.get("evaluator_sha256", "not recorded by initial runner")}
    _write(snapshot / "report.json", report)
    (snapshot / "report.md").write_text(markdown_report(report), encoding="utf-8")
    return report


def markdown_report(report: dict[str, Any]) -> str:
    lines = ["# Stage scientific-review evaluation", "", f"All case/trial labels correct: {report['all_passed']}", "", f"Prompt SHA-256: `{report['prompt_sha256']}`", "", "| Case | Trial | Valid | Expected | Observed | Correct |", "|---|---:|---|---|---|---|"]
    for item in report["results"]:
        lines.append(f"| {item['case_id']} | {item['trial']} | {item['contract_valid']} | {item['expected_outcome']} | {item['outcome']} | {item['exact_match']} |")
    lines += ["", "Human scientific reasoning audit remains required. `stop` includes requested retry; no production adjudication was performed.", "", "Errors:"]
    lines += [f"- {item['case_id']} trial {item['trial']}: {item['error']}" for item in report["results"] if item["error"]]
    return "\n".join(lines) + "\n"


def compare(baseline: Path, candidate: Path) -> dict[str, Any]:
    old, new = score(baseline), score(candidate)
    a = json.loads((baseline / "snapshot.json").read_text())
    b = json.loads((candidate / "snapshot.json").read_text())
    if a["evidence"] != b["evidence"] or a["schema_sha256"] != b["schema_sha256"] or a["manifest"]["cases"] != b["manifest"]["cases"] or old["runtime"] != new["runtime"] or len(old["results"]) != len(new["results"]):
        raise ValueError("comparison requires identical evidence, cases, trial count and runtime")
    return {"baseline": old, "candidate": new, "requires_human_reasoning_audit": True}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    prepare_parser.add_argument("--output-dir", type=Path)
    prepare_parser.add_argument("--variant", required=True)
    prepare_parser.add_argument("--prompt-ref")
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--snapshot", type=Path, required=True)
    run_parser.add_argument("--trials", type=int, default=3)
    run_parser.add_argument("--jobs", type=int, default=1)
    run_parser.add_argument("--model")
    run_parser.add_argument("--reasoning-effort")
    run_parser.add_argument("--codex-bin", default="codex")
    run_parser.add_argument("--timeout", type=int, default=900)
    commands.add_parser("score").add_argument("--snapshot", type=Path, required=True)
    compare_parser = commands.add_parser("compare")
    compare_parser.add_argument("--baseline", type=Path, required=True)
    compare_parser.add_argument("--candidate", type=Path, required=True)
    compare_parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args(argv)
    if args.command == "prepare":
        output = args.output_dir or Path(load_manifest(args.manifest)["default_output_root"])
        print(prepare(args.manifest, output, args.variant, args.prompt_ref))
    elif args.command == "run":
        print(json.dumps(run(args.snapshot, trials=args.trials, jobs=args.jobs, model=args.model, reasoning_effort=args.reasoning_effort, codex_bin=args.codex_bin, timeout=args.timeout), indent=2))
    elif args.command == "score":
        print(json.dumps(score(args.snapshot), indent=2))
    else:
        report = compare(args.baseline, args.candidate)
        destination = args.output_dir or args.candidate / "comparison"
        # Constrain writes to the evaluated output hierarchy, away from source runs.
        if not destination.resolve().is_relative_to(args.candidate.resolve().parent):
            raise ValueError("comparison output must stay under the evaluation output root")
        _write(destination / "comparison.json", report)
        (destination / "comparison.md").write_text("# Baseline\n\n" + markdown_report(report["baseline"]) + "\n# Candidate\n\n" + markdown_report(report["candidate"]), encoding="utf-8")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
