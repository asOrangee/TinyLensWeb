"""Read saved results from the accepted head of one reported run."""
import io
import json
import sys
from contextlib import redirect_stdout
from hashlib import sha256
from pathlib import Path

from read_attempt_evidence import decision_evidence, verify_decision_file


def read_accepted(request):
    root = Path(request["root"]).resolve(strict=True) / "output"
    anchor = Path(request["path"])
    run = anchor.parent.parent
    if anchor.parent.name != "accepted" or not run.is_relative_to(root):
        raise ValueError("Accepted result is outside the reported run")

    snapshots = {}

    def read(path, limit=2 * 1024 * 1024):
        if path.resolve(strict=True) != path or not path.is_relative_to(run) or not path.is_file() or path.stat().st_size > limit:
            raise ValueError("Invalid accepted result dependency")
        raw = path.read_bytes()
        if len(raw) > limit:
            raise ValueError("Accepted result dependency exceeds size limit")
        return raw

    def checked(path):
        raw = read(path)
        if snapshots.setdefault(path, raw) != raw:
            raise ValueError("Accepted result changed")
        return raw

    manifest = json.loads(checked(run / "run-manifest.json"))
    if (manifest.get("schema_version") != "lens_run_manifest.v1"
            or Path(manifest["lens_dir"]).name != run.name or manifest.get("run_id") is not None):
        raise ValueError("This reader requires an older, unversioned run")

    def attempt(head_path, stage):
        head = json.loads(checked(head_path))
        index = head["accepted_attempt"]
        relative = f"../attempts/{stage}/{index}"
        if (head.get("schema_version"), head.get("stage"), head.get("attempt_path"), head.get("effective_config")) != (
            "accepted_stage_head.v1", stage, relative, relative + "/effective-config.json"
        ) or type(index) is not int or index < 0:
            raise ValueError("Invalid accepted attempt")
        folder = run / "attempts" / stage / str(index)
        decision = checked(folder / "decision.json")
        evidence = decision_evidence(decision, stage, index)
        if json.loads(decision).get("decision") != "accept":
            raise ValueError("Stage decision does not accept the attempt")
        summary = json.loads(verify_decision_file(evidence, "stage-result.json", checked(folder / "stage-result.json")))
        if (summary.get("lens_id"), summary.get("stage"), summary.get("attempt"), summary.get("status")) != (run.name, stage, index, "success"):
            raise ValueError("Accepted result does not identify this run and attempt")
        verify_decision_file(evidence, "effective-config.json", checked(folder / "effective-config.json"))
        return folder, index, evidence, summary

    def saved_mask(folder, index, evidence, summary):
        artifact = "artifacts/feature_mask.fits"
        if summary["artifacts"].get("feature_mask_fits") != artifact:
            raise ValueError("Accepted B does not declare a mask")
        mask = run_reader(MASK_READER, {
            "root": request["root"], "stage": "b", "attempt": index,
            "path": str(folder / "stage-result.json"), "kind": "summary",
        })
        if mask["sha256"] != evidence["stage-result.json"] or mask["mask_sha256"] != evidence.get("artifact:" + artifact):
            raise ValueError("Stage B mask no longer matches its accepted decision")
        return mask

    def model_entry(stage, accepted):
        folder, index, evidence, summary = accepted
        head = anchor.parent / f"{stage}.json"
        decision = folder / "decision.json"
        entry = {
            "summary": str(folder / "stage-result.json"), "attempt": index, "decision": str(decision),
            "acceptedHead": str(head), "acceptedHeadSha256": sha256(checked(head)).hexdigest(),
            "decisionSha256": sha256(checked(decision)).hexdigest(), "summarySha256": evidence["stage-result.json"],
        }
        if stage != "b":
            reference = f"artifacts/stage_{stage}.pkl"
            if summary["artifacts"].get("stage_pickle") != reference or not evidence.get("artifact:" + reference):
                raise ValueError("Accepted attempt has no bound saved model")
            entry.update(posterior=str(folder / reference), posteriorFromSummary=True)
        return entry

    anchor_stage, stage = anchor.stem, request["stage"]
    if anchor_stage not in ("a", "b", "m0", "m1") or (stage != anchor_stage and (anchor_stage, stage) != ("m0", "b")):
        raise ValueError("Invalid accepted stage report")
    folder, index, evidence, summary = attempt(anchor, anchor_stage)
    if request.get("anchorAttempt") is not None and index != request["anchorAttempt"]:
        raise ValueError("Accepted head now points to a different attempt")
    if stage != anchor_stage:
        # The reported M0 head identifies the active run. Its prerequisite B
        # has a separate accepted head and independently verified decision.
        folder, index, evidence, summary = attempt(anchor.parent / "b.json", "b")

    summary_path = folder / "stage-result.json"
    result = {"stage": stage, "report_path": str(anchor)}
    worker_request = {"root": request["root"], "stage": stage, "attempt": index}
    if request.get("attempt") is not None and index != request["attempt"]:
        raise ValueError("Accepted result does not match the selected attempt")
    saved = run_reader(RESULT_READER, {**worker_request, "path": str(folder / "decision.json"), "kind": "summary"})
    if saved["sha256"] != evidence["stage-result.json"]:
        raise ValueError("The stage summary no longer matches its acceptance decision")
    result["summary"] = {**saved, "path": str(summary_path)}

    declared_display = summary.get("display") or {}
    if declared_display.get("path") == "display-manifest.json":
        try:
            result["display"] = run_reader(DISPLAY_READER, {**worker_request, "run": str(run), "path": str(summary_path)})
        except (OSError, ValueError, KeyError):
            pass
    legacy = "display" not in result and declared_display.get("schema") != DISPLAY_SCHEMA
    if legacy and stage == "b":
        result["mask"] = {**saved_mask(folder, index, evidence, summary), "report_path": str(anchor)}
        try:
            result["foreground"] = model_entry("a", attempt(anchor.parent / "a.json", "a"))
        except (OSError, ValueError, KeyError):
            pass
    elif legacy:
        worker_request["path"] = str(folder / "decision.json")
        try:
            posterior = run_reader(RESULT_READER, {**worker_request, "kind": "declared_posterior"})
            if posterior["summary_sha256"] == saved["sha256"] and posterior["sha256"] == evidence.get(f"artifact:artifacts/stage_{stage}.pkl"):
                # The numerical model arrays have their own verified display path.
                posterior.pop("planes", None)
                result["posterior"] = {**posterior, "path": str(summary_path)}
        except (OSError, ValueError, KeyError):
            pass
        if stage == "a":
            result["foreground"] = model_entry(stage, (folder, index, evidence, summary))
        else:
            try:
                upstream = attempt(anchor.parent / "b.json", "b")
                b_settings = json.loads(checked(upstream[0] / "effective-config.json"))["settings"]
                if all(saved["config"]["settings"][key] == b_settings[key]
                       for key in ("pixel_scale_arcsec", "input_x_direction", "input_y_direction")):
                    mask = saved_mask(*upstream)
                    result["observation"] = mask["plane"]
                    foreground = attempt(anchor.parent / "a.json", "a")
                    result["reconstruction"] = {
                        "root": request["root"], "run": str(run), "stage": stage,
                        "inputSha256": mask["input_fits_sha256"], "domainSha256": mask["domain_sha256"],
                        "files": {
                            "a": model_entry("a", foreground), "b": model_entry("b", upstream),
                            stage: model_entry(stage, (folder, index, evidence, summary)),
                        },
                    }
            except (OSError, ValueError, KeyError):
                # The accepted scan is independent of optional image data.
                pass

    for path, raw in snapshots.items():
        if read(path) != raw:
            raise ValueError("Accepted result changed while reading")
    return result


def run_reader(source, request):
    original = sys.stdin
    output = io.StringIO()
    try:
        sys.stdin = io.StringIO(json.dumps(request) + "\n")
        with redirect_stdout(output):
            exec(compile(source, "<saved-result-reader>", "exec"), {"__name__": "__main__"})
    finally:
        sys.stdin = original
    return json.loads(output.getvalue())


print(json.dumps(read_accepted(json.loads(sys.stdin.readline())), allow_nan=False, separators=(",", ":")))
