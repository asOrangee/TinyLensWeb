"""Resolve the run and, for an explicit acceptance report, its verified head."""

import hashlib
import json
import sys
from pathlib import Path


def document(path, root):
    if not path.is_relative_to(root) or path.resolve(strict=True) != path or not path.is_file():
        raise ValueError("Stage reference leaves the reported run")
    with path.open("rb") as handle:
        data = handle.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("Stage record is too large")
    return json.loads(data), hashlib.sha256(data).hexdigest()


def scope(request):
    root = Path(request["root"]).resolve(strict=True) / "output"
    run = Path(request["storage"])
    manifest_path = run / "run-manifest.json"
    manifest, run_hash = document(manifest_path, root)
    if manifest.get("schema_version") != "lens_run_manifest.v1" or Path(manifest["lens_dir"]).name != request["lens_id"]:
        raise ValueError("Reported stage has a different input lens")
    stage, attempt = request["stage"], request["attempt"]
    if request["accepted"]:
        if stage == "preflight":
            inspector, _ = document(run / "preflight/inspector.json", root)
            if inspector.get("lens_id") != request["lens_id"] or inspector.get("disposition") != "model":
                raise ValueError("Preflight acceptance record did not match")
        else:
            head, _ = document(run / "accepted" / (stage + ".json"), root)
            index = head.get("accepted_attempt")
            if type(index) is not int or index < 0 or (attempt is not None and index != attempt):
                raise ValueError("Accepted attempt disagrees with the report")
            location = f"attempts/{stage}/{index}"
            if (head.get("schema_version"), head.get("stage"), head.get("attempt_path")) != (
                "accepted_stage_head.v1", stage, f"../{location}"
            ):
                raise ValueError("Invalid Accepted Stage Head")
            decision, _ = document(run / location / "decision.json", root)
            summary, digest = document(run / location / "stage-result.json", root)
            if ((decision.get("schema_version"), decision.get("stage"), decision.get("attempt"), decision.get("decision"))
                    != ("stage_decision.v1", stage, index, "accept")
                    or (summary.get("stage"), summary.get("attempt"), summary.get("lens_id"), summary.get("status"))
                    != (stage, index, request["lens_id"], "success")
                    or decision.get("evidence_sha256", {}).get("stage-result.json") != digest):
                raise ValueError("Acceptance evidence disagrees with the saved attempt")
            attempt = index
        if document(manifest_path, root)[1] != run_hash:
            raise ValueError("The run changed while verifying acceptance")
    return {"run_id": manifest.get("run_id"), "attempt": attempt}


if __name__ == "__main__":
    print(json.dumps(scope(json.loads(sys.argv[1]))))
