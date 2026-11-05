"""Isolated, repeatable LLM regression evaluation for the System Inspector."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Sequence

from ..inspector_decision import validate_inspector_decision


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MANIFEST = REPOSITORY_ROOT / ".codex" / "evals" / "system-inspector-golden.toml"
VALID_DISPOSITIONS = {"model", "human_review"}
CODEX_UNSUPPORTED_SCHEMA_KEYWORDS = {"allOf", "uniqueItems"}


@dataclass(frozen=True)
class GoldenCase:
    lens_id: str
    source_image: Path
    image: Path
    image_sha256: str
    expected_disposition: str
    expected_contaminant_ids: tuple[int, ...]
    focus: tuple[str, ...]


@dataclass(frozen=True)
class EvaluationConfig:
    manifest_path: Path
    agent_config: Path
    output_schema: Path
    default_output_root: Path
    cases: tuple[GoldenCase, ...]


@dataclass(frozen=True)
class InspectorAgentConfig:
    model: str
    model_reasoning_effort: str
    developer_instructions: str
    sha256: str


def _resolve(base: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (base / path).resolve()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _nonempty_string(value: object, *, field: str, source: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{source} {field} must be a non-empty string")
    return value.strip()


def load_config(manifest_path: Path = DEFAULT_MANIFEST) -> EvaluationConfig:
    manifest_path = manifest_path.resolve()
    raw = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    legacy_runtime_fields = {"model", "model_reasoning_effort"} & raw.keys()
    if legacy_runtime_fields:
        fields = ", ".join(sorted(legacy_runtime_fields))
        raise ValueError(
            f"golden manifest runtime fields are not allowed: {fields}; "
            "configure agent defaults in agent_config or use a CLI override"
        )
    if raw.get("schema_version") != "system_inspector_golden.v4":
        raise ValueError(
            "unsupported golden manifest schema; migrate to system_inspector_golden.v4"
        )

    base = manifest_path.parent
    agent_config_value = _nonempty_string(
        raw.get("agent_config"), field="agent_config", source="golden manifest"
    )
    output_schema_value = _nonempty_string(
        raw.get("output_schema"), field="output_schema", source="golden manifest"
    )
    output_root_value = _nonempty_string(
        raw.get("default_output_root"),
        field="default_output_root",
        source="golden manifest",
    )
    cases: list[GoldenCase] = []
    seen_lens_ids: set[str] = set()
    raw_cases = raw.get("cases")
    if not isinstance(raw_cases, list):
        raise ValueError("golden manifest cases must be an array")
    for index, item in enumerate(raw_cases):
        if not isinstance(item, dict):
            raise ValueError(f"golden manifest case {index} must be a table")
        lens_id = _nonempty_string(
            item.get("lens_id"), field="lens_id", source=f"golden case {index}"
        )
        raw_expected_ids = item.get("expected_contaminant_ids")
        if not isinstance(raw_expected_ids, list) or any(
            not isinstance(value, int) or isinstance(value, bool)
            for value in raw_expected_ids
        ):
            raise ValueError(
                f"golden case {lens_id} expected_contaminant_ids must be an integer array"
            )
        expected_ids = tuple(raw_expected_ids)
        if lens_id in seen_lens_ids:
            raise ValueError(f"duplicate golden lens_id: {lens_id}")
        if expected_ids != tuple(sorted(set(expected_ids))):
            raise ValueError(f"contaminant IDs must be sorted and unique for {lens_id}")
        expected_disposition = _nonempty_string(
            item.get("expected_disposition"),
            field="expected_disposition",
            source=f"golden case {lens_id}",
        )
        if expected_disposition not in VALID_DISPOSITIONS:
            raise ValueError(f"invalid disposition for {lens_id}")
        raw_focus = item.get("focus")
        if not isinstance(raw_focus, list) or any(
            not isinstance(value, str) or not value.strip() for value in raw_focus
        ):
            raise ValueError(f"golden case {lens_id} focus must be a string array")
        seen_lens_ids.add(lens_id)
        cases.append(
            GoldenCase(
                lens_id=lens_id,
                source_image=_resolve(
                    base,
                    _nonempty_string(
                        item.get("source_image"),
                        field="source_image",
                        source=f"golden case {lens_id}",
                    ),
                ),
                image=_resolve(
                    base,
                    _nonempty_string(
                        item.get("image"),
                        field="image",
                        source=f"golden case {lens_id}",
                    ),
                ),
                image_sha256=_nonempty_string(
                    item.get("image_sha256"),
                    field="image_sha256",
                    source=f"golden case {lens_id}",
                ),
                expected_disposition=expected_disposition,
                expected_contaminant_ids=expected_ids,
                focus=tuple(value.strip() for value in raw_focus),
            )
        )
    if not cases:
        raise ValueError("golden manifest contains no cases")

    return EvaluationConfig(
        manifest_path=manifest_path,
        agent_config=_resolve(base, agent_config_value),
        output_schema=_resolve(base, output_schema_value),
        default_output_root=_resolve(base, output_root_value),
        cases=tuple(cases),
    )


def prepare_fixtures(config: EvaluationConfig, *, force: bool = False) -> list[dict[str, str]]:
    prepared: list[dict[str, str]] = []
    for case in config.cases:
        destination = case.image
        if destination.is_file() and sha256_file(destination) == case.image_sha256:
            prepared.append({"lens_id": case.lens_id, "status": "verified", "image": str(destination)})
            continue
        if destination.exists() and not force:
            raise ValueError(f"fixture exists with the wrong checksum: {destination}")
        if not case.source_image.is_file():
            raise FileNotFoundError(f"missing source image for {case.lens_id}: {case.source_image}")
        source_hash = sha256_file(case.source_image)
        if source_hash != case.image_sha256:
            raise ValueError(
                f"source image checksum changed for {case.lens_id}: "
                f"expected {case.image_sha256}, found {source_hash}"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(case.source_image, destination)
        if sha256_file(destination) != case.image_sha256:
            raise OSError(f"copied fixture failed checksum verification: {destination}")
        prepared.append({"lens_id": case.lens_id, "status": "copied", "image": str(destination)})
    return prepared


def load_inspector_agent(config: EvaluationConfig) -> InspectorAgentConfig:
    agent = tomllib.loads(config.agent_config.read_text(encoding="utf-8"))
    name = _nonempty_string(
        agent.get("name"), field="name", source="System Inspector agent config"
    )
    if name != "system_inspector":
        raise ValueError("System Inspector agent config name must be system_inspector")
    return InspectorAgentConfig(
        model=_nonempty_string(
            agent.get("model"), field="model", source="System Inspector agent config"
        ),
        model_reasoning_effort=_nonempty_string(
            agent.get("model_reasoning_effort"),
            field="model_reasoning_effort",
            source="System Inspector agent config",
        ),
        developer_instructions=_nonempty_string(
            agent.get("developer_instructions"),
            field="developer_instructions",
            source="System Inspector agent config",
        ),
        sha256=sha256_file(config.agent_config),
    )


def evaluation_user_prompt(lens_id: str) -> str:
    return (
        f"Evaluation invocation for lens_id `{lens_id}`:\n"
        f"- Copy the exact lens_id `{lens_id}` into the JSON response.\n"
        "- Review only the attached two-panel PNG.\n"
        "- Do not inspect the filesystem, invoke tools, or seek external context.\n"
        "- Do not ask questions. Return the required strict JSON object as the final response."
    )


def codex_generation_schema(value: Any) -> Any:
    """Project the full decision schema onto Codex Structured Outputs' subset.

    The removed constraints remain enforced by ``validate_inspector_decision``
    after generation, so this projection changes neither the persisted contract
    nor evaluation scoring.
    """
    if isinstance(value, dict):
        projected: dict[str, Any] = {}
        for key, item in value.items():
            if key in CODEX_UNSUPPORTED_SCHEMA_KEYWORDS:
                continue
            projected["anyOf" if key == "oneOf" else key] = codex_generation_schema(item)
        return projected
    if isinstance(value, list):
        return [codex_generation_schema(item) for item in value]
    return value


def validate_prediction(prediction: Any, case: GoldenCase) -> dict[str, Any]:
    if not isinstance(prediction, dict):
        raise ValueError("prediction must be a JSON object")
    return validate_inspector_decision(prediction, expected_lens_id=case.lens_id)


def score_prediction(
    case: GoldenCase,
    prediction: dict[str, Any] | None,
    *,
    error: str | None = None,
    trial: int = 1,
) -> dict[str, Any]:
    contract_valid = False
    contract_error = error
    validated: dict[str, Any] | None = None
    if prediction is not None and contract_error is None:
        try:
            validated = validate_prediction(prediction, case)
            contract_valid = True
        except ValueError as exc:
            contract_error = str(exc)

    predicted_ids = set(validated["contaminant_ids"]) if validated is not None else set()
    expected_ids = set(case.expected_contaminant_ids)
    true_positives = sorted(expected_ids & predicted_ids)
    false_positives = sorted(predicted_ids - expected_ids)
    false_negatives = sorted(expected_ids - predicted_ids)
    predicted_disposition = validated["disposition"] if validated is not None else None
    disposition_correct = predicted_disposition == case.expected_disposition
    ids_exact = not false_positives and not false_negatives

    return {
        "lens_id": case.lens_id,
        "trial": trial,
        "contract_valid": contract_valid,
        "contract_error": contract_error,
        "expected_disposition": case.expected_disposition,
        "predicted_disposition": predicted_disposition,
        "disposition_correct": disposition_correct,
        "expected_contaminant_ids": list(case.expected_contaminant_ids),
        "predicted_contaminant_ids": sorted(predicted_ids),
        "true_positives": true_positives,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
        "ids_exact": ids_exact,
        "exact_match": contract_valid and disposition_correct and ids_exact,
    }


def _safe_ratio(numerator: int, denominator: int, *, empty: float) -> float:
    return numerator / denominator if denominator else empty


def aggregate_results(results: Sequence[dict[str, Any]]) -> dict[str, Any]:
    if not results:
        raise ValueError("cannot aggregate an empty result set")
    total = len(results)
    tp = sum(len(result["true_positives"]) for result in results)
    fp = sum(len(result["false_positives"]) for result in results)
    fn = sum(len(result["false_negatives"]) for result in results)
    precision = _safe_ratio(tp, tp + fp, empty=1.0 if fn == 0 else 0.0)
    recall = _safe_ratio(tp, tp + fn, empty=1.0)
    f1 = _safe_ratio(2 * precision * recall, precision + recall, empty=0.0)

    signatures: dict[str, set[tuple[Any, ...]]] = {}
    validity: dict[str, list[bool]] = {}
    for result in results:
        signature = (
            result["contract_valid"],
            result["predicted_disposition"],
            tuple(result["predicted_contaminant_ids"]),
        )
        signatures.setdefault(result["lens_id"], set()).add(signature)
        validity.setdefault(result["lens_id"], []).append(result["contract_valid"])

    return {
        "trials": total,
        "contract_compliance": _safe_ratio(
            sum(result["contract_valid"] for result in results), total, empty=0.0
        ),
        "disposition_accuracy": _safe_ratio(
            sum(result["disposition_correct"] for result in results), total, empty=0.0
        ),
        "exact_match_rate": _safe_ratio(
            sum(result["exact_match"] for result in results), total, empty=0.0
        ),
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "micro_precision": precision,
        "micro_recall": recall,
        "micro_f1": f1,
        "overmask_rate": _safe_ratio(fp, tp + fp, empty=0.0),
        "miss_rate": _safe_ratio(fn, tp + fn, empty=0.0),
        "stable_case_rate": _safe_ratio(
            sum(
                len(values) == 1 and all(validity[lens_id])
                for lens_id, values in signatures.items()
            ),
            len(signatures),
            empty=0.0,
        ),
        "unique_predictions_per_case": {
            lens_id: len(values) for lens_id, values in sorted(signatures.items())
        },
    }


def aggregate_by_case(results: Sequence[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for result in results:
        grouped.setdefault(result["lens_id"], []).append(result)

    summaries: dict[str, dict[str, Any]] = {}
    for lens_id, case_results in sorted(grouped.items()):
        trial_count = len(case_results)
        missed_counts: dict[str, int] = {}
        overmasked_counts: dict[str, int] = {}
        for result in case_results:
            for segment_id in result["false_negatives"]:
                key = str(segment_id)
                missed_counts[key] = missed_counts.get(key, 0) + 1
            for segment_id in result["false_positives"]:
                key = str(segment_id)
                overmasked_counts[key] = overmasked_counts.get(key, 0) + 1
        summaries[lens_id] = {
            "trials": trial_count,
            "contract_compliance": _safe_ratio(
                sum(result["contract_valid"] for result in case_results),
                trial_count,
                empty=0.0,
            ),
            "exact_match_rate": _safe_ratio(
                sum(result["exact_match"] for result in case_results),
                trial_count,
                empty=0.0,
            ),
            "missed_id_counts": missed_counts,
            "overmasked_id_counts": overmasked_counts,
        }
    return summaries


def _markdown_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    context = report.get("evaluation_context") or {}
    lines = [
        "# System Inspector regression report",
        "",
        f"- Run: `{report['run_id']}`",
        f"- Model: `{context.get('model', 'unknown')}`",
        f"- Reasoning effort: `{context.get('model_reasoning_effort', 'unknown')}`",
        f"- Prompt SHA-256: `{report.get('prompt_sha256', 'unknown')}`",
        f"- Trials: {summary['trials']}",
        f"- Contract compliance: {summary['contract_compliance']:.3f}",
        f"- Disposition accuracy: {summary['disposition_accuracy']:.3f}",
        f"- Exact-match rate: {summary['exact_match_rate']:.3f}",
        f"- Micro precision / recall / F1: {summary['micro_precision']:.3f} / "
        f"{summary['micro_recall']:.3f} / {summary['micro_f1']:.3f}",
        f"- Miss rate / overmask rate: {summary['miss_rate']:.3f} / "
        f"{summary['overmask_rate']:.3f}",
        f"- Stable-case rate: {summary['stable_case_rate']:.3f}",
        "",
        "| Lens | Trial | Contract | Disposition | Expected IDs | Predicted IDs | "
        "Missed | Over-masked | Exact |",
        "|---|---:|---|---|---|---|---|---|---|",
    ]
    for result in report["results"]:
        lines.append(
            f"| {result['lens_id']} | {result['trial']} | "
            f"{'yes' if result['contract_valid'] else 'no'} | "
            f"{result['predicted_disposition'] or 'invalid'} | "
            f"{result['expected_contaminant_ids']} | {result['predicted_contaminant_ids']} | "
            f"{result['false_negatives']} | {result['false_positives']} | "
            f"{'yes' if result['exact_match'] else 'no'} |"
        )
    return "\n".join(lines) + "\n"


def write_report(
    run_dir: Path,
    results: Sequence[dict[str, Any]],
    *,
    run_id: str,
    prompt_sha256: str | None,
    evaluation_context: dict[str, Any] | None,
) -> dict[str, Any]:
    report = {
        "schema_version": "system_inspector_report.v2",
        "run_id": run_id,
        "prompt_sha256": prompt_sha256,
        "evaluation_context": evaluation_context,
        "summary": aggregate_results(results),
        "case_summary": aggregate_by_case(results),
        "results": list(results),
    }
    (run_dir / "report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (run_dir / "report.md").write_text(_markdown_report(report), encoding="utf-8")
    return report


def _read_prediction(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    if not path.is_file():
        return None, f"missing prediction file: {path}"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"invalid prediction JSON: {exc}"
    return value, None


def _selected_cases(config: EvaluationConfig, lens_ids: Sequence[str]) -> tuple[GoldenCase, ...]:
    if not lens_ids:
        return config.cases
    requested = set(lens_ids)
    selected = tuple(case for case in config.cases if case.lens_id in requested)
    missing = requested - {case.lens_id for case in selected}
    if missing:
        raise ValueError(f"unknown golden lens IDs: {sorted(missing)}")
    return selected


def run_codex_trial(
    *,
    case: GoldenCase,
    developer_instructions: str,
    user_prompt: str,
    output_schema: Path,
    trial_dir: Path,
    codex_bin: str,
    model: str,
    reasoning_effort: str,
    timeout_seconds: int,
) -> tuple[dict[str, Any] | None, str | None]:
    trial_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="system-inspector-eval-") as temporary:
        isolated = Path(temporary)
        isolated_image = isolated / "preflight_2panel.png"
        isolated_schema = isolated / "output.schema.json"
        isolated_prediction = isolated / "prediction.json"
        shutil.copy2(case.image, isolated_image)
        full_schema = json.loads(output_schema.read_text(encoding="utf-8"))
        isolated_schema.write_text(
            json.dumps(codex_generation_schema(full_schema), indent=2) + "\n",
            encoding="utf-8",
        )

        command = [
            codex_bin,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--color",
            "never",
            "--sandbox",
            "read-only",
            "--model",
            model,
            "-c",
            f'model_reasoning_effort="{reasoning_effort}"',
            "-c",
            f"developer_instructions={json.dumps(developer_instructions)}",
            "--cd",
            str(isolated),
            "--image",
            str(isolated_image),
            "--output-schema",
            str(isolated_schema),
            "--output-last-message",
            str(isolated_prediction),
            "-",
        ]
        try:
            completed = subprocess.run(
                command,
                input=user_prompt,
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            error = f"Codex invocation failed: {exc}"
            (trial_dir / "error.txt").write_text(error + "\n", encoding="utf-8")
            return None, error

        (trial_dir / "stdout.log").write_text(completed.stdout, encoding="utf-8")
        (trial_dir / "stderr.log").write_text(completed.stderr, encoding="utf-8")
        if completed.returncode != 0:
            error = f"Codex exited with status {completed.returncode}"
            (trial_dir / "error.txt").write_text(error + "\n", encoding="utf-8")
            return None, error
        prediction, error = _read_prediction(isolated_prediction)
        if prediction is not None:
            (trial_dir / "prediction.json").write_text(
                json.dumps(prediction, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
        return prediction, error


def score_run(config: EvaluationConfig, run_dir: Path) -> dict[str, Any]:
    metadata_path = run_dir / "run_metadata.json"
    metadata = (
        json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata_path.is_file()
        else {}
    )
    case_lookup = {case.lens_id: case for case in config.cases}
    results: list[dict[str, Any]] = []
    cases_root = run_dir / "cases"
    for lens_dir in sorted(path for path in cases_root.iterdir() if path.is_dir()):
        case = case_lookup.get(lens_dir.name)
        if case is None:
            raise ValueError(f"run contains unknown case: {lens_dir.name}")
        trial_dirs = sorted(path for path in lens_dir.iterdir() if path.is_dir())
        for index, trial_dir in enumerate(trial_dirs, start=1):
            prediction, error = _read_prediction(trial_dir / "prediction.json")
            error_path = trial_dir / "error.txt"
            if prediction is None and error_path.is_file():
                error = error_path.read_text(encoding="utf-8").strip()
            results.append(
                score_prediction(case, prediction, error=error, trial=index)
            )
    if not results:
        raise ValueError(f"run contains no prediction trials: {run_dir}")
    return write_report(
        run_dir,
        results,
        run_id=str(metadata.get("run_id", run_dir.name)),
        prompt_sha256=metadata.get("prompt_sha256"),
        evaluation_context=metadata.get("evaluation_context"),
    )


def run_evaluation(
    config: EvaluationConfig,
    *,
    trials: int,
    lens_ids: Sequence[str],
    output_root: Path | None,
    run_id: str | None,
    codex_bin: str,
    model: str | None,
    reasoning_effort: str | None,
    timeout_seconds: int,
) -> tuple[Path, dict[str, Any]]:
    if trials <= 0:
        raise ValueError("trials must be positive")
    agent = load_inspector_agent(config)
    if not config.output_schema.is_file():
        raise FileNotFoundError(f"missing output schema: {config.output_schema}")
    selected_model = (
        agent.model
        if model is None
        else _nonempty_string(model, field="--model", source="CLI override")
    )
    selected_effort = (
        agent.model_reasoning_effort
        if reasoning_effort is None
        else _nonempty_string(
            reasoning_effort,
            field="--reasoning-effort",
            source="CLI override",
        )
    )
    prepare_fixtures(config)
    cases = _selected_cases(config, lens_ids)
    developer_instructions = agent.developer_instructions
    prompt_hash = hashlib.sha256(developer_instructions.encode("utf-8")).hexdigest()
    evaluation_context = {
        "model": selected_model,
        "model_reasoning_effort": selected_effort,
        "prompt_sha256": prompt_hash,
        "fixtures": [
            {
                "lens_id": case.lens_id,
                "image_sha256": case.image_sha256,
                "expected_disposition": case.expected_disposition,
                "expected_contaminant_ids": list(case.expected_contaminant_ids),
            }
            for case in cases
        ],
    }
    run_id = run_id or datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output_root = (output_root or config.default_output_root).resolve()
    run_dir = output_root / run_id
    if run_dir.exists():
        raise FileExistsError(f"evaluation run already exists: {run_dir}")
    run_dir.mkdir(parents=True)

    metadata = {
        "schema_version": "system_inspector_run.v2",
        "run_id": run_id,
        "created_at": datetime.now(UTC).isoformat(),
        "manifest": str(config.manifest_path),
        "manifest_sha256": sha256_file(config.manifest_path),
        "agent_config": str(config.agent_config),
        "agent_config_sha256": agent.sha256,
        "agent_defaults": {
            "model": agent.model,
            "model_reasoning_effort": agent.model_reasoning_effort,
        },
        "cli_overrides": {
            "model": model,
            "model_reasoning_effort": reasoning_effort,
        },
        "prompt_sha256": prompt_hash,
        "output_schema_sha256": sha256_file(config.output_schema),
        "model": selected_model,
        "model_source": "agent_config" if model is None else "cli_override",
        "model_reasoning_effort": selected_effort,
        "model_reasoning_effort_source": (
            "agent_config" if reasoning_effort is None else "cli_override"
        ),
        "trials_per_case": trials,
        "lens_ids": [case.lens_id for case in cases],
        "evaluation_context": evaluation_context,
    }
    (run_dir / "run_metadata.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    results: list[dict[str, Any]] = []
    for case in cases:
        for trial in range(1, trials + 1):
            trial_dir = run_dir / "cases" / case.lens_id / f"trial_{trial:02d}"
            prediction, error = run_codex_trial(
                case=case,
                developer_instructions=developer_instructions,
                user_prompt=evaluation_user_prompt(case.lens_id),
                output_schema=config.output_schema,
                trial_dir=trial_dir,
                codex_bin=codex_bin,
                model=selected_model,
                reasoning_effort=selected_effort,
                timeout_seconds=timeout_seconds,
            )
            results.append(
                score_prediction(case, prediction, error=error, trial=trial)
            )
    report = write_report(
        run_dir,
        results,
        run_id=run_id,
        prompt_sha256=prompt_hash,
        evaluation_context=evaluation_context,
    )
    return run_dir, report


def _normalized_fixtures(value: Any) -> Any:
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        return value
    return sorted(
        value,
        key=lambda item: (
            str(item.get("lens_id", "")),
            json.dumps(item, sort_keys=True),
        ),
    )


def compare_reports(baseline: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    metric_names = [
        "contract_compliance",
        "disposition_accuracy",
        "exact_match_rate",
        "micro_precision",
        "micro_recall",
        "micro_f1",
        "miss_rate",
        "overmask_rate",
        "stable_case_rate",
    ]
    baseline_summary = baseline["summary"]
    current_summary = current["summary"]
    metrics = {
        name: {
            "baseline": baseline_summary[name],
            "current": current_summary[name],
            "delta": current_summary[name] - baseline_summary[name],
        }
        for name in metric_names
    }
    case_metrics: dict[str, dict[str, Any]] = {}
    all_lens_ids = sorted(set(baseline["case_summary"]) | set(current["case_summary"]))
    for lens_id in all_lens_ids:
        before = baseline["case_summary"].get(lens_id)
        after = current["case_summary"].get(lens_id)
        case_metrics[lens_id] = {
            "baseline": before,
            "current": after,
            "exact_match_rate_delta": (
                after["exact_match_rate"] - before["exact_match_rate"]
                if before is not None and after is not None
                else None
            ),
        }
    baseline_context = baseline.get("evaluation_context")
    current_context = current.get("evaluation_context")
    differences: list[dict[str, Any]] = []
    if not isinstance(baseline_context, dict) or not isinstance(current_context, dict):
        differences.append(
            {
                "field": "evaluation_context",
                "baseline": baseline_context,
                "current": current_context,
            }
        )
    else:
        for field in (
            "model",
            "model_reasoning_effort",
            "prompt_sha256",
            "fixtures",
        ):
            before = baseline_context.get(field)
            after = current_context.get(field)
            if field == "fixtures":
                before = _normalized_fixtures(before)
                after = _normalized_fixtures(after)
            if before != after:
                differences.append(
                    {"field": field, "baseline": before, "current": after}
                )
    return {
        "schema_version": "system_inspector_comparison.v2",
        "baseline_run_id": baseline["run_id"],
        "current_run_id": current["run_id"],
        "comparability": {
            "comparable": not differences,
            "differences": differences,
        },
        "metrics": metrics,
        "cases": case_metrics,
    }


def _comparison_markdown(comparison: dict[str, Any]) -> str:
    lines = [
        "# System Inspector regression comparison",
        "",
        f"- Baseline: `{comparison['baseline_run_id']}`",
        f"- Current: `{comparison['current_run_id']}`",
    ]
    differences = comparison["comparability"]["differences"]
    if differences:
        fields = ", ".join(item["field"] for item in differences)
        lines.extend(
            [
                "",
                "## Comparability warning",
                "",
                "The metric comparison is shown, but changes cannot be attributed to a single "
                f"factor because these evaluation inputs differ: {fields}.",
            ]
        )
    lines.extend(
        [
            "",
            "| Metric | Baseline | Current | Delta |",
            "|---|---:|---:|---:|",
        ]
    )
    for name, values in comparison["metrics"].items():
        lines.append(
            f"| {name} | {values['baseline']:.3f} | {values['current']:.3f} | "
            f"{values['delta']:+.3f} |"
        )
    lines.extend(
        [
            "",
            "| Lens | Exact delta | Current missed IDs | Current over-masked IDs |",
            "|---|---:|---|---|",
        ]
    )
    for lens_id, values in comparison["cases"].items():
        current = values["current"] or {}
        delta = values["exact_match_rate_delta"]
        delta_text = "n/a" if delta is None else f"{delta:+.3f}"
        lines.append(
            f"| {lens_id} | {delta_text} | "
            f"{current.get('missed_id_counts', {})} | "
            f"{current.get('overmasked_id_counts', {})} |"
        )
    return "\n".join(lines) + "\n"


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    commands = parser.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare", help="copy and checksum golden PNG fixtures")
    prepare.add_argument("--force", action="store_true")

    run = commands.add_parser("run", help="invoke Codex and score a new regression run")
    run.add_argument("--trials", type=int, default=1)
    run.add_argument("--case", action="append", default=[], dest="lens_ids")
    run.add_argument("--output-root", type=Path)
    run.add_argument("--run-id")
    run.add_argument("--codex-bin", default="codex")
    run.add_argument(
        "--model",
        help="temporary model override; defaults to the System Inspector agent config",
    )
    run.add_argument(
        "--reasoning-effort",
        help="temporary reasoning-effort override; defaults to the System Inspector agent config",
    )
    run.add_argument("--timeout-seconds", type=int, default=900)
    run.add_argument("--baseline", type=Path)

    score = commands.add_parser("score", help="score prediction JSON files in an existing run")
    score.add_argument("--run-dir", type=Path, required=True)

    compare = commands.add_parser("compare", help="compare two report.json files")
    compare.add_argument("baseline", type=Path)
    compare.add_argument("current", type=Path)
    compare.add_argument("--output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    args = _build_parser().parse_args(argv)
    config = load_config(args.manifest)
    if args.command == "prepare":
        print(json.dumps(prepare_fixtures(config, force=args.force), indent=2))
        return
    if args.command == "run":
        run_dir, report = run_evaluation(
            config,
            trials=args.trials,
            lens_ids=args.lens_ids,
            output_root=args.output_root,
            run_id=args.run_id,
            codex_bin=args.codex_bin,
            model=args.model,
            reasoning_effort=args.reasoning_effort,
            timeout_seconds=args.timeout_seconds,
        )
        print(_markdown_report(report))
        print(f"report: {run_dir / 'report.json'}")
        if args.baseline:
            comparison = compare_reports(_load_json(args.baseline), report)
            (run_dir / "comparison.json").write_text(
                json.dumps(comparison, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            (run_dir / "comparison.md").write_text(
                _comparison_markdown(comparison), encoding="utf-8"
            )
        return
    if args.command == "score":
        report = score_run(config, args.run_dir.resolve())
        print(_markdown_report(report))
        return
    if args.command == "compare":
        comparison = compare_reports(_load_json(args.baseline), _load_json(args.current))
        markdown = _comparison_markdown(comparison)
        if args.output:
            args.output.write_text(markdown, encoding="utf-8")
        print(markdown)
        return
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    main()
