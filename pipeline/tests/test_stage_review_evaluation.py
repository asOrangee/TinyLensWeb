import json
from pathlib import Path
from threading import Barrier, Lock

import pytest

from lens_agent.evaluation import stage_review as evaluation


@pytest.fixture
def fixture_manifest(tmp_path):
    attempt = tmp_path / "original" / "lens" / "attempts" / "a" / "0"
    attempt.mkdir(parents=True)
    (attempt / "stage-result.json").write_text(json.dumps({"status": "success", "eligible_for_review": True, "gate_failures": [], "metrics": {"log_z": 1.2}, "original": "/secret/original", "decision": "human_review"}))
    (attempt / "review-context.json").write_text(json.dumps({"upstream_warnings": [{"kind": "model_limited_residual"}], "expected_outcome": "stop"}))
    (attempt / "model.png").write_bytes(b"png fixture")
    (attempt / "review.json").write_text('{"secret_label": "failed"}')
    manifest = tmp_path / "manifest.toml"
    manifest.write_text(f'''schema_version = "stage_review_golden.v1"
default_output_root = "{tmp_path / 'evaluation'}"
[[cases]]
id = "test_a"
stage = "a"
attempt_dir = "{attempt}"
expected_outcome = "continue"
fixture_note = "Historical numerical evidence; unchanged."
evidence = ["stage-result.json", "review-context.json", "model.png"]
''')
    return manifest, attempt


def test_prepare_excludes_labels_preserves_science_and_originals(fixture_manifest, tmp_path):
    manifest, original = fixture_manifest
    before = {p.name: p.read_bytes() for p in original.iterdir()}
    snapshot = evaluation.prepare(manifest, tmp_path / "evaluation", "candidate")
    metadata = json.loads((snapshot / "snapshot.json").read_text())
    developer, user, images = evaluation.trial_inputs(snapshot, metadata["manifest"]["cases"][0], metadata)
    assert "secret_label" not in user and "human_review" not in user
    assert "expected_outcome" not in user and "/secret/original" not in user
    assert "model_limited_residual" in user and '"log_z": 1.2' in user
    assert "Historical numerical evidence" in user
    assert len(images) == 1 and "REVIEW-ONLY" in developer
    assert not list((snapshot / "evidence").rglob("review.json"))
    assert before == {p.name: p.read_bytes() for p in original.iterdir()}
    evaluation.verify_evidence(snapshot, metadata)
    images[0].write_bytes(b"changed")
    with pytest.raises(ValueError, match="checksum"):
        evaluation.verify_evidence(snapshot, metadata)


@pytest.mark.parametrize("file", ["review.json", "decision.json", "../stage-result.json"])
def test_forbidden_evidence_is_rejected(fixture_manifest, file):
    manifest, _ = fixture_manifest
    case = evaluation.load_manifest(manifest)["cases"][0]
    case["evidence"] = [file]
    with pytest.raises(ValueError):
        evaluation._source_paths(case)


def test_original_output_and_overwrite_rejected(fixture_manifest, tmp_path):
    manifest, original = fixture_manifest
    with pytest.raises(ValueError, match="separate"):
        evaluation.prepare(manifest, original / "eval", "candidate")
    evaluation.prepare(manifest, tmp_path / "evaluation", "candidate")
    with pytest.raises(FileExistsError):
        evaluation.prepare(manifest, tmp_path / "evaluation", "candidate")


def review(stage="a"):
    value = {"stage": stage, "visual_findings": ["Principal image geometry is captured."], "numerical_findings": [], "progression_blockers": [], "handoff_warnings": [], "upstream_warning_updates": [], "retry_repair": None, "development_recommendation": None, "reason": "Ready for downstream modeling."}
    if stage == "m1":
        value["scientific_uncertainty"] = None
    return value


@pytest.mark.parametrize("stage", ["a", "m1"])
def test_existing_schema_and_validator_decision_mapping(stage):
    schema = json.loads((evaluation.REPOSITORY_ROOT / f".codex/evals/stage-{stage}-expert-output.schema.json").read_text())
    case = {"id": "test", "stage": stage, "expected_outcome": "continue"}
    prediction = review(stage)
    assert evaluation.score_prediction(case, prediction, schema)["exact_match"]
    prediction["progression_blockers"] = [{"kind": "structural_image_family_failure", "evidence": ["A complete counterimage is absent."], "impact": "The principal correspondence fails."}]
    result = evaluation.score_prediction(case, prediction, schema)
    assert result["contract_valid"] and result["outcome"] == "stop" and not result["exact_match"]
    prediction["decision"] = "accept"
    assert not evaluation.score_prediction(case, prediction, schema)["contract_valid"]


def test_uncertainty_and_missing_trials_cannot_pass(fixture_manifest, tmp_path):
    manifest, _ = fixture_manifest
    snapshot = evaluation.prepare(manifest, tmp_path / "evaluation", "candidate")
    (snapshot / "run.json").write_text(json.dumps({"trials": 3, "runtime": {}}))
    report = evaluation.score(snapshot)
    assert len(report["results"]) == 3 and not report["all_passed"]
    assert all(not item["contract_valid"] for item in report["results"])


def test_tool_event_audit():
    assert evaluation.forbidden_tool_events('{"type":"item.completed","item":{"type":"command_execution"}}')
    assert not evaluation.forbidden_tool_events('{"type":"item.completed","item":{"type":"agent_message"}}')


@pytest.mark.parametrize("stage", ["a", "m1"])
def test_generation_schema_has_typed_constants_and_closed_objects(stage):
    schema = json.loads((evaluation.REPOSITORY_ROOT / f".codex/evals/stage-{stage}-expert-output.schema.json").read_text())
    original = json.dumps(schema, sort_keys=True)
    projected = evaluation.generation_schema(schema)

    def check(value):
        if isinstance(value, dict):
            if "const" in value:
                assert "type" in value
            if value.get("type") == "object":
                assert value["additionalProperties"] is False
                assert set(value["required"]) == set(value["properties"])
            assert "oneOf" not in value and "allOf" not in value
            for child in value.values():
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)

    check(projected)
    evaluation.jsonschema.Draft202012Validator(projected).validate(review(stage))
    assert json.dumps(schema, sort_keys=True) == original


def test_mocked_runner_is_read_only_and_records_trials(fixture_manifest, tmp_path, monkeypatch):
    manifest, original = fixture_manifest
    snapshot = evaluation.prepare(manifest, tmp_path / "evaluation", "candidate")
    before = {p.name: p.read_bytes() for p in original.iterdir()}
    calls = []

    def invoke(command, **kwargs):
        calls.append((command, kwargs))
        output = Path(command[command.index("--output-last-message") + 1])
        output.write_text(json.dumps(review()))
        return type("Completed", (), {"stdout": '{"type":"turn.completed"}\n', "stderr": "", "returncode": 0})()

    monkeypatch.setattr(evaluation.subprocess, "run", invoke)
    assert evaluation.run(snapshot)["all_passed"]
    assert len(calls) == 3
    for command, kwargs in calls:
        assert "--ignore-user-config" in command and "--ephemeral" in command
        assert "features.shell_tool=false" in command
        assert command[command.index("--sandbox") + 1] == "read-only"
        assert str(original) not in kwargs["input"]
        assert "expected_outcome" not in kwargs["input"]
    assert before == {p.name: p.read_bytes() for p in original.iterdir()}


def test_upstream_warnings_require_exact_updates():
    schema = json.loads((evaluation.REPOSITORY_ROOT / ".codex/evals/stage-m1-expert-output.schema.json").read_text())
    case = {"id": "test", "stage": "m1", "expected_outcome": "continue"}
    context = {"unresolved_upstream_warnings": [{"warning_ref": "a:0:w0"}]}
    prediction = review("m1")
    assert not evaluation.score_prediction(case, prediction, schema, context=context)["contract_valid"]
    prediction["upstream_warning_updates"] = [{"warning_ref": "a:0:w0", "status": "persisted", "evidence": ["Local residual remains."]}]
    assert evaluation.score_prediction(case, prediction, schema, context=context)["exact_match"]
    prediction["upstream_warning_updates"] *= 2
    assert not evaluation.score_prediction(case, prediction, schema, context=context)["contract_valid"]


def test_failed_hard_gate_cannot_be_prepared(fixture_manifest, tmp_path):
    manifest, original = fixture_manifest
    (original / "stage-result.json").write_text(json.dumps({"status": "success", "eligible_for_review": False}))
    with pytest.raises(ValueError, match="hard-gate"):
        evaluation.prepare(manifest, tmp_path / "evaluation", "candidate")
    assert not (tmp_path / "evaluation").exists()


def test_runner_fails_fast_on_backend_error(fixture_manifest, tmp_path, monkeypatch):
    manifest, _ = fixture_manifest
    snapshot = evaluation.prepare(manifest, tmp_path / "evaluation", "candidate")
    calls = []

    def invoke(*args, **kwargs):
        calls.append(args)
        return type("Completed", (), {"stdout": "", "stderr": "invalid_json_schema", "returncode": 1})()

    monkeypatch.setattr(evaluation.subprocess, "run", invoke)
    report = evaluation.run(snapshot)
    assert len(calls) == 1
    assert len(report["results"]) == 3 and not report["all_passed"]
    assert (snapshot / "report.md").exists()


def test_parallel_cases_keep_trials_and_outputs_separate(fixture_manifest, tmp_path, monkeypatch):
    manifest, _ = fixture_manifest
    first = manifest.read_text()
    second_case = "[[cases]]" + first.split("[[cases]]", 1)[1].replace('id = "test_a"', 'id = "test_b"').replace("Historical numerical evidence; unchanged.", "Independent second case.")
    manifest.write_text(first + "\n" + second_case)
    snapshot = evaluation.prepare(manifest, tmp_path / "evaluation", "candidate")
    barrier = Barrier(2)
    lock = Lock()
    seen = []

    def invoke(command, **kwargs):
        identity = "test_b" if "Independent second case" in kwargs["input"] else "test_a"
        with lock:
            seen.append(identity)
        barrier.wait(timeout=5)
        prediction = review()
        prediction["reason"] = identity
        Path(command[command.index("--output-last-message") + 1]).write_text(json.dumps(prediction))
        return type("Completed", (), {"stdout": '{"type":"turn.completed"}', "stderr": "", "returncode": 0})()

    monkeypatch.setattr(evaluation.subprocess, "run", invoke)
    report = evaluation.run(snapshot, jobs=2)
    assert report["all_passed"] and report["jobs"] == 2
    assert seen.count("test_a") == seen.count("test_b") == 3
    assert json.loads((snapshot / "run.json").read_text())["jobs"] == 2
    for identity in ("test_a", "test_b"):
        for trial in range(1, 4):
            prediction = json.loads((snapshot / "trials" / identity / str(trial) / "prediction.json").read_text())
            assert prediction["reason"] == identity
