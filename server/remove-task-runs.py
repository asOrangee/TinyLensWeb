"""Verify and remove explicitly reported lens runs without touching other results."""
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
from tempfile import TemporaryDirectory


STAGES = r"a|b|m0|m1|m2|m3|subhalo"
RUN_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
DIGEST = re.compile(r"[0-9a-f]{64}")
ATTEMPT_ANCHOR = re.compile(rf"attempts/({STAGES})/(0|[1-9]\d*)/(stage-result\.json|display-manifest\.json|display)")
ACCEPTANCE_ANCHOR = re.compile(rf"accepted/({STAGES})\.json")
QUARANTINE_PREFIX = ".tinylens-trash-"
CLAIM = "claim.json"
PAYLOAD = "run"
MAX_RECORD = 2 * 1024 * 1024


class Retain(ValueError):
    """A reason code that the task UI can display without reading private files."""


def safe_path(value, *, absolute):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise Retain("outside_scope")
    path = Path(value)
    if (str(path) != value or path.is_absolute() != absolute or ".." in path.parts
            or any(ord(character) < 32 or ord(character) == 127 for character in value)):
        raise Retain("outside_scope")
    return path


def directory(path, missing=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if missing:
            return None
        raise Retain("missing") from None
    if not stat.S_ISDIR(info.st_mode):
        raise Retain("unsafe_tree")
    return info


def record(path, reason):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise Retain(reason)
            raw = handle.read(MAX_RECORD + 1)
        if len(raw) > MAX_RECORD:
            raise Retain(reason)
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise Retain(reason)
        return value, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError, RecursionError) as error:
        raise Retain(reason) from error


def fingerprint(identity):
    raw = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def mounted_paths():
    # ismount cannot detect a Linux bind mount of a directory on the same device.
    try:
        lines = Path("/proc/self/mountinfo").read_text(errors="surrogateescape").splitlines()
    except FileNotFoundError:
        return set()
    paths = set()
    for line in lines:
        fields = line.split()
        if len(fields) > 5:
            paths.add(Path(re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])))
    return paths


def check_mount(path, device, mounts, info):
    if info.st_dev != device or path in mounts or os.path.ismount(path):
        raise Retain("unsafe_tree")


def within_scope(candidate, output, mounts):
    path = safe_path(candidate.get("path"), absolute=True)
    live = safe_path(candidate.get("runPath"), absolute=True)
    if not path.is_relative_to(output) or not live.is_relative_to(output):
        raise Retain("outside_scope")
    for item in (path, live):
        parts = item.relative_to(output).parts
        if len(parts) < 2:
            raise Retain("outside_scope")
        if "inputs" in parts or any(part.startswith(QUARANTINE_PREFIX) for part in parts):
            raise Retain("protected_path")
    if "_archive" in live.relative_to(output).parts:
        raise Retain("outside_scope")
    if path != live:
        prefix = live.name + "_old_"
        suffix = path.name.removeprefix(prefix)
        if (path.parent != live.parent / "_archive" or not path.name.startswith(prefix)
                or re.fullmatch(r"0|[1-9]\d*", suffix) is None):
            raise Retain("outside_scope")
    device = output.lstat().st_dev
    for ancestor in reversed(path.parents):
        if not ancestor.is_relative_to(output) or ancestor == output:
            continue
        info = directory(ancestor, missing=True)
        if info is None:
            break
        check_mount(ancestor, device, mounts, info)
        if (any(os.path.lexists(ancestor / name) for name in ("run-manifest.json", "input-provenance.json"))
                or os.path.lexists(ancestor / (ancestor.name + ".fits"))):
            raise Retain("protected_path")
    return path, live, device


def verify_tree(path, lens_id, device, mounts):
    pending = [path]
    while pending:
        parent = pending.pop()
        for child in parent.iterdir():
            info = child.lstat()
            if stat.S_ISDIR(info.st_mode):
                check_mount(child, device, mounts, info)
                if child.name == "inputs" or child.name == "_archive" or child.name.startswith(QUARANTINE_PREFIX):
                    raise Retain("protected_path")
                pending.append(child)
            elif (not stat.S_ISREG(info.st_mode) or info.st_dev != device or child in mounts):
                raise Retain("unsafe_tree")
            elif ((child.name == "run-manifest.json" and parent != path)
                  or child.name == "input-provenance.json"
                  or child.name in (lens_id + ".fits", parent.name + ".fits")):
                raise Retain("protected_path")


def valid_input(manifest, path, live, expected):
    try:
        source = safe_path(manifest.get("lens_dir"), absolute=True)
        if (source.name != live.name or (expected is not None and expected != str(source))
                or any(source.is_relative_to(item) or item.is_relative_to(source) for item in (path, live))
                or source.resolve(strict=True) != source or not source.is_dir()):
            raise Retain("protected_path")
        fits = source / (source.name + ".fits")
        if not stat.S_ISREG(fits.lstat().st_mode):
            raise Retain("protected_path")
        return str(source)
    except (OSError, RuntimeError):
        raise Retain("protected_path") from None


def display_anchor(relative):
    match = ATTEMPT_ANCHOR.fullmatch(relative)
    if relative == "preflight/display-manifest.json":
        return "preflight", None
    if match and match[3] == "display-manifest.json":
        return match[1], int(match[2])
    return None


def pinned_display(path, live, run_id, manifest_sha, proofs):
    for proof in proofs:
        if not isinstance(proof, dict) or not isinstance(proof.get("path"), str):
            continue
        relative = proof["path"]
        scope = display_anchor(relative)
        if scope is None:
            continue
        try:
            display, digest = record(path / relative, "unverified_legacy")
        except Retain:
            continue
        if (proof.get("sha256") == digest
                and display.get("schema") in {f"tinylens.stage-display.v{v}" for v in (1, 2, 3)}
                and (display.get("run"), display.get("run_id"), display.get("lens_id"),
                     display.get("stage"), display.get("attempt")) == (str(live), run_id, live.name, *scope)
                and display.get("run_manifest") == {"path": "run-manifest.json", "sha256": manifest_sha}):
            return True
    return False


def legacy_anchor(path, live, lens, manifest_sha, anchors):
    for relative in anchors:
        if relative == "run-manifest.json" and path != live:
            return True
        attempt = ATTEMPT_ANCHOR.fullmatch(relative)
        accepted = ACCEPTANCE_ANCHOR.fullmatch(relative)
        try:
            if relative in ("preflight/inspection.json", "preflight/inspector.json"):
                packet, _ = record(path / relative, "unverified_legacy")
                if packet.get("lens_id") == live.name and (
                    (relative.endswith("/inspection.json") and packet.get("lens_dir") == lens
                     and str(packet.get("schema_version", "")).startswith("inspection_packet.v"))
                    or (relative.endswith("/inspector.json") and packet.get("disposition") in
                        ("model", "human_review", "skip"))
                ):
                    return True
            elif accepted:
                stage = accepted[1]
                head, _ = record(path / relative, "unverified_legacy")
                index = head.get("accepted_attempt")
                if (type(index) is not int or index < 0
                        or head.get("schema_version") != "accepted_stage_head.v1" or head.get("stage") != stage):
                    continue
                folder = f"attempts/{stage}/{index}"
                if head.get("attempt_path") != "../" + folder:
                    continue
                summary, sha = record(path / folder / "stage-result.json", "unverified_legacy")
                decision, _ = record(path / folder / "decision.json", "unverified_legacy")
                if ((summary.get("lens_id"), summary.get("stage"), summary.get("attempt"), summary.get("status"))
                        == (live.name, stage, index, "success")
                        and (decision.get("schema_version"), decision.get("stage"), decision.get("attempt"),
                             decision.get("decision")) == ("stage_decision.v1", stage, index, "accept")
                        and isinstance(decision.get("evidence_sha256"), dict)
                        and decision["evidence_sha256"].get("stage-result.json") == sha):
                    return True
            elif attempt and attempt[3] == "stage-result.json":
                summary, _ = record(path / relative, "unverified_legacy")
                if (summary.get("lens_id"), summary.get("stage"), summary.get("attempt")) == (
                    live.name, attempt[1], int(attempt[2]),
                ):
                    return True
            elif scope := display_anchor(relative if not relative.endswith("/display")
                                         else relative + "-manifest.json"):
                file = relative if not relative.endswith("/display") else relative + "-manifest.json"
                display, _ = record(path / file, "unverified_legacy")
                if (display.get("run"), display.get("lens_id"), display.get("stage"), display.get("attempt"),
                        display.get("run_manifest")) == (
                            str(live), live.name, *scope, {"path": "run-manifest.json", "sha256": manifest_sha},
                        ):
                    return True
        except Retain:
            continue
    return False


@contextmanager
def idle_run(path, batch_root):
    locks = [batch_root / ".lens-batch.lock"]
    for folder in (path / ".operations", path / ".lens-control"):
        if directory(folder, missing=True):
            locks.extend(folder.glob("*.lock"))
    with ExitStack() as stack:
        for lock in locks:
            try:
                descriptor = os.open(lock, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
            except FileNotFoundError:
                continue
            with_file = stack.enter_context(os.fdopen(descriptor, "rb+"))
            if not stat.S_ISREG(os.fstat(with_file.fileno()).st_mode):
                raise Retain("unsafe_tree")
            try:
                fcntl.flock(with_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Retain("active") from None
        yield


def run_identity(path, live, candidate, device, mounts):
    info = directory(path)
    check_mount(path, device, mounts, info)
    verify_tree(path, live.name, device, mounts)
    manifest, manifest_sha = record(path / "run-manifest.json", "invalid_manifest")
    release = manifest.get("pipeline_release_id")
    if (manifest.get("schema_version") != "lens_run_manifest.v1"
            or not isinstance(release, str) or not release.strip()
            or any(os.path.lexists(path / name) for name in ("cache", "reviews", "pipeline.py"))):
        raise Retain("invalid_manifest")
    lens = valid_input(manifest, path, live, candidate.get("inputPath"))
    run_id = manifest.get("run_id")
    if "run_id" in manifest:
        if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
            raise Retain("invalid_manifest")
        if run_id not in candidate["runIds"] and not (
            candidate["legacy"] and pinned_display(path, live, run_id, manifest_sha, candidate.get("proofs", []))
        ):
            raise Retain("run_mismatch")
    elif not candidate["legacy"] or not legacy_anchor(path, live, lens, manifest_sha, candidate["anchors"]):
        raise Retain("unverified_legacy")
    return {"path": str(path), "run_path": str(live), "device": info.st_dev, "inode": info.st_ino,
            "manifest_sha256": manifest_sha, "input": lens, "run_id": run_id}


def response(identity, digest):
    value = {"path": identity["path"], "fingerprint": digest}
    if identity.get("run_id") is not None:
        value["runId"] = identity["run_id"]
    return value


def quarantine_identity(quarantine, path, live, candidate, digest, device, mounts):
    info = directory(quarantine, missing=True)
    if info is None:
        return None
    check_mount(quarantine, device, mounts, info)
    contents = {item.name for item in quarantine.iterdir()}
    if not contents:
        return None
    if CLAIM not in contents or not contents <= {CLAIM, PAYLOAD}:
        raise Retain("changed")
    identity, _ = record(quarantine / CLAIM, "changed")
    if (fingerprint(identity) != digest or identity.get("path") != str(path)
            or identity.get("run_path") != str(live)
            or (candidate.get("inputPath") is not None and identity.get("input") != candidate["inputPath"])
            or (identity.get("run_id") not in candidate["runIds"]
                and not (candidate["legacy"] and (identity.get("run_id") is None or candidate.get("proofs"))))):
        raise Retain("changed")
    return identity


def remove_quarantine(quarantine, identity, device, mounts, *, remove):
    if remove:
        mounts = mounts | mounted_paths()
    check_mount(quarantine, device, mounts, directory(quarantine))
    payload = quarantine / PAYLOAD
    info = directory(payload, missing=True)
    if info is not None:
        check_mount(payload, device, mounts, info)
        if (info.st_dev, info.st_ino) != (identity["device"], identity["inode"]):
            raise Retain("changed")
        live = Path(identity["run_path"])
        verify_tree(payload, live.name, device, mounts)
        with idle_run(payload, live.parent):
            if remove:
                if not shutil.rmtree.avoids_symlink_attacks:
                    raise Retain("unsafe_tree")
                shutil.rmtree(payload)
    if remove:
        (quarantine / CLAIM).unlink()
        quarantine.rmdir()


def handle(candidate, output, mounts, delete):
    path, live, device = within_scope(candidate, output, mounts)
    if (not isinstance(candidate.get("runIds"), list)
            or not all(isinstance(item, str) and RUN_ID.fullmatch(item) for item in candidate["runIds"])
            or type(candidate.get("legacy")) is not bool
            or not isinstance(candidate.get("anchors"), list)
            or not all(isinstance(item, str) for item in candidate["anchors"])
            or not isinstance(candidate.get("proofs", []), list)):
        raise Retain("outside_scope")
    expected = candidate.get("fingerprint")
    if (delete or expected is not None) and (not isinstance(expected, str) or not DIGEST.fullmatch(expected)):
        raise Retain("changed")
    quarantine = path.parent / (QUARANTINE_PREFIX + expected) if expected else None
    if quarantine is not None:
        previous = quarantine_identity(quarantine, path, live, candidate, expected, device, mounts)
        if previous is not None and (os.path.lexists(quarantine / PAYLOAD) or not os.path.lexists(path)):
            remove_quarantine(quarantine, previous, device, mounts, remove=delete)
            return response(previous, expected)
    if directory(path, missing=True) is None:
        if delete:
            return response({"path": str(path)}, expected)
        raise Retain("missing")
    with idle_run(path, live.parent):
        identity = run_identity(path, live, candidate, device, mounts)
        digest = fingerprint(identity)
        if expected is not None and expected != digest:
            raise Retain("changed")
        if delete:
            assert quarantine is not None
            if previous is None:
                with TemporaryDirectory(prefix=QUARANTINE_PREFIX, dir=path.parent) as temporary:
                    prepared = Path(temporary) / "entry"
                    prepared.mkdir(mode=0o700)
                    (prepared / CLAIM).write_text(json.dumps(identity), encoding="utf-8")
                    prepared.rename(quarantine)
            # Use directory descriptors and check the inode again at the rename.
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            parent_fd = os.open(path.parent, flags)
            try:
                quarantine_fd = os.open(quarantine.name, flags, dir_fd=parent_fd)
                try:
                    info = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
                    if (info.st_dev, info.st_ino) != (identity["device"], identity["inode"]):
                        raise Retain("changed")
                    os.rename(path.name, PAYLOAD, src_dir_fd=parent_fd, dst_dir_fd=quarantine_fd)
                finally:
                    os.close(quarantine_fd)
            finally:
                os.close(parent_fd)
    if delete:
        remove_quarantine(quarantine, identity, device, mounts, remove=True)
    return response(identity, digest)


def execute(request):
    if (not isinstance(request, dict) or request.get("mode") not in ("preview", "delete")
            or not isinstance(request.get("candidates"), list)
            or not all(isinstance(candidate, dict) for candidate in request["candidates"])):
        raise ValueError("Invalid task-run removal request")
    workspace = safe_path(request.get("root"), absolute=True)
    if workspace.parent == workspace:
        raise ValueError("Invalid task-run workspace")
    output = workspace / "output"
    for part in (*reversed(output.parents), output):
        directory(part)
    mounts = mounted_paths()
    delete = request["mode"] == "delete"
    result = {"runs": [], "retained": []}
    for candidate in request["candidates"]:
        try:
            result["runs"].append(handle(candidate, output, mounts, delete))
        except Retain as error:
            result["retained"].append({"path": candidate.get("path"), "reason": str(error)})
        except (OSError, RuntimeError):
            result["retained"].append({"path": candidate.get("path"), "reason": "delete_failed" if delete else "unsafe_tree"})
    return result


if __name__ == "__main__":
    print(json.dumps(execute(json.load(sys.stdin))))
