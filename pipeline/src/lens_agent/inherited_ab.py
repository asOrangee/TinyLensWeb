"""Import the frozen, accepted A/B inputs for a distinct M0–M3 run."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import numpy as np
from astropy.io import fits

from .configuration import (
    PIPELINE_RELEASE_ID,
    EffectiveConfig,
    InputGeometry,
    archiveable_run_root,
    validate_run_manifest,
)
from .inspection.euclid import binary_mask_sha256
from .models import StageName
from .result_paths import require_lens_local_tree, resolve_current_lens_result_path

SOURCE_RELEASE = "input-geometry.v1"
TARGET_RELEASE = "source-reconstruction.v1"
RECORD_FILE = "inherited-ab.json"
SOURCE_MANIFEST_FILE = "inherited-ab-source-manifest.json"
REQUIRED_PREFLIGHT = ("inspection.json", "inspector.json", "modeling_mask.fits", "segmentation.fits")
REQUIRED_ARTIFACTS = {
    StageName.A: ("artifacts/stage_a.pkl", "artifacts/stage_a_predicted_image_family.json"),
    StageName.B: ("artifacts/feature_mask.fits",),
}


def _object(path: Path) -> dict:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read inherited-run evidence: {path.name}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Inherited-run evidence must be an object: {path.name}")
    return value


def _hash(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Invalid inherited-run evidence file: {path.name}")
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _expect_hash(path: Path, digest: str) -> None:
    if _hash(path) != digest:
        raise ValueError(f"Inherited-run evidence changed: {path.name}")


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _input_path(manifest: dict, lens_id: str) -> Path:
    lens = Path(manifest["lens_dir"])
    if not lens.is_absolute() or lens.name != lens_id or lens.resolve() != lens:
        raise ValueError("Inherited run requires its original, canonical input directory")
    return lens / f"{lens_id}.fits"


def _locations(run: Path, stage: StageName) -> tuple[Path, Path, int]:
    head = run / "accepted" / f"{stage.value}.json"
    value = _object(head)
    attempt = value.get("accepted_attempt")
    if type(attempt) is not int or attempt < 0 or (stage == StageName.A and attempt != 0):
        raise ValueError("Inheritance requires Stage A attempt 0 and an accepted Stage B attempt")
    relative = f"attempts/{stage.value}/{attempt}"
    if (value.get("schema_version"), value.get("stage"), value.get("attempt_path"),
            value.get("effective_config")) != (
                "accepted_stage_head.v1", stage.value, f"../{relative}",
                f"../{relative}/effective-config.json"):
        raise ValueError(f"Invalid source Stage {stage.value.upper()} Accepted Head")
    return head, run / relative, attempt


def _old_config(path: Path, geometry: InputGeometry) -> EffectiveConfig:
    raw = _object(path)
    if raw.get("pipeline_release_id") != SOURCE_RELEASE:
        raise ValueError("Inherited A/B configuration does not belong to the source Pipeline Release")
    config = EffectiveConfig.model_validate_json(json.dumps({
        **raw, "pipeline_release_id": TARGET_RELEASE,
    }), strict=True)
    if InputGeometry.from_settings(config.settings) != geometry or config.settings.source_grid_level != 0:
        raise ValueError("Inherited A/B configuration disagrees with the input geometry or M0 grid level")
    return config


def _stage_snapshot(run: Path, stage: StageName, geometry: InputGeometry) -> dict:
    from .attempts import manifest_paths, validate_decision_review_evidence

    head, root, attempt = _locations(run, stage)
    decision_path = root / "decision.json"
    decision = _object(decision_path)
    marker = _object(root / "stage-execution.json")
    summary = _object(root / "stage-result.json")
    expected_identity = (stage.value, attempt)
    if (decision.get("schema_version"), decision.get("stage"), decision.get("attempt"),
            decision.get("decision")) != ("stage_decision.v1", *expected_identity, "accept"):
        raise ValueError(f"Inherited Stage {stage.value.upper()} lacks a canonical accept decision")
    if (marker.get("schema_version"), marker.get("stage"), marker.get("attempt"),
            marker.get("pipeline_release_id"), marker.get("status")) != (
                "stage_execution.v1", *expected_identity, SOURCE_RELEASE, "started"):
        raise ValueError("Inherited Stage execution marker has a different identity")
    if ((summary.get("lens_id"), summary.get("stage"), summary.get("attempt"),
            summary.get("pipeline_release_id"), summary.get("status")) != (
                run.name, *expected_identity, SOURCE_RELEASE, "success")
            or summary.get("eligible_for_review") is not True or summary.get("gate_failures") != []):
        raise ValueError("Inherited Stage must have passed its original Hard Gate")
    validate_decision_review_evidence(root, decision)
    recorded = manifest_paths(root)
    artifacts = summary.get("artifacts")
    if not isinstance(artifacts, dict) or not all(isinstance(value, str) for value in artifacts.values()):
        raise ValueError("Inherited Stage has an invalid artifact map")
    declared = set(artifacts.values())
    if not set(REQUIRED_ARTIFACTS[stage]) <= declared <= recorded:
        raise ValueError("Inherited Stage artifacts are missing from accepted evidence")
    _old_config(root / "effective-config.json", geometry)
    return {
        "attempt": attempt,
        "head_sha256": _hash(head),
        "decision_sha256": _hash(decision_path),
        "display_manifest_sha256": _hash(root / "display-manifest.json"),
    }


def _display_evidence(source: Path, manifest: dict, stages: dict, input_digest: str,
                      preflight: dict[str, str], source_manifest_digest: str) -> None:
    """Bind current FITS/mask bytes to the manifests recorded at A/B execution."""
    source_fits = _input_path(manifest, source.name)
    bound_preflight = set()
    for tag, snapshot in stages.items():
        attempt = snapshot["attempt"]
        root = source / "attempts" / tag / str(attempt)
        display = _object(root / "display-manifest.json")
        if (display.get("run"), display.get("run_id"), display.get("lens_id"),
                display.get("stage"), display.get("attempt")) != (
                    str(source), manifest.get("run_id"), source.name, tag, attempt):
            raise ValueError("Inherited Stage display is not bound to the original run")
        if (display["input"].get("path"), display["input"].get("sha256")) != (str(source_fits), input_digest):
            raise ValueError("The current FITS does not match the inherited Stage input checksum")
        for key, name, digest in (
            ("run_manifest", "run-manifest.json", source_manifest_digest),
            ("summary", "stage-result.json", _hash(root / "stage-result.json")),
            ("configuration", "effective-config.json", _hash(root / "effective-config.json")),
        ):
            if display.get(key) != {"path": name, "sha256": digest}:
                raise ValueError(f"Inherited Stage display has a different {key}")
        if tag == "b":
            a_attempt = stages["a"]["attempt"]
            a_summary = f"attempts/a/{a_attempt}/stage-result.json"
            if display.get("upstream") != [{
                "stage": "a", "attempt": a_attempt, "path": a_summary,
                "sha256": _hash(source / a_summary),
            }]:
                raise ValueError("Inherited Stage B was not executed with the accepted Stage A")
        references = dict(display.get("mask_sources", {}))
        if "modeling_mask" in display:
            if references.get("modeling_mask.fits", display["modeling_mask"]) != display["modeling_mask"]:
                raise ValueError("Inherited Stage declares conflicting Preflight modeling masks")
            references["modeling_mask.fits"] = display["modeling_mask"]
        for name, digest in preflight.items():
            if name in references:
                if references[name] != {"path": f"preflight/{name}", "sha256": digest}:
                    raise ValueError(f"Preflight {name} does not match the inherited Stage evidence")
                bound_preflight.add(name)
    if "modeling_mask.fits" not in bound_preflight:
        raise ValueError("No inherited Stage binds the original Preflight modeling mask")


def _preflight_evidence(
    source: Path, manifest: dict, geometry: InputGeometry, input_digest: str,
) -> dict[str, str]:
    folder = source / "preflight"
    packet = _object(folder / "inspection.json")
    inspector = _object(folder / "inspector.json")
    if (packet.get("lens_id"), packet.get("lens_dir"), packet.get("euclid_contamination")) != (
            source.name, manifest["lens_dir"], manifest.get("euclid_contamination")):
        raise ValueError("Preflight inspection belongs to a different input")
    if InputGeometry.model_validate(packet.get("input_geometry"), strict=True) != geometry:
        raise ValueError("Preflight inspection has a different input geometry")
    if inspector.get("lens_id") != source.name or inspector.get("disposition") != "model":
        raise ValueError("Inheritance requires the original Preflight model decision")
    preflight = {name: _hash(folder / name) for name in REQUIRED_PREFLIGHT}
    labels = fits.getdata(folder / "segmentation.fits")
    mask, header = fits.getdata(folder / "modeling_mask.fits", header=True)
    if (labels.ndim != 2 or labels.dtype.kind not in "iu" or np.any(labels < 0)
            or mask.shape != labels.shape or packet.get("image_shape") != list(labels.shape)
            or header.get("MODELRAD") != 4.0):
        raise ValueError("The original Preflight masks have inconsistent image geometry")
    ids = inspector.get("contaminant_ids")
    if not isinstance(ids, list) or any(type(value) is not int or value <= 0 for value in ids):
        raise ValueError("Invalid original Inspector contaminant IDs")
    euclid = manifest.get("euclid_contamination")
    if euclid is not None:
        contaminants = labels > 0
        if (ids or euclid.get("image_shape") != list(labels.shape)
                or euclid.get("input_fits_sha256") != input_digest
                or euclid.get("canonical_mask_sha256") != binary_mask_sha256(contaminants)):
            raise ValueError("The original Euclid contamination mask no longer matches Preflight")
    else:
        if not np.isin(ids, labels).all():
            raise ValueError("Inspector contaminant IDs do not match the original segmentation")
        contaminants = np.isin(labels, ids)
    yy, xx = np.indices(labels.shape)
    ny, nx = labels.shape
    outside_aperture = np.hypot(xx - (nx - 1) / 2, yy - (ny - 1) / 2) > 4.0 / geometry.pixel_scale_arcsec
    if not np.array_equal(mask, outside_aperture | contaminants) or mask.all():
        raise ValueError("The original modeling mask does not match the Inspector decision and aperture")
    return preflight


def validate_inherited_ab_source(source: Path) -> dict:
    """Read only the source run and verify that its frozen inputs can be inherited."""
    source = archiveable_run_root(source)
    if PIPELINE_RELEASE_ID != TARGET_RELEASE:
        raise ValueError("A/B inheritance is specific to the source reconstruction Pipeline Release")
    original = source / "run-manifest.json"
    source_manifest_digest = _hash(original)
    manifest = _object(original)
    if manifest.get("pipeline_release_id") != SOURCE_RELEASE or "inherited_ab" in manifest:
        raise ValueError("A/B inheritance requires an original input-geometry.v1 run")
    geometry = InputGeometry.model_validate(manifest.get("input_geometry"), strict=True)
    source_fits = _input_path(manifest, source.name)
    input_digest = _hash(source_fits)
    preflight = _preflight_evidence(source, manifest, geometry, input_digest)
    stages = {stage.value: _stage_snapshot(source, stage, geometry) for stage in REQUIRED_ARTIFACTS}
    _display_evidence(source, manifest, stages, input_digest, preflight, source_manifest_digest)
    _expect_hash(original, source_manifest_digest)
    return {
        "source": {"run": str(source), "run_id": manifest.get("run_id"),
                   "pipeline_release_id": SOURCE_RELEASE, "manifest_sha256": source_manifest_digest},
        "input": {"path": str(source_fits), "sha256": input_digest},
        "preflight": preflight,
        "stages": stages,
    }


def prepare_inherited_ab(source: Path, output_dir: Path) -> Path:
    """Verify and atomically publish a new run seeded by accepted upstream evidence."""
    source = resolve_current_lens_result_path(source)
    output_dir = resolve_current_lens_result_path(output_dir)
    if (output_dir.name != source.name or output_dir.parent == source.parent
            or output_dir.parent.parent != source.parent.parent or output_dir.exists()):
        raise ValueError("Choose an unused lens directory in a sibling batch with the original lens ID")
    evidence = validate_inherited_ab_source(source)
    original = source / "run-manifest.json"
    run_id = uuid4().hex
    record = {
        "schema_version": "inherited_ab.v1",
        **evidence,
        "target": {"run": str(output_dir), "run_id": run_id, "pipeline_release_id": TARGET_RELEASE},
    }
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".inherited-ab-", dir=output_dir.parent) as temporary:
        prepared = Path(temporary) / output_dir.name
        (prepared / "preflight").mkdir(parents=True)
        (prepared / "accepted").mkdir()
        shutil.copyfile(original, prepared / SOURCE_MANIFEST_FILE)
        _expect_hash(prepared / SOURCE_MANIFEST_FILE, evidence["source"]["manifest_sha256"])
        manifest = _object(prepared / SOURCE_MANIFEST_FILE)
        geometry = InputGeometry.model_validate(manifest.get("input_geometry"), strict=True)
        for name, digest in evidence["preflight"].items():
            relative = Path("preflight") / name
            shutil.copyfile(source / relative, prepared / relative)
            _expect_hash(prepared / relative, digest)
        for stage in REQUIRED_ARTIFACTS:
            head, root, _ = _locations(source, stage)
            shutil.copyfile(head, prepared / head.relative_to(source))
            shutil.copytree(root, prepared / root.relative_to(source), symlinks=True)
            require_lens_local_tree(prepared)
            if _stage_snapshot(prepared, stage, geometry) != evidence["stages"][stage.value]:
                raise ValueError("The accepted source attempt changed during inheritance")
        record_path = prepared / RECORD_FILE
        _write(record_path, record)
        _write(prepared / "run-manifest.json", {
            **manifest, "run_id": run_id, "pipeline_release_id": TARGET_RELEASE,
            "inherited_ab": {"path": RECORD_FILE, "sha256": _hash(record_path)},
        })
        _expect_hash(original, evidence["source"]["manifest_sha256"])
        _expect_hash(Path(evidence["input"]["path"]), evidence["input"]["sha256"])
        if output_dir.exists() or output_dir.is_symlink():
            raise ValueError("The new output directory already exists")
        os.rename(prepared, output_dir)
    return output_dir


def inherited_stage_config(output_dir: Path, stage: StageName, config_path: Path) -> EffectiveConfig | None:
    """Read an imported A/B configuration without rewriting its adjudicated bytes."""
    if stage not in REQUIRED_ARTIFACTS:
        return None
    output_dir = output_dir.resolve()
    manifest = validate_run_manifest(output_dir)
    if "inherited_ab" not in manifest:
        return None
    reference = manifest["inherited_ab"]
    if not isinstance(reference, dict) or reference.get("path") != RECORD_FILE:
        raise ValueError("Invalid inherited A/B record reference")
    record_path = output_dir / RECORD_FILE
    _expect_hash(record_path, reference.get("sha256"))
    record = _object(record_path)
    if record.get("schema_version") != "inherited_ab.v1" or record.get("target") != {
        "run": str(output_dir), "run_id": manifest.get("run_id"), "pipeline_release_id": TARGET_RELEASE,
    }:
        raise ValueError("Inherited A/B record belongs to a different run")
    origin = record["source"]
    original = output_dir / SOURCE_MANIFEST_FILE
    _expect_hash(original, origin["manifest_sha256"])
    old = _object(original)
    if (old.get("pipeline_release_id"), origin.get("pipeline_release_id"), old.get("run_id")) != (
            SOURCE_RELEASE, SOURCE_RELEASE, origin.get("run_id")):
        raise ValueError("Inherited A/B record disagrees with its original run")
    if any(old.get(key) != manifest.get(key) for key in ("lens_dir", "input_geometry", "euclid_contamination")):
        raise ValueError("Inherited A/B run changed its original input or geometry")
    input_fits = _input_path(manifest, output_dir.name)
    if record["input"].get("path") != str(input_fits):
        raise ValueError("Inherited A/B record names a different input FITS")
    _expect_hash(input_fits, record["input"]["sha256"])
    digests = record["preflight"]
    if set(digests) != set(REQUIRED_PREFLIGHT):
        raise ValueError("Invalid inherited Preflight file list")
    for name, digest in digests.items():
        _expect_hash(output_dir / "preflight" / name, digest)
    geometry = InputGeometry.model_validate(manifest.get("input_geometry"), strict=True)
    head, root, attempt = _locations(output_dir, stage)
    snapshot = record["stages"][stage.value]
    if snapshot.get("attempt") != attempt or config_path.resolve() != root / "effective-config.json":
        raise ValueError("Inherited A/B configuration does not identify the accepted attempt")
    _expect_hash(head, snapshot["head_sha256"])
    _expect_hash(root / "decision.json", snapshot["decision_sha256"])
    _expect_hash(root / "display-manifest.json", snapshot["display_manifest_sha256"])
    decision = _object(root / "decision.json")
    _expect_hash(config_path, decision["evidence_sha256"]["effective-config.json"])
    return _old_config(config_path, geometry)
