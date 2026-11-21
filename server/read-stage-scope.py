"""Resolve the run and verify a reported scientific decision against its evidence."""

import hashlib
import json
import re
import sys
from pathlib import Path


COMMENT_STAGES = frozenset(("preflight", "a", "b", "m0", "m1", "m2", "m3"))
M3_UPSTREAM_STAGES = ("a", "b", "m0", "m1", "m2")


def unique_object(pairs):
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError("Duplicate modeling comment key")
    return value


def document(path, root, *, object_pairs_hook=None):
    if not path.is_relative_to(root) or path.resolve(strict=True) != path or not path.is_file():
        raise ValueError("Stage reference leaves the reported run")
    with path.open("rb") as handle:
        data = handle.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("Stage record is too large")
    return json.loads(data, object_pairs_hook=object_pairs_hook), hashlib.sha256(data).hexdigest()


def accepted_result(run, root, stage, lens_id, attempt):
    head, head_sha = document(run / "accepted" / (stage + ".json"), root)
    index = head.get("accepted_attempt")
    if type(index) is not int or index < 0 or (attempt is not None and index != attempt):
        raise ValueError("Accepted attempt disagrees with the report")
    location = f"attempts/{stage}/{index}"
    if (head.get("schema_version"), head.get("stage"), head.get("attempt_path")) != (
        "accepted_stage_head.v1", stage, f"../{location}"
    ):
        raise ValueError("Invalid Accepted Stage Head")
    folder = run / location
    decision, decision_sha = document(folder / "decision.json", root)
    summary, summary_sha = document(folder / "stage-result.json", root)
    if ((decision.get("schema_version"), decision.get("stage"), decision.get("attempt"), decision.get("decision"))
            != ("stage_decision.v1", stage, index, "accept")
            or (summary.get("stage"), summary.get("attempt"), summary.get("lens_id"), summary.get("status"))
            != (stage, index, lens_id, "success")
            or decision.get("evidence_sha256", {}).get("stage-result.json") != summary_sha):
        raise ValueError("Acceptance evidence disagrees with the saved attempt")
    return index, folder, summary, summary_sha, decision_sha, head_sha


def finite(value):
    return type(value) in (int, float) and abs(value) <= sys.float_info.max


def parameter_name(name):
    return isinstance(name, str) and re.fullmatch(r"\w{1,80}", name)


def display_identity(display, run, manifest, summary):
    return (display["run"], display["run_id"], display["lens_id"], display["stage"], display["attempt"]) == (
        str(run), manifest["run_id"], summary["lens_id"], summary["stage"], summary["attempt"],
    )


def parameter_packet(display, run, folder, manifest, summary, result_sha):
    if not display_identity(display, run, manifest, summary) or display["summary"]["sha256"] != result_sha:
        raise ValueError("The parameter display does not identify this stage result")
    reference = display["parameters"]
    relative = f'display/Stage{summary["stage"].upper()}_Parameters.json'
    if reference["path"] != relative:
        raise ValueError("Unexpected parameter file")
    packet, digest = document(folder / relative, run)
    if (digest != reference["sha256"] or
            (packet["schema"], packet["run"], packet["lens_id"], packet["stage"], packet["attempt"]) != (
                "tinylens.stage-parameters.v1", str(run), summary["lens_id"], summary["stage"], summary["attempt"],
            )):
        raise ValueError("The parameter file does not identify this stage result")
    return packet


def inherited_attempts(run, manifest):
    reference = manifest["inherited_ab"]
    receipt, digest = document(run / "inherited-ab.json", run)
    if (reference != {"path": "inherited-ab.json", "sha256": digest}
            or receipt["schema_version"] != "inherited_ab.v1"
            or receipt["target"] != {"run": str(run), "run_id": manifest["run_id"],
                                     "pipeline_release_id": manifest["pipeline_release_id"]}):
        raise ValueError("Inheritance receipt belongs to a different run")
    source = receipt["source"]
    previous, previous_sha = document(run / "inherited-ab-source-manifest.json", run)
    if (previous_sha != source["manifest_sha256"] or previous.get("schema_version") != "lens_run_manifest.v1"
            or previous.get("run_id") != source["run_id"] or not source["run_id"]
            or source["run_id"] == manifest["run_id"]
            or previous.get("pipeline_release_id") != source["pipeline_release_id"]
            or any(previous.get(key) != manifest.get(key) for key in ("lens_dir", "input_geometry"))):
        raise ValueError("Inherited attempts belong to a different source run or input")
    return receipt["stages"], source["pipeline_release_id"]


def upstream_parameters(display, run, manifest, run_hash, m3, m3_sha):
    if (not display_identity(display, run, manifest, m3)
            or display["run_manifest"] != {"path": "run-manifest.json", "sha256": run_hash}
            or display["summary"] != {"path": "stage-result.json", "sha256": m3_sha}):
        raise ValueError("M3 display does not bind the accepted result and run")
    references = display["upstream"]
    if not isinstance(references, list) or sorted(item["stage"] for item in references) != sorted(M3_UPSTREAM_STAGES):
        raise ValueError("M3 display does not bind each upstream stage")
    snapshots, source_release = inherited_attempts(run, manifest) if "inherited_ab" in manifest else ({}, None)
    results = {}
    for entry in references:
        stage, attempt = entry["stage"], entry["attempt"]
        if type(attempt) is not int or attempt < 0:
            raise ValueError("Invalid upstream attempt")
        _, folder, summary, result_sha, decision_sha, head_sha = accepted_result(run, run, stage, m3["lens_id"], attempt)
        if (entry["path"] != f"attempts/{stage}/{attempt}/stage-result.json" or entry["sha256"] != result_sha
                or summary.get("eligible_for_review") is not True or summary.get("gate_failures")):
            raise ValueError("M3 display does not bind the accepted upstream result")
        inherited = source_release is not None and stage in ("a", "b")
        if inherited:
            snapshot = snapshots[stage]
            if (summary.get("pipeline_release_id") != source_release
                    or (snapshot["attempt"], snapshot["head_sha256"], snapshot["decision_sha256"]) != (
                        attempt, head_sha, decision_sha,
                    )):
                raise ValueError("M3 display does not bind the inherited accepted attempt")
        elif summary.get("pipeline_release_id", manifest.get("pipeline_release_id")) != manifest.get("pipeline_release_id"):
            raise ValueError("Upstream stage belongs to a different pipeline release")
        packet = {}
        if not inherited and stage != "b":
            try:
                upstream, _ = document(folder / "display-manifest.json", run)
                if upstream["run_manifest"] == display["run_manifest"]:
                    packet = parameter_packet(upstream, run, folder, manifest, summary, result_sha)
            except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError):
                pass
        results[stage] = (summary, packet)
    return results


def optimized_rows(stages):
    parameters, points = {}, {}
    for stage in ("a", "m0", "m1", "m2", "m3"):
        if stage not in stages:
            continue
        summary, packet = stages[stage]
        metrics = summary.get("metrics")
        metrics = metrics if isinstance(metrics, dict) else {}
        distribution = packet.get("distribution")
        distribution = distribution if isinstance(distribution, dict) else {}
        if stage == "m0":
            point = metrics.get("m0_lambda_search")
            point = point.get("log_lambda_best") if isinstance(point, dict) else None
            if not finite(point) and distribution.get("kind") == "evidence_scan":
                scan = distribution.get("scan")
                point = scan.get("log_lambda_best") if isinstance(scan, dict) else None
            if finite(point):
                name = "log_lambda_reg"
                parameters.pop(name, None)
                points[name] = {"name": name, "value": point, "stage": stage}
            continue
        posterior = metrics.get("posterior_quantiles")
        posterior = posterior if isinstance(posterior, dict) else {}
        candidates = distribution.get("parameters") if distribution.get("kind") == "weighted_posterior" else None
        optimized = metrics.get("param_names")
        optimized = {name for name in optimized if parameter_name(name)} if isinstance(optimized, list) else set()
        candidates = {row["name"]: row for row in candidates
                      if isinstance(row, dict) and parameter_name(row.get("name"))} if isinstance(candidates, list) else {}
        optimized.update(name for name in posterior if parameter_name(name))
        optimized.update(candidates)
        for name in sorted(optimized):
            parameters.pop(name, None)
            points.pop(name, None)
            for row in (posterior.get(name), candidates.get(name)):
                if not isinstance(row, dict):
                    continue
                q16, q50, q84 = (row.get(key) for key in ("q16", "q50", "q84"))
                if all(map(finite, (q16, q50, q84))) and q16 <= q50 <= q84:
                    parameters[name] = {"name": name, "q16": q16, "q50": q50, "q84": q84, "stage": stage}
                    break
    return parameters, points


def complete(run, folder, manifest, run_hash, summary, result_sha, decision_sha, attempt, include_comment):
    if summary.get("eligible_for_review") is not True or summary.get("gate_failures"):
        raise ValueError("Final parameters require a reviewed M3 result")
    result = {"run_id": manifest["run_id"], "lens_id": summary["lens_id"], "attempt": attempt}
    display, packet, stages = {}, {}, {}
    try:
        display, _ = document(folder / "display-manifest.json", run)
        packet = parameter_packet(display, run, folder, manifest, summary, result_sha)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError):
        pass
    try:
        stages = upstream_parameters(display, run, manifest, run_hash, summary, result_sha)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError):
        # Older or partially recorded runs still expose their verified M3-only values.
        pass
    stages["m3"] = (summary, packet)
    parameters, points = optimized_rows(stages)
    result["parameters"] = list(parameters.values())
    if points:
        result["point_parameters"] = list(points.values())
    fixed = packet.get("fixed_parameters")
    result["fixed_parameters"] = {
        key: value for key, value in fixed.items()
        if parameter_name(key) and finite(value) and key not in parameters and key not in points
    } if isinstance(fixed, dict) else {}
    if include_comment:
        try:
            comment, _ = document(run / "modeling-comment.json", run, object_pairs_hook=unique_object)
            identity = (comment["run_id"], comment["lens_id"], comment["stage"], comment["attempt"],
                        comment["result_sha256"], comment["decision_sha256"])
            if (type(comment["attempt"]) is int
                    and identity == (manifest["run_id"], summary["lens_id"], "m3", attempt, result_sha, decision_sha)):
                if comment["schema"] == "tinylens.modeling-comment.v1":
                    text = comment["text"]
                    if isinstance(text, str) and 0 < len(text.encode("utf-8")) <= 16_000:
                        result["comment"] = text
                elif comment["schema"] == "tinylens.modeling-comment.v2":
                    stage_comments = comment["stage_comments"]
                    if (isinstance(stage_comments, dict) and stage_comments.keys() == COMMENT_STAGES
                            and all(isinstance(text, str) and text == text.strip() and "\x00" not in text
                                    and 0 < len(text.encode("utf-8")) <= 2_000 and len(text.splitlines()) == 1
                                    for text in stage_comments.values())):
                        result["stage_comments"] = stage_comments
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            pass
    return result


def scope(request):
    root = Path(request["root"]).resolve(strict=True) / "output"
    run = Path(request["storage"])
    manifest_path = run / "run-manifest.json"
    manifest, run_hash = document(manifest_path, root)
    if manifest.get("schema_version") != "lens_run_manifest.v1" or Path(manifest["lens_dir"]).name != request["lens_id"]:
        raise ValueError("Reported stage has a different input lens")
    if request.get("input_lens") and manifest["lens_dir"] != request["input_lens"]:
        raise ValueError("The stage does not use the input directory confirmed for this lens")
    stage, attempt = request["stage"], request["attempt"]
    completion = None
    if request["accepted"]:
        if stage == "preflight":
            inspector, _ = document(run / "preflight/inspector.json", root)
            if inspector.get("lens_id") != request["lens_id"] or inspector.get("disposition") != "model":
                raise ValueError("Preflight acceptance record did not match")
        else:
            attempt, folder, summary, digest, decision_sha, _ = accepted_result(
                run, root, stage, request["lens_id"], attempt,
            )
            if stage == "m3" and request.get("completion"):
                completion = complete(run, folder, manifest, run_hash, summary, digest, decision_sha, attempt,
                                      request.get("include_comment"))
    elif request.get("human_review"):
        if stage == "preflight":
            inspector, _ = document(run / "preflight/inspector.json", root)
            if (inspector.get("lens_id"), inspector.get("disposition")) != (request["lens_id"], "human_review"):
                raise ValueError("Preflight Human Review record did not match")
        else:
            decision, _ = document(run / f"attempts/{stage}/{attempt}/decision.json", root)
            if (decision.get("schema_version"), decision.get("stage"), decision.get("attempt"), decision.get("decision")) != (
                "stage_decision.v1", stage, attempt, "human_review"
            ):
                raise ValueError("Human Review decision did not match the reported attempt")
    if (request["accepted"] or request.get("human_review")) and document(manifest_path, root)[1] != run_hash:
        raise ValueError("The run changed while verifying the scientific decision")
    return {"run_id": manifest.get("run_id"), "attempt": attempt,
            **({"completion": completion} if completion is not None else {})}


if __name__ == "__main__":
    print(json.dumps(scope(json.loads(sys.argv[1]))))
