import hashlib
import json
import runpy
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline/src"))
from lens_agent.attempts import CORE_EVIDENCE_FILES
from lens_agent.configuration import PIPELINE_RELEASE_ID
from lens_agent.modeling_comment import record_modeling_comment


scope = runpy.run_path(str(ROOT / "server/read-stage-scope.py"))["scope"]
COMMENTS = dict(zip(("preflight", "a", "b", "m0", "m1", "m2", "m3"), (
    "预检确认了输入与遮罩。",
    "A 阶段提供初始透镜质量模型。",
    "B 阶段核对了弧区。",
    "M0 核对了源网格。",
    "M1 更新了质量模型。",
    "M2 检查了自适应正则化。",
    "M3 给出了加权后验。",
)))


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(content), encoding="utf-8")
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def accepted_m3(tmp_path):
    run = tmp_path / "output/lens"
    folder = run / "attempts/m3/0"
    manifest = {"schema_version": "lens_run_manifest.v1", "run_id": "run_id", "lens_dir": "/input/lens",
                "pipeline_release_id": PIPELINE_RELEASE_ID}
    write(run / "run-manifest.json", manifest)
    write(run / "accepted/m3.json", {"schema_version": "accepted_stage_head.v1", "stage": "m3",
                                   "accepted_attempt": 0, "attempt_path": "../attempts/m3/0"})
    result = {"stage": "m3", "attempt": 0, "lens_id": "lens", "status": "success", "eligible_for_review": True,
              "gate_failures": [], "metrics": {"posterior_quantiles": {"theta_E": {"q16": .9, "q50": 1.0, "q84": 1.1}}}}
    result_sha = write(folder / "stage-result.json", result)
    review_sha = write(folder / "review.json", {"reason": "Synthetic review"})
    evidence = dict.fromkeys(CORE_EVIDENCE_FILES)
    evidence.update({"stage-result.json": result_sha, "review.json": review_sha})
    decision_sha = write(folder / "decision.json", {
        "schema_version": "stage_decision.v1", "stage": "m3", "attempt": 0,
        "decision": "accept", "evidence_sha256": evidence,
    })
    packet_path = "display/StageM3_Parameters.json"
    packet = {"schema": "tinylens.stage-parameters.v1", "run": str(run), "stage": "m3", "attempt": 0,
              "lens_id": "lens", "fixed_parameters": {"adaptive_reg_rho": 2.0}}
    packet_sha = write(folder / packet_path, packet)
    write(folder / "display-manifest.json", {"run": str(run), "run_id": "run_id", "lens_id": "lens", "stage": "m3",
                                             "attempt": 0, "summary": {"sha256": result_sha},
                                             "parameters": {"path": packet_path, "sha256": packet_sha}})
    request = {"root": str(tmp_path), "storage": str(run), "lens_id": "lens", "stage": "m3", "attempt": 0,
               "accepted": True, "completion": True}
    comment_identity = {"run_id": manifest["run_id"], "lens_id": "lens", "stage": "m3", "attempt": 0,
                        "result_sha256": result_sha, "decision_sha256": decision_sha}
    return run, request, comment_identity


def test_completion_keeps_legacy_comment_and_parameters_bound_to_reviewed_m3(tmp_path, accepted_m3):
    run, request, identity = accepted_m3
    recorded = run / "modeling-comment.json"
    legacy = {**identity, "schema": "tinylens.modeling-comment.v1", "text": "合成样例的点评。"}
    write(recorded, legacy)
    parameters = scope(request)["completion"]
    assert parameters["fixed_parameters"] == {"adaptive_reg_rho": 2.0}
    assert parameters["parameters"] == [{"name": "theta_E", "q16": .9, "q50": 1.0, "q84": 1.1, "stage": "m3"}]
    assert scope({**request, "include_comment": True})["completion"] == {**parameters, "comment": legacy["text"]}
    draft = tmp_path / "comments.json"
    write(draft, COMMENTS)
    with pytest.raises(ValueError, match="already registered"):
        record_modeling_comment(run, draft)
    assert json.loads(recorded.read_text()) == legacy
    write(recorded, {**legacy, "run_id": "stale"})
    assert scope({**request, "include_comment": True})["completion"] == parameters
    result_path = run / "attempts/m3/0/stage-result.json"
    result = json.loads(result_path.read_text())
    write(result_path, {**result, "eligible_for_review": False})
    with pytest.raises(ValueError, match="evidence disagrees"):
        scope(request)


def test_completion_publishes_all_seven_stage_comments_from_a_new_json_draft(tmp_path, accepted_m3):
    run, request, identity = accepted_m3
    stage_comments = {stage: "中" * 666 + f"{index}!" for index, stage in enumerate(COMMENTS)}
    draft = tmp_path / "comments.json"
    write(draft, stage_comments)
    recorded, attempt = record_modeling_comment(run, draft)
    assert attempt == 0
    assert json.loads(recorded.read_text()) == {
        **identity, "schema": "tinylens.modeling-comment.v2", "stage_comments": stage_comments,
    }
    assert record_modeling_comment(run, draft) == (recorded, attempt)
    write(draft, {**stage_comments, "a": "另一份点评"})
    with pytest.raises(ValueError, match="already registered"):
        record_modeling_comment(run, draft)

    parameters = scope(request)["completion"]
    assert "stage_comments" not in parameters
    assert scope({**request, "include_comment": True})["completion"] == {
        **parameters, "stage_comments": stage_comments,
    }


@pytest.mark.parametrize("draft_text", [
    "旧格式自由文本点评。",
    json.dumps(COMMENTS).replace("{", '{"a": "duplicate", ', 1),
    json.dumps({key: value for key, value in COMMENTS.items() if key != "m3"}),
    json.dumps({**COMMENTS, "a": "中" * 667}),
    json.dumps({**COMMENTS, "a": "第一段\n第二段"}),
])
def test_registration_rejects_invalid_drafts_without_writing_a_comment(tmp_path, accepted_m3, draft_text):
    run, _, _ = accepted_m3
    draft = tmp_path / "comments.json"
    draft.write_text(draft_text, encoding="utf-8")
    with pytest.raises(ValueError):
        record_modeling_comment(run, draft)
    assert not (run / "modeling-comment.json").exists()


@pytest.mark.parametrize("change", [
    {"stage_comments": {key: value for key, value in COMMENTS.items() if key != "m3"}},
    {"stage_comments": {**COMMENTS, "unknown": "不支持的阶段"}},
    {"stage_comments": list(COMMENTS.values())},
    {"stage_comments": {**COMMENTS, "b": 1}},
    {"stage_comments": {**COMMENTS, "b": ""}},
    {"stage_comments": {**COMMENTS, "b": " 前置空格"}},
    {"stage_comments": {**COMMENTS, "b": "第一段\n第二段"}},
    {"stage_comments": {**COMMENTS, "b": "第一段\u2028第二段"}},
    {"stage_comments": {**COMMENTS, "b": "非法\x00字符"}},
    {"stage_comments": {**COMMENTS, "b": "中" * 667}},
    {"attempt": False},
    {"decision_sha256": "0" * 64},
])
def test_completion_omits_the_entire_invalid_stage_comment_packet(accepted_m3, change):
    run, request, identity = accepted_m3
    write(run / "modeling-comment.json", {
        **identity, "schema": "tinylens.modeling-comment.v2", "stage_comments": COMMENTS, **change,
    })
    assert scope({**request, "include_comment": True})["completion"] == scope(request)["completion"]


def test_completion_omits_duplicates_in_the_stage_comment_packet(accepted_m3):
    run, request, identity = accepted_m3
    packet = json.dumps({**identity, "schema": "tinylens.modeling-comment.v2", "stage_comments": COMMENTS})
    duplicate = packet.replace('"stage_comments": {', '"stage_comments": {"a": "duplicate", ', 1)
    (run / "modeling-comment.json").write_text(duplicate, encoding="utf-8")
    assert scope({**request, "include_comment": True})["completion"] == scope(request)["completion"]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def upstream(run, stage, attempt, release, metrics):
    relative = f"attempts/{stage}/{attempt}"
    folder = run / relative
    head_sha = write(run / "accepted" / f"{stage}.json", {
        "schema_version": "accepted_stage_head.v1", "stage": stage, "accepted_attempt": attempt,
        "attempt_path": f"../{relative}", "effective_config": f"../{relative}/effective-config.json",
    })
    result_sha = write(folder / "stage-result.json", {
        "stage": stage, "attempt": attempt, "lens_id": "lens", "status": "success",
        "pipeline_release_id": release, "eligible_for_review": True, "gate_failures": [], "metrics": metrics,
    })
    decision_sha = write(folder / "decision.json", {
        "schema_version": "stage_decision.v1", "stage": stage, "attempt": attempt, "decision": "accept",
        "evidence_sha256": {"stage-result.json": result_sha},
    })
    return ({"stage": stage, "attempt": attempt, "path": f"{relative}/stage-result.json", "sha256": result_sha},
            {"attempt": attempt, "head_sha256": head_sha, "decision_sha256": decision_sha})


def quantiles(q16, q50, q84):
    return {"q16": q16, "q50": q50, "q84": q84}


@pytest.fixture
def accepted_lineage(accepted_m3):
    run, request, _ = accepted_m3
    source_release = "input-geometry.v1"
    old_stages = {}
    references = []
    staged_metrics = {
        "a": {"posterior_quantiles": {
            "center_x_mass": quantiles(-.01, .02, .06),
            "e1_lens_1": quantiles(.1, .3, .5),
            "theta_E": quantiles(.8, 1.2, 1.4),
            "lens_mge_amplitudes": {"q16": [1], "q50": [2], "q84": [3]},
        }},
        "b": {},
        "m0": {"m0_lambda_search": {"log_lambda_best": 2.0}},
        "m1": {"posterior_quantiles": {"log_lambda_reg": quantiles(2.2, 2.5, 2.8)}},
        "m2": {"posterior_quantiles": {
            "log_lambda_reg": quantiles(3.4, 4.2, 4.7), "adaptive_reg_rho": quantiles(1.2, 2.0, 3.4),
        }},
    }
    for stage, metrics in staged_metrics.items():
        stage_release = source_release if stage in ("a", "b") else PIPELINE_RELEASE_ID
        ref, snapshot = upstream(run, stage, 0, stage_release, metrics)
        references.append(ref)
        if stage in ("a", "b"):
            old_stages[stage] = snapshot
    manifest_path = run / "run-manifest.json"
    manifest = read(manifest_path)
    old_sha = write(run / "inherited-ab-source-manifest.json", {
        **manifest, "pipeline_release_id": source_release, "run_id": "old-run",
    })
    receipt_sha = write(run / "inherited-ab.json", {
        "schema_version": "inherited_ab.v1", "stages": old_stages,
        "source": {"run_id": "old-run", "pipeline_release_id": source_release, "manifest_sha256": old_sha},
        "target": {"run": str(run), "run_id": "run_id", "pipeline_release_id": PIPELINE_RELEASE_ID},
    })
    run_sha = write(manifest_path, {**manifest, "inherited_ab": {"path": "inherited-ab.json", "sha256": receipt_sha}})
    folder = run / "attempts/m3/0"
    display_path = folder / "display-manifest.json"
    display = read(display_path)
    display["upstream"] = references
    display["summary"]["path"] = "stage-result.json"
    display["run_manifest"] = {"path": "run-manifest.json", "sha256": run_sha}
    packet_path = folder / display["parameters"]["path"]
    packet = read(packet_path)
    packet["fixed_parameters"] = {
        "adaptive_reg_rho": 2.0, "log_lambda_reg": 4.2, "center_x_mass": .02, "other_fixed": 7.0,
    }
    display["parameters"]["sha256"] = write(packet_path, packet)
    write(display_path, display)
    return run, request, display_path


def test_final_parameters_are_from_the_latest_verified_optimization(accepted_lineage):
    _, request, _ = accepted_lineage
    result = scope(request)["completion"]
    assert {row["name"]: row for row in result["parameters"]} == {
        "center_x_mass": {"name": "center_x_mass", "stage": "a", **quantiles(-.01, .02, .06)},
        "e1_lens_1": {"name": "e1_lens_1", "stage": "a", **quantiles(.1, .3, .5)},
        "adaptive_reg_rho": {"name": "adaptive_reg_rho", "stage": "m2", **quantiles(1.2, 2.0, 3.4)},
        "log_lambda_reg": {"name": "log_lambda_reg", "stage": "m2", **quantiles(3.4, 4.2, 4.7)},
        "theta_E": {"name": "theta_E", "stage": "m3", **quantiles(.9, 1.0, 1.1)},
    }
    assert len(result["parameters"]) == 5
    assert result["fixed_parameters"] == {"other_fixed": 7.0}
    assert "point_parameters" not in result


def test_verified_stage_packet_can_supply_missing_quantiles(accepted_lineage):
    run, request, display_path = accepted_lineage
    display = read(display_path)
    reference, _ = upstream(run, "m2", 0, PIPELINE_RELEASE_ID, {
        "param_names": ["adaptive_reg_rho", "log_lambda_reg"],
        "posterior_quantiles": {"log_lambda_reg": quantiles(3.4, 4.2, 4.7)},
    })
    next(item for item in display["upstream"] if item["stage"] == "m2").update(reference)
    write(display_path, display)
    folder = run / "attempts/m2/0"
    relative = "display/StageM2_Parameters.json"
    digest = write(folder / relative, {
        "schema": "tinylens.stage-parameters.v1", "run": str(run), "lens_id": "lens",
        "stage": "m2", "attempt": 0, "distribution": {"kind": "weighted_posterior", "parameters": [
            {"name": "adaptive_reg_rho", **quantiles(1.2, 2.0, 3.4)},
            {"name": "log_lambda_reg", **quantiles(4.5, 5.0, 5.5)},
        ]},
    })
    write(folder / "display-manifest.json", {
        "run": str(run), "run_id": "run_id", "lens_id": "lens", "stage": "m2", "attempt": 0,
        "run_manifest": display["run_manifest"],
        "summary": {"path": "stage-result.json", "sha256": reference["sha256"]},
        "parameters": {"path": relative, "sha256": digest},
    })
    result = scope(request)["completion"]
    rows = {row["name"]: row for row in result["parameters"]}
    assert rows["adaptive_reg_rho"]["q50"] == 2.0
    assert rows["log_lambda_reg"]["q50"] == 4.2

    packet = folder / relative
    packet.write_bytes(packet.read_bytes() + b" ")
    result = scope(request)["completion"]
    assert not any(row["name"] == "adaptive_reg_rho" for row in result["parameters"])
    assert result["fixed_parameters"]["adaptive_reg_rho"] == 2.0


@pytest.mark.parametrize("change", ["foreign_path", "stale_result", "wrong_attempt", "rejected", "wrong_run", "receipt"])
def test_unverified_m3_lineage_keeps_only_m3_parameters(accepted_lineage, change):
    run, request, display_path = accepted_lineage
    display = read(display_path)
    m2 = next(ref for ref in display["upstream"] if ref["stage"] == "m2")
    if change == "foreign_path":
        m2["path"] = "../other-lens/attempts/m2/0/stage-result.json"
    elif change == "stale_result":
        m2["sha256"] = "f" * 64
    elif change == "wrong_attempt":
        m2.update(attempt=1, path="attempts/m2/1/stage-result.json")
    elif change == "rejected":
        decision = run / "attempts/m2/0/decision.json"
        write(decision, {**read(decision), "decision": "retry"})
    elif change == "wrong_run":
        display["run_manifest"]["sha256"] = "f" * 64
    elif change == "receipt":
        receipt = run / "inherited-ab.json"
        write(receipt, {**read(receipt), "schema_version": "stale"})
    write(display_path, display)
    result = scope(request)["completion"]
    assert result["parameters"] == [{"name": "theta_E", "stage": "m3", **quantiles(.9, 1.0, 1.1)}]
    assert result["fixed_parameters"]["adaptive_reg_rho"] == 2.0
    assert "point_parameters" not in result


@pytest.mark.parametrize("sampled_later", [False, True])
def test_m0_scan_point_is_displayed_only_if_not_optimized_again(accepted_lineage, sampled_later):
    run, request, display_path = accepted_lineage
    display = read(display_path)
    for stage in ("m1", "m2"):
        metrics = {"param_names": ["log_lambda_reg"]} if sampled_later and stage == "m2" else {}
        ref, _ = upstream(run, stage, 0, PIPELINE_RELEASE_ID, metrics)
        next(item for item in display["upstream"] if item["stage"] == stage).update(ref)
    write(display_path, display)
    result = scope(request)["completion"]
    assert not any(item["name"] == "log_lambda_reg" for item in result["parameters"])
    if sampled_later:
        assert "point_parameters" not in result
    else:
        assert result["point_parameters"] == [{"name": "log_lambda_reg", "stage": "m0", "value": 2.0}]
        assert "log_lambda_reg" not in result["fixed_parameters"]
