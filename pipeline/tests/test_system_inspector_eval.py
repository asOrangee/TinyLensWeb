import json
import subprocess
from pathlib import Path

import pytest

from lens_agent.evaluation.system_inspector import (
    EvaluationConfig,
    GoldenCase,
    aggregate_results,
    codex_generation_schema,
    compare_reports,
    evaluation_user_prompt,
    load_config,
    prepare_fixtures,
    run_codex_trial,
    run_evaluation,
    score_prediction,
    sha256_file,
)


def make_case(tmp_path: Path, expected_ids: tuple[int, ...] = (1, 2)) -> GoldenCase:
    source_image = tmp_path / "source.png"
    source_image.write_bytes(b"fixed diagnostic")
    return GoldenCase(
        lens_id="lens-001",
        source_image=source_image,
        image=tmp_path / "fixtures" / "lens-001.png",
        image_sha256=sha256_file(source_image),
        expected_disposition="model",
        expected_contaminant_ids=expected_ids,
        focus=("test case",),
    )


def make_config(tmp_path: Path, case: GoldenCase) -> EvaluationConfig:
    manifest_path = tmp_path / "golden.toml"
    manifest_path.write_text('schema_version = "system_inspector_golden.v4"\n', encoding="utf-8")
    agent_config = tmp_path / "agent.toml"
    agent_config.write_text(
        '\n'.join(
            [
                'name = "system_inspector"',
                'model = "agent-model"',
                'model_reasoning_effort = "medium"',
                'developer_instructions = "inspect the image"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    output_schema = tmp_path / "schema.json"
    output_schema.write_text('{"type": "object"}\n', encoding="utf-8")
    return EvaluationConfig(
        manifest_path=manifest_path,
        agent_config=agent_config,
        output_schema=output_schema,
        default_output_root=tmp_path / "runs",
        cases=(case,),
    )


def test_prepare_fixtures_copies_and_verifies_immutable_png(tmp_path: Path) -> None:
    case = make_case(tmp_path)
    config = make_config(tmp_path, case)

    first = prepare_fixtures(config)
    second = prepare_fixtures(config)

    assert first[0]["status"] == "copied"
    assert second[0]["status"] == "verified"
    assert case.image.read_bytes() == case.source_image.read_bytes()


def test_prepare_fixtures_rejects_changed_source(tmp_path: Path) -> None:
    case = make_case(tmp_path)
    config = make_config(tmp_path, case)
    case.source_image.write_bytes(b"changed diagnostic")

    with pytest.raises(ValueError, match="source image checksum changed"):
        prepare_fixtures(config)


def test_evaluation_submits_only_the_two_panel_prompt() -> None:
    prompt = evaluation_user_prompt("lens-001")

    assert "two-panel PNG" in prompt
    assert "six-panel" not in prompt


def test_codex_generation_schema_removes_only_api_unsupported_constraints() -> None:
    schema = {
        "type": "object",
        "properties": {
            "ids": {"type": "array", "uniqueItems": True},
            "label": {
                "oneOf": [
                    {"type": "string", "minLength": 1},
                    {"type": "null"},
                ]
            },
        },
        "allOf": [{"if": {}, "then": {}}],
    }

    projected = codex_generation_schema(schema)

    assert projected == {
        "type": "object",
        "properties": {
            "ids": {"type": "array"},
            "label": {
                "anyOf": [
                    {"type": "string", "minLength": 1},
                    {"type": "null"},
                ]
            },
        },
    }
    assert "allOf" in schema
    assert schema["properties"]["ids"]["uniqueItems"] is True


def test_scoring_reports_missed_and_overmasked_ids(tmp_path: Path) -> None:
    case = make_case(tmp_path)
    prediction = {
        "lens_id": case.lens_id,
        "disposition": "model",
        "contaminant_ids": [2, 3],
        "reason": "one expected contaminant and one off-target ID",
        "theta_E_hint": {
            "estimate_arcsec": 1.35,
            "plausible_range_arcsec": [1.05, 1.7],
            "confidence": "medium",
            "deflector_center": {"dra_arcsec": 0.0, "ddec_arcsec": 0.0},
            "basis": "secure tangential image family",
        },
    }

    result = score_prediction(case, prediction)
    summary = aggregate_results([result])

    assert result["true_positives"] == [2]
    assert result["false_negatives"] == [1]
    assert result["false_positives"] == [3]
    assert not result["exact_match"]
    assert summary["micro_precision"] == 0.5
    assert summary["micro_recall"] == 0.5
    assert summary["micro_f1"] == 0.5
    assert summary["miss_rate"] == 0.5
    assert summary["overmask_rate"] == 0.5


def test_invalid_contract_is_penalized_as_a_miss(tmp_path: Path) -> None:
    case = make_case(tmp_path)
    prediction = {
        "lens_id": case.lens_id,
        "disposition": "model",
        "contaminant_ids": [2, 1],
        "reason": "IDs are not sorted",
    }

    result = score_prediction(case, prediction)

    assert not result["contract_valid"]
    assert result["predicted_contaminant_ids"] == []
    assert result["false_negatives"] == [1, 2]


def test_codex_trial_is_isolated_from_golden_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = make_case(tmp_path, expected_ids=(7,))
    case.image.parent.mkdir()
    case.image.write_bytes(case.source_image.read_bytes())
    schema = tmp_path / "schema.json"
    schema.write_text(
        json.dumps(
            {
                "type": "object",
                "properties": {
                    "ids": {"type": "array", "uniqueItems": True},
                    "label": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "null"},
                        ]
                    },
                },
                "allOf": [{"if": {}, "then": {}}],
            }
        ),
        encoding="utf-8",
    )
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["command"] = command
        captured["prompt"] = kwargs["input"]
        output_schema_path = Path(command[command.index("--output-schema") + 1])
        captured["output_schema"] = json.loads(
            output_schema_path.read_text(encoding="utf-8")
        )
        prediction_path = Path(command[command.index("--output-last-message") + 1])
        prediction_path.write_text(
            json.dumps(
                {
                    "lens_id": case.lens_id,
                    "disposition": "model",
                    "contaminant_ids": [7],
                    "reason": "isolated test",
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    prediction, error = run_codex_trial(
        case=case,
        developer_instructions="inspect as a strong-lens expert",
        user_prompt="review only the attached image",
        output_schema=schema,
        trial_dir=tmp_path / "trial",
        codex_bin="codex",
        model="test-model",
        reasoning_effort="medium",
        timeout_seconds=10,
    )

    command = captured["command"]
    assert isinstance(command, list)
    assert "--ephemeral" in command
    assert "--ignore-user-config" in command
    assert "--ignore-rules" in command
    assert any(
        str(value).startswith("developer_instructions=") for value in command
    )
    image_path = Path(command[command.index("--image") + 1])
    assert image_path.name == "preflight_2panel.png"
    assert str(case.image) not in command
    assert "expected_contaminant_ids" not in str(captured["prompt"])
    assert captured["output_schema"] == {
        "type": "object",
        "properties": {
            "ids": {"type": "array"},
            "label": {
                "anyOf": [
                    {"type": "string"},
                    {"type": "null"},
                ]
            },
        },
    }
    assert error is None
    assert prediction is not None
    assert prediction["contaminant_ids"] == [7]


def test_evaluation_defaults_to_agent_runtime_and_records_its_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = make_case(tmp_path)
    config = make_config(tmp_path, case)
    captured_commands: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured_commands.append(command)
        prediction_path = Path(command[command.index("--output-last-message") + 1])
        prediction_path.write_text(
            json.dumps(
                {
                    "lens_id": case.lens_id,
                    "disposition": "human_review",
                    "contaminant_ids": [],
                    "reason": "isolated test",
                    "theta_E_hint": None,
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    run_dir, report = run_evaluation(
        config,
        trials=1,
        lens_ids=[],
        output_root=None,
        run_id="agent-defaults",
        codex_bin="codex",
        model=None,
        reasoning_effort=None,
        timeout_seconds=10,
    )

    command = captured_commands[0]
    assert command[command.index("--model") + 1] == "agent-model"
    assert 'model_reasoning_effort="medium"' in command
    metadata = json.loads((run_dir / "run_metadata.json").read_text(encoding="utf-8"))
    assert metadata["model"] == "agent-model"
    assert metadata["model_source"] == "agent_config"
    assert metadata["model_reasoning_effort"] == "medium"
    assert metadata["model_reasoning_effort_source"] == "agent_config"
    assert metadata["agent_defaults"] == {
        "model": "agent-model",
        "model_reasoning_effort": "medium",
    }
    assert metadata["cli_overrides"] == {
        "model": None,
        "model_reasoning_effort": None,
    }
    assert metadata["agent_config_sha256"] == sha256_file(config.agent_config)
    assert report["evaluation_context"] == {
        "model": "agent-model",
        "model_reasoning_effort": "medium",
        "prompt_sha256": metadata["prompt_sha256"],
        "fixtures": [
            {
                "lens_id": case.lens_id,
                "image_sha256": case.image_sha256,
                "expected_disposition": "model",
                "expected_contaminant_ids": [1, 2],
            }
        ],
    }


@pytest.mark.parametrize(
    ("model_override", "effort_override", "expected_model", "expected_effort"),
    [
        ("override-model", None, "override-model", "medium"),
        (None, "medium", "agent-model", "medium"),
    ],
)
def test_evaluation_allows_independent_temporary_runtime_overrides(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    model_override: str | None,
    effort_override: str | None,
    expected_model: str,
    expected_effort: str,
) -> None:
    case = make_case(tmp_path)
    config = make_config(tmp_path, case)
    captured_commands: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured_commands.append(command)
        prediction_path = Path(command[command.index("--output-last-message") + 1])
        prediction_path.write_text(
            json.dumps(
                {
                    "lens_id": case.lens_id,
                    "disposition": "human_review",
                    "contaminant_ids": [],
                    "reason": "isolated test",
                    "theta_E_hint": None,
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    run_dir, _ = run_evaluation(
        config,
        trials=1,
        lens_ids=[],
        output_root=None,
        run_id="temporary-override",
        codex_bin="codex",
        model=model_override,
        reasoning_effort=effort_override,
        timeout_seconds=10,
    )

    command = captured_commands[0]
    assert command[command.index("--model") + 1] == expected_model
    assert f'model_reasoning_effort="{expected_effort}"' in command
    metadata = json.loads((run_dir / "run_metadata.json").read_text(encoding="utf-8"))
    assert metadata["model_source"] == (
        "cli_override" if model_override is not None else "agent_config"
    )
    assert metadata["model_reasoning_effort_source"] == (
        "cli_override" if effort_override is not None else "agent_config"
    )


def test_golden_manifest_rejects_runtime_defaults(tmp_path: Path) -> None:
    manifest = tmp_path / "golden.toml"
    manifest.write_text(
        '\n'.join(
            [
                'schema_version = "system_inspector_golden.v2"',
                'model = "stale-model"',
                'model_reasoning_effort = "medium"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="runtime fields are not allowed"):
        load_config(manifest)


def test_golden_manifest_rejects_non_string_paths(tmp_path: Path) -> None:
    manifest = tmp_path / "golden.toml"
    manifest.write_text(
        '\n'.join(
            [
                'schema_version = "system_inspector_golden.v4"',
                "agent_config = 7",
                'output_schema = "schema.json"',
                'default_output_root = "runs"',
                "[[cases]]",
                'lens_id = "lens-001"',
                'source_image = "source.png"',
                'image = "image.png"',
                'image_sha256 = "abc"',
                'expected_disposition = "model"',
                "expected_contaminant_ids = []",
                "focus = []",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="agent_config must be a non-empty string"):
        load_config(manifest)


@pytest.mark.parametrize(
    "agent_text",
    [
        'name = "wrong_agent"\nmodel = "agent-model"\nmodel_reasoning_effort = "medium"\n'
        'developer_instructions = "inspect"\n',
        'name = "system_inspector"\nmodel = 7\nmodel_reasoning_effort = "medium"\n'
        'developer_instructions = "inspect"\n',
        'name = "system_inspector"\nmodel = "agent-model"\n'
        'model_reasoning_effort = " "\ndeveloper_instructions = "inspect"\n',
        'name = "system_inspector"\nmodel = "agent-model"\n'
        'model_reasoning_effort = "medium"\n',
    ],
)
def test_invalid_agent_runtime_fails_before_creating_a_run(
    tmp_path: Path, agent_text: str
) -> None:
    case = make_case(tmp_path)
    config = make_config(tmp_path, case)
    config.agent_config.write_text(agent_text, encoding="utf-8")

    with pytest.raises(ValueError):
        run_evaluation(
            config,
            trials=1,
            lens_ids=[],
            output_root=None,
            run_id="must-not-exist",
            codex_bin="codex",
            model=None,
            reasoning_effort=None,
            timeout_seconds=10,
        )

    assert not (config.default_output_root / "must-not-exist").exists()


def test_missing_output_schema_fails_before_creating_a_run(tmp_path: Path) -> None:
    case = make_case(tmp_path)
    config = make_config(tmp_path, case)
    config.output_schema.unlink()

    with pytest.raises(FileNotFoundError, match="output schema"):
        run_evaluation(
            config,
            trials=1,
            lens_ids=[],
            output_root=None,
            run_id="must-not-exist",
            codex_bin="codex",
            model=None,
            reasoning_effort=None,
            timeout_seconds=10,
        )

    assert not (config.default_output_root / "must-not-exist").exists()


def test_invalid_trials_are_not_reported_as_stable(tmp_path: Path) -> None:
    case = make_case(tmp_path)
    result = score_prediction(case, None, error="model invocation failed")

    summary = aggregate_results([result])

    assert summary["micro_precision"] == 0.0
    assert summary["stable_case_rate"] == 0.0


def test_report_comparison_calculates_metric_deltas() -> None:
    evaluation_context = {
        "model": "agent-model",
        "model_reasoning_effort": "medium",
        "prompt_sha256": "prompt-hash",
        "fixtures": [
            {
                "lens_id": "lens-001",
                "image_sha256": "image-hash",
                "expected_disposition": "model",
                "expected_contaminant_ids": [1],
            }
        ],
    }
    baseline = {
        "run_id": "baseline",
        "evaluation_context": evaluation_context,
        "case_summary": {
            "lens-001": {
                "trials": 1,
                "contract_compliance": 1.0,
                "exact_match_rate": 0.0,
                "missed_id_counts": {"1": 1},
                "overmasked_id_counts": {},
            }
        },
        "summary": {
            "contract_compliance": 1.0,
            "disposition_accuracy": 1.0,
            "exact_match_rate": 0.5,
            "micro_precision": 0.8,
            "micro_recall": 0.5,
            "micro_f1": 0.615,
            "miss_rate": 0.5,
            "overmask_rate": 0.2,
            "stable_case_rate": 0.5,
        },
    }
    current = {
        "run_id": "current",
        "evaluation_context": evaluation_context,
        "case_summary": {
            "lens-001": {
                "trials": 1,
                "contract_compliance": 1.0,
                "exact_match_rate": 1.0,
                "missed_id_counts": {},
                "overmasked_id_counts": {},
            }
        },
        "summary": {
            "contract_compliance": 1.0,
            "disposition_accuracy": 1.0,
            "exact_match_rate": 1.0,
            "micro_precision": 1.0,
            "micro_recall": 1.0,
            "micro_f1": 1.0,
            "miss_rate": 0.0,
            "overmask_rate": 0.0,
            "stable_case_rate": 1.0,
        },
    }

    comparison = compare_reports(baseline, current)

    assert comparison["metrics"]["exact_match_rate"]["delta"] == 0.5
    assert comparison["metrics"]["miss_rate"]["delta"] == -0.5
    assert comparison["cases"]["lens-001"]["exact_match_rate_delta"] == 1.0
    assert comparison["comparability"] == {"comparable": True, "differences": []}


def test_report_comparison_warns_but_continues_across_runtime_and_fixture_changes() -> None:
    summary = {
        "contract_compliance": 1.0,
        "disposition_accuracy": 1.0,
        "exact_match_rate": 1.0,
        "micro_precision": 1.0,
        "micro_recall": 1.0,
        "micro_f1": 1.0,
        "miss_rate": 0.0,
        "overmask_rate": 0.0,
        "stable_case_rate": 1.0,
    }
    baseline = {
        "run_id": "baseline",
        "summary": summary,
        "case_summary": {},
        "evaluation_context": {
            "model": "old-model",
            "model_reasoning_effort": "medium",
            "prompt_sha256": "old-prompt",
            "fixtures": [{"lens_id": "lens-001", "image_sha256": "old-image"}],
        },
    }
    current = {
        "run_id": "current",
        "summary": summary,
        "case_summary": {},
        "evaluation_context": {
            "model": "new-model",
            "model_reasoning_effort": "medium",
            "prompt_sha256": "new-prompt",
            "fixtures": [{"lens_id": "lens-001", "image_sha256": "new-image"}],
        },
    }

    comparison = compare_reports(baseline, current)

    assert not comparison["comparability"]["comparable"]
    assert [item["field"] for item in comparison["comparability"]["differences"]] == [
        "model",
        "prompt_sha256",
        "fixtures",
    ]
    assert comparison["metrics"]["exact_match_rate"]["delta"] == 0.0


def test_report_comparison_ignores_fixture_order() -> None:
    summary = {
        "contract_compliance": 1.0,
        "disposition_accuracy": 1.0,
        "exact_match_rate": 1.0,
        "micro_precision": 1.0,
        "micro_recall": 1.0,
        "micro_f1": 1.0,
        "miss_rate": 0.0,
        "overmask_rate": 0.0,
        "stable_case_rate": 1.0,
    }
    fixtures = [
        {"lens_id": "lens-001", "image_sha256": "image-1"},
        {"lens_id": "lens-002", "image_sha256": "image-2"},
    ]
    context = {
        "model": "agent-model",
        "model_reasoning_effort": "medium",
        "prompt_sha256": "prompt-hash",
        "fixtures": fixtures,
    }
    baseline = {
        "run_id": "baseline",
        "summary": summary,
        "case_summary": {},
        "evaluation_context": context,
    }
    current = {
        "run_id": "current",
        "summary": summary,
        "case_summary": {},
        "evaluation_context": {**context, "fixtures": list(reversed(fixtures))},
    }

    comparison = compare_reports(baseline, current)

    assert comparison["comparability"] == {"comparable": True, "differences": []}
