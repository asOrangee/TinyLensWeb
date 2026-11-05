from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import pickle
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
from astropy.io import fits

from .attempts import (
    attempt_dir, validate_decision_review_evidence, _prepare_attempt, configuration_bundle,
)
from .operations import (
    attempt_lock, PreparationBlocked, record_preparation_error,
)
from .configuration import EffectiveConfig, PipelineConfig, PIPELINE_RELEASE_ID, validated_run_root, validate_config_geometry
from .data import load_lens_data
from .stage_input import check_stage_input
from .modeling.summaries import stage_summary
from .modeling.morphology_audit import validate_stage_b_morphology_audit
from .modeling.source_grid import validate_source_grid_spec
from .modeling.predicted_image_family import (
    position_likelihood_from_family,
    validate_predicted_image_family,
)
from .models import STAGE_DEPENDENCY_ORDER, StageName


def _load_packaged_pipeline() -> ModuleType:
    from .modeling import pipeline_template

    return pipeline_template


def _payload(pipeline: ModuleType, tag: str) -> tuple[dict[str, Any], Any]:
    payload = pipeline._load_stage(tag)
    return payload, pipeline._stage_from_payload(payload)


def _feature_mask(cache_dir: Path) -> np.ndarray:
    return np.asarray(fits.getdata(cache_dir / "feature_mask.fits"), dtype=bool)


def _predicted_image_family(cache_dir: Path) -> dict[str, Any]:
    path = cache_dir / "stage_a_predicted_image_family.json"
    return validate_predicted_image_family(
        json.loads(path.read_text(encoding="utf-8"))
    )


def _stage_a(pipeline: ModuleType, image, noise, psf, mask) -> None:
    pipeline.run_stage_a(image, noise, psf, circular_mask=mask)


def _stage_b(pipeline: ModuleType, image, noise, _psf, mask) -> None:
    payload, _ = _payload(pipeline, "a")
    family_path = pipeline.stage_output_dir("a") / "stage_a_predicted_image_family.json"
    family = _predicted_image_family(pipeline.stage_output_dir("a"))
    pipeline.run_stage_b(
        image,
        noise,
        payload["extra"]["lens_light_model"],
        family,
        modeling_mask=mask,
        family_reference=f"{family['stage_attempt']}/artifacts/{family_path.name}",
        family_sha256=hashlib.sha256(family_path.read_bytes()).hexdigest(),
    )


def _common_mass_inputs(pipeline: ModuleType):
    raw_a, stage_a = _payload(pipeline, "a")
    family = _predicted_image_family(pipeline.stage_output_dir("a"))
    return (
        raw_a,
        stage_a,
        _feature_mask(pipeline.stage_output_dir("b")),
        raw_a["extra"]["lens_light_model"],
        position_likelihood_from_family(family),
    )


def _m0_source_grid(pipeline: ModuleType) -> dict[str, Any]:
    return pipeline._load_source_grid_spec(
        pipeline.stage_output_dir("m0") / "source_grid_spec.json"
    )


def _stage_m0(pipeline: ModuleType, image, noise, psf, mask) -> None:
    raw_a, stage_a, feature, lens_light, position = _common_mass_inputs(pipeline)
    pipeline.run_stage_m0(
        image, noise, psf, feature, lens_light, stage_a, position,
        raw_a["extra"]["source_grid_anchor"], circular_mask=mask,
    )


def _stage_m1(pipeline: ModuleType, image, noise, psf, mask) -> None:
    _, stage_a, feature, lens_light, position = _common_mass_inputs(pipeline)
    raw_m0 = pipeline._load_stage("m0")
    source_grid = _m0_source_grid(pipeline)
    pipeline.run_stage_m1(
        image,
        noise,
        psf,
        feature,
        lens_light,
        stage_a,
        position,
        float(raw_m0["extra"]["log_lambda_best"]),
        source_grid,
        circular_mask=mask,
    )


def _stage_m2(pipeline: ModuleType, image, noise, psf, mask) -> None:
    raw_a, _, feature, lens_light, position = _common_mass_inputs(pipeline)
    raw_m1, _ = _payload(pipeline, "m1")
    source_grid = _m0_source_grid(pipeline)
    medians = dict(raw_m1["extra"]["medians"])
    medians.update(
        center_x_mass=float(medians.get("center_x_mass", raw_a["extra"]["medians"]["center_x_mass"])),
        center_y_mass=float(medians.get("center_y_mass", raw_a["extra"]["medians"]["center_y_mass"])),
    )
    pipeline.run_stage_m2(
        image,
        noise,
        psf,
        feature,
        lens_light,
        medians,
        position,
        pipeline._validate_source_template_package(
            raw_m1["extra"]["s1"], source_grid
        ),
        source_grid,
        circular_mask=mask,
    )


def _stage_m3(pipeline: ModuleType, image, noise, psf, mask) -> None:
    _, stage_a, feature, lens_light, position = _common_mass_inputs(pipeline)
    raw_m1, stage_m1 = _payload(pipeline, "m1")
    raw_m2, _ = _payload(pipeline, "m2")
    source_grid = _m0_source_grid(pipeline)
    pipeline.run_stage_m3(
        image,
        noise,
        psf,
        feature,
        lens_light,
        stage_m1,
        stage_a,
        position,
        pipeline._reg_hyperparams_from_m2_payload(raw_m2),
        pipeline._validate_source_template_package(
            raw_m1["extra"]["s1"], source_grid
        ),
        source_grid,
        circular_mask=mask,
    )


def _stage_subhalo(pipeline: ModuleType, image, noise, psf, mask, *, preview_only=False):
    from .modeling.subhalo import run_subhalo
    _, stage_a, feature, lens_light, position = _common_mass_inputs(pipeline)
    raw_m1, stage_m1 = _payload(pipeline, "m1")
    _, stage_m3 = _payload(pipeline, "m3")
    raw_m2, _ = _payload(pipeline, "m2")
    grid = _m0_source_grid(pipeline)
    # Both real execution and preview use the sealed preparation bundle.
    attempt_root = pipeline.DIAGNOSTICS_DIR.parent
    candidate = json.loads((attempt_root / "subhalo-candidate.json").read_text())
    return run_subhalo(
        image, noise, psf, feature, lens_light, stage_a, stage_m1, stage_m3,
        position, pipeline._reg_hyperparams_from_m2_payload(raw_m2),
        pipeline._validate_source_template_package(raw_m1["extra"]["s1"], grid),
        grid, candidate, mask, preview_only=preview_only,
    )


RUNNERS = {
    StageName.A: _stage_a,
    StageName.B: _stage_b,
    StageName.M0: _stage_m0,
    StageName.M1: _stage_m1,
    StageName.M2: _stage_m2,
    StageName.M3: _stage_m3,
    StageName.SUBHALO: _stage_subhalo,
}

_REQUIRED_UPSTREAM_ARTIFACT = {
    StageName.A: ("stage_a.pkl", "stage_a_predicted_image_family.json"),
    StageName.B: ("feature_mask.fits",),
    StageName.M0: ("stage_m0.pkl",),
    StageName.M1: ("stage_m1.pkl",),
    StageName.M2: ("stage_m2.pkl",),
    StageName.M3: ("stage_m3.pkl",),
}


def _safe_json(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {str(key): _safe_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_json(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _summarize(
    artifact_dir: Path, diagnostics_dir: Path, stage: StageName
) -> tuple[dict[str, str], dict[str, Any]]:
    if stage == StageName.B:
        feature = _feature_mask(artifact_dir)
        audit_path = artifact_dir / "stage_b_morphology_audit.json"
        audit = (
            validate_stage_b_morphology_audit(
                json.loads(audit_path.read_text(encoding="utf-8"))
            )
            if audit_path.is_file()
            else {"images": []}
        )
        return (
            {
                "feature_mask_fits": "artifacts/feature_mask.fits",
                "stage_b_mask_png": "diagnostics/stage_b_mask.png",
                "stage_b_components_png": "diagnostics/stage_b_components.png",
                "stage_b_components_json": "artifacts/stage_b_components.json",
                "stage_b_morphology_audit_json": "artifacts/stage_b_morphology_audit.json",
                "stage_b_morphology_audit_png": "diagnostics/stage_b_morphology_audit.png",
            },
            {
                "included_arc_pixels": int((~feature).sum()),
                "masked_pixels": int(feature.sum()),
                "included_fraction": float((~feature).mean()),
                "predicted_image_count": len(audit["images"]),
                "uncovered_predicted_image_count": sum(
                    not item["nearest_pixel_covered"] for item in audit["images"]
                ),
            },
        )

    payload_path = artifact_dir / f"stage_{stage.value}.pkl"
    with payload_path.open("rb") as handle:
        payload = pickle.load(handle)
    weights = payload.get("weights")
    probability = np.asarray(weights, dtype=float) if weights is not None else np.asarray([])
    effective_sample_size = None
    if probability.size and np.square(probability).sum() > 0:
        probability = probability / probability.sum()
        effective_sample_size = float(1.0 / np.square(probability).sum())
    metrics = {
        "log_z": float(payload["log_z"]),
        "param_names": list(payload.get("param_names", [])),
        "sample_count": int(len(payload["samples"])) if payload.get("samples") is not None else 0,
        "effective_sample_size": effective_sample_size,
        "medians": payload.get("extra", {}).get("medians", {}),
        "time_taken_sec": payload.get("extra", {}).get("time_taken"),
    }
    visual_prior_provenance = None
    provenance_path = artifact_dir.parent / "visual-prior-provenance.json"
    if stage == StageName.A and not provenance_path.is_file():
        provenance_path = artifact_dir.parent.parent / "0" / "visual-prior-provenance.json"
    if stage == StageName.A and provenance_path.is_file():
        visual_prior_provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    metrics.update(
        stage_summary(
            payload,
            stage.value,
            visual_prior_provenance=visual_prior_provenance,
        )
    )
    artifacts = {
        "stage_pickle": f"artifacts/stage_{stage.value}.pkl",
        "model_png": f"diagnostics/stage_{stage.value}_model.png",
    }
    if stage == StageName.A:
        artifacts["predicted_image_family"] = (
            "artifacts/stage_a_predicted_image_family.json"
        )
        if (artifact_dir / "stage_a_predicted_image_family.json").is_file():
            family = _predicted_image_family(artifact_dir)
            metrics["predicted_image_count"] = family["image_count"]
    if stage == StageName.M0:
        source_grid = validate_source_grid_spec(
            json.loads((artifact_dir / "source_grid_spec.json").read_text(encoding="utf-8"))
        )
        metrics["source_grid_spec"] = source_grid
        artifacts.update(
            source_grid_spec="artifacts/source_grid_spec.json",
            source_grid_png="diagnostics/stage_m0_source_grid.png",
        )
    if stage == StageName.SUBHALO:
        extra = payload["extra"]
        metrics.update({key: extra[key] for key in
                        ("log_z_m3", "delta_log_z", "evidence_interpretation", "fixed_mass_center", "residual_comparison")})
        artifacts.update(
            candidate_json="artifacts/subhalo_candidate.json",
            candidate_png="diagnostics/subhalo_candidate.png",
            comparison_png="diagnostics/subhalo_comparison.png",
            comparison_arrays="artifacts/subhalo_comparison.npz",
            confirmed_preview="preview-confirmed.json",
        )
    return artifacts, metrics


def _stage_b_coverage_metrics(pipeline: ModuleType, image, noise, mask) -> dict[str, Any]:
    raw_a, _ = _payload(pipeline, "a")
    feature = _feature_mask(pipeline.OUT_DIR)
    threshold = float(pipeline.get_config().arc_snr_threshold)
    high_snr = ((image - raw_a["extra"]["lens_light_model"]) / noise > threshold) & ~mask
    min_component_pixels = int(pipeline.get_config().arc_ignor_size)
    missed, _, sizes = pipeline._connected_component_area_filter(
        high_snr & feature, min_component_pixels
    )
    total = int(high_snr.sum())
    return {
        "snr_threshold": threshold,
        "high_snr_pixels": total,
        "large_uncovered_threshold_islands": int(
            sum(size >= min_component_pixels for size in sizes)
        ),
        "large_uncovered_threshold_pixels": int(missed.sum()),
        "large_uncovered_threshold_fraction": (
            float(missed.sum() / total) if total else 0.0
        ),
    }


def _nonfinite_paths(value: Any, prefix: str = "metrics") -> list[str]:
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, dict):
        return [item for key, child in value.items() for item in _nonfinite_paths(child, f"{prefix}.{key}")]
    if isinstance(value, (list, tuple)):
        return [item for index, child in enumerate(value) for item in _nonfinite_paths(child, f"{prefix}[{index}]")]
    return [prefix] if isinstance(value, float) and not math.isfinite(value) else []


def _gate_failures(
    stage: StageName,
    artifacts: dict[str, str],
    metrics: dict[str, Any],
    attempt_root: Path,
) -> list[str]:
    failures = [
        f"missing artifact: {name}"
        for name, path in artifacts.items()
        if not (attempt_root / path).is_file()
    ]
    failures.extend(f"non-finite numerical output: {path}" for path in _nonfinite_paths(metrics))
    if stage == StageName.M0 and metrics.get("m0_lambda_search", {}).get("fine_grid_best_at_edge"):
        failures.append("M0 regularization optimum lies on the fine-grid boundary")
    return failures


def _require_model_disposition(output_dir: Path) -> None:
    inspector_path = output_dir / "preflight" / "inspector.json"
    inspector = json.loads(inspector_path.read_text(encoding="utf-8"))
    disposition = inspector.get("disposition")
    if disposition != "model":
        raise ValueError(f"modeling requires inspector disposition 'model', got {disposition!r}")


def _accepted_upstream_dirs(
    output_dir: Path, stage: StageName, *, expected_source_grid_level: int
) -> dict[str, Path]:
    stage_index = STAGE_DEPENDENCY_ORDER.index(stage)
    result: dict[str, Path] = {}
    for upstream in STAGE_DEPENDENCY_ORDER[:stage_index]:
        head_path = output_dir / "accepted" / f"{upstream.value}.json"
        head = json.loads(head_path.read_text(encoding="utf-8"))
        if head.get("stage") != upstream.value:
            raise ValueError("Accepted Stage Head names the wrong stage")
        upstream_attempt = (head_path.parent / str(head["attempt_path"])).resolve()
        try:
            upstream_attempt.relative_to(output_dir)
        except ValueError as error:
            raise ValueError("Accepted Stage Head escapes the Lens Result Directory") from error
        validate_config_geometry(EffectiveConfig.model_validate_json(
            (upstream_attempt / "effective-config.json").read_text(encoding="utf-8")), output_dir)
        artifact_dir = (upstream_attempt / "artifacts").resolve()
        try:
            artifact_dir.relative_to(upstream_attempt)
            artifact_dir.relative_to(output_dir)
        except ValueError as error:
            raise ValueError("Accepted Stage artifacts escape the Lens Result Directory") from error
        if not artifact_dir.is_dir():
            raise ValueError(f"Accepted Stage artifacts are missing for {upstream.value}")
        decision_path = upstream_attempt / "decision.json"
        decision = json.loads(decision_path.read_text(encoding="utf-8"))
        validate_decision_review_evidence(upstream_attempt, decision)
        for required_name in _REQUIRED_UPSTREAM_ARTIFACT[upstream]:
            required_artifact = (artifact_dir / required_name).resolve()
            try:
                required_artifact.relative_to(artifact_dir)
                required_artifact.relative_to(upstream_attempt)
                required_artifact.relative_to(output_dir)
            except ValueError as error:
                raise ValueError(
                    "Accepted Stage artifact escapes the Lens Result Directory: "
                    f"{required_name}"
                ) from error
            if not required_artifact.is_file():
                raise ValueError(
                    f"Accepted Stage artifact is missing for {upstream.value}: "
                    f"{required_name}"
                )
        if upstream == StageName.A:
            _predicted_image_family(artifact_dir)
        if upstream == StageName.M0:
            validate_source_grid_spec(
                json.loads(
                    (artifact_dir / "source_grid_spec.json").read_text(encoding="utf-8")
                ),
                expected_level=expected_source_grid_level,
            )
        result[upstream.value] = artifact_dir
    return result


def _media_type(path: str) -> str:
    suffix = Path(path).suffix.lower()
    return {
        ".png": "image/png",
        ".json": "application/json",
        ".fits": "application/fits",
        ".pkl": "application/octet-stream",
    }.get(suffix, "application/octet-stream")


def _write_artifact_manifest(
    attempt_root: Path, artifacts: dict[str, str]
) -> None:
    roles_by_path = {path: role for role, path in artifacts.items()}
    generated = {
        path
        for directory in (attempt_root / "artifacts", attempt_root / "diagnostics")
        if directory.is_dir()
        for path in directory.rglob("*")
        if path.is_file()
    }
    # Some stage evidence, such as the confirmed subhalo preview, lives at the
    # attempt root. Include explicitly declared files as well as output folders.
    for reference in artifacts.values():
        path = (attempt_root / reference).resolve()
        path.relative_to(attempt_root.resolve())
        if path.is_file():
            generated.add(path)
    generated = sorted({path.resolve() for path in generated})
    entries = [
        {
            "path": path.relative_to(attempt_root.resolve()).as_posix(),
            "role": roles_by_path.get(
                path.relative_to(attempt_root.resolve()).as_posix(), path.stem
            ),
            "media_type": _media_type(path.name),
        }
        for path in generated
    ]
    (attempt_root / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": "attempt_artifact_manifest.v1",
                "artifacts": entries,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _arc_component_selection(
    output_dir: Path, attempt_root: Path, attempt: int
) -> tuple[int, ...]:
    selection_path = attempt_root / "arc-component-selection.json"
    if not selection_path.is_file():
        return ()
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    if set(selection) != {
        "schema_version",
        "component_catalog",
        "drop_component_ids",
    } or selection.get("schema_version") != "arc_component_selection.v1":
        raise ValueError("invalid Arc Component Selection")
    if attempt == 0:
        raise ValueError("initial Stage-B attempt has no parent component catalog")
    expected = f"attempts/b/{attempt - 1}/artifacts/stage_b_components.json"
    if selection.get("component_catalog") != expected:
        raise ValueError("Arc Component Selection is not bound to its parent component catalog")
    catalog_path = (output_dir / expected).resolve()
    try:
        catalog_path.relative_to(output_dir)
    except ValueError as error:
        raise ValueError("Arc Component Selection escapes the Lens Result Directory") from error
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    available = {
        item.get("id")
        for item in catalog.get("components", [])
        if isinstance(item, dict)
    }
    drop_ids = selection.get("drop_component_ids")
    if (
        not isinstance(drop_ids, list)
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value <= 0
            for value in drop_ids
        )
        or drop_ids != sorted(set(drop_ids))
    ):
        raise ValueError("invalid Arc Component Selection IDs")
    unknown = set(drop_ids) - available
    if unknown:
        raise ValueError(f"Arc Component Selection references absent IDs: {sorted(unknown)}")
    return tuple(drop_ids)


def run_stage(
    lens_dir: Path,
    output_dir: Path,
    stage: StageName,
    attempt: int,
    *,
    prepare_only: bool = False,
    preview_only: bool = False,
) -> dict[str, Any]:
    if preview_only and stage != StageName.SUBHALO:
        raise ValueError("--preview-only is supported only for subhalo")
    # Preserve the read-only rejection of an incorrectly addressed input.
    check_stage_input(lens_dir, output_dir)
    with attempt_lock(output_dir, stage, attempt):
        root = attempt_dir(output_dir, stage, attempt)
        result_path = root / "stage-result.json"
        if result_path.exists():
            validate_config_geometry(EffectiveConfig.model_validate_json(
                (root / "effective-config.json").read_text(encoding="utf-8")), output_dir)
            return json.loads(result_path.read_text(encoding="utf-8"))
        if (root / "stage-execution.json").exists():
            raise ValueError("Stage Attempt Record already started and cannot be executed again")
        try:
            effective, upstream_dirs = _prepare_stage(lens_dir, output_dir, stage, attempt)
            if stage == StageName.SUBHALO and not preview_only:
                from .subhalo import validate_preview_confirmation
                validate_preview_confirmation(root)
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            record_preparation_error(output_dir, stage, attempt, error)
            raise PreparationBlocked(str(error)) from error
        if prepare_only:
            return {"status": "prepared", "stage": stage.value, "attempt": attempt}
        if preview_only:
            pipeline = _load_packaged_pipeline()
            preview_dir = root / "preview"
            pipeline.configure_runtime(config=effective.settings, artifact_dir=preview_dir,
                                       diagnostics_dir=preview_dir, upstream_dirs=upstream_dirs,
                                       stage_attempt_reference=f"attempts/{stage.value}/{attempt}")
            data = load_lens_data(lens_dir, geometry=effective.settings)
            mask = np.asarray(fits.getdata(output_dir / "preflight/modeling_mask.fits"), dtype=bool)
            preview_path = preview_dir / "subhalo_candidate.png"
            if not preview_path.exists():
                _stage_subhalo(pipeline, data.image, data.noise, data.psf, mask, preview_only=True)
            return {"status": "success", "stage": stage.value, "attempt": attempt,
                    "preview": str(preview_path), "sampling_started": False}
        try:
            return _execute_stage(lens_dir, output_dir, stage, attempt, effective, upstream_dirs)
        except OSError as error:
            if (root / "stage-execution.json").exists():
                raise
            record_preparation_error(output_dir, stage, attempt, error)
            raise PreparationBlocked(str(error)) from error


def _prepare_stage(
    lens_dir: Path, output_dir: Path, stage: StageName, attempt: int,
) -> tuple[EffectiveConfig, dict[str, Path]]:
    output_dir = validated_run_root(output_dir)
    check_stage_input(lens_dir, output_dir)
    _require_model_disposition(output_dir)
    fits_path = lens_dir.resolve() / f"{lens_dir.resolve().name}.fits"
    if not fits_path.is_file():
        raise ValueError(f"Input FITS is missing: {fits_path}")
    with fits.open(fits_path, memmap=True) as hdul:
        if "VIS_FLUX" not in hdul:
            raise ValueError("Input FITS is missing VIS_FLUX")
        shape = hdul["VIS_FLUX"].shape
        if len(shape) != 2 or shape[0] != shape[1]:
            raise ValueError("The TinyLens observation model requires a square image; input geometry does not reproject or crop it")
    mask_path = output_dir / "preflight" / "modeling_mask.fits"
    if not mask_path.is_file():
        raise ValueError("Preflight modeling_mask.fits is missing")
    # Opening the files checks actual access, rather than just existence or mode bits.
    # Full FITS decoding remains part of execution.
    for path in (fits_path, mask_path):
        with path.open("rb") as handle:
            handle.read(1)
    root = attempt_dir(output_dir, stage, attempt)
    if (output_dir / "accepted" / f"{stage.value}.json").exists():
        raise ValueError("Stage is already accepted; preserve its accepted attempt")
    for decision_path in (output_dir / "attempts").glob("*/*/decision.json"):
        if json.loads(decision_path.read_text()).get("decision") == "human_review":
            raise ValueError("Lens has a terminal human_review decision")
    bundle = configuration_bundle(output_dir, stage, attempt)
    expected = EffectiveConfig.model_validate_json(
        json.dumps(bundle["effective-config.json"]), strict=True
    )
    upstream = _accepted_upstream_dirs(
        output_dir, stage, expected_source_grid_level=expected.settings.source_grid_level
    )
    if not root.exists():
        _prepare_attempt(output_dir, stage, attempt)
    selection_path = root / "arc-component-selection.json"
    if "arc-component-selection.json" not in bundle and (
        selection_path.exists() or selection_path.is_symlink()
    ):
        raise ValueError(f"Arc Component Selection is not authorized for this attempt: {selection_path}")
    for name, payload in bundle.items():
        path = root / name
        if path.is_symlink():
            raise ValueError(f"Prepared file does not match its authorized configuration: {path}")
        recorded = json.loads(path.read_text(encoding="utf-8"))
        if name == "effective-config.json" and stage != StageName.SUBHALO:
            # Pre-extension A–M3 snapshots omit these unused settings. Compare
            # their defaults in memory without rewriting immutable evidence or
            # relaxing checks on any pre-existing field.
            settings = recorded.get("settings") if isinstance(recorded, dict) else None
            if isinstance(settings, dict):
                defaults = PipelineConfig()
                for parameter in ("stage_subhalo_n_live", "stage_subhalo_n_eff"):
                    settings.setdefault(parameter, getattr(defaults, parameter))
        if recorded != payload:
            raise ValueError(f"Prepared file does not match its authorized configuration: {path}")
    for name in ("stage.log", "traceback.log", "manifest.json", "review.json", "decision.json"):
        if (root / name).exists() or (root / name).is_symlink():
            raise ValueError(f"Stage Attempt Record already contains {name}")
    effective = EffectiveConfig.model_validate_json(
        (root / "effective-config.json").read_text(encoding="utf-8"), strict=True
    )
    if stage == StageName.B:
        _arc_component_selection(output_dir, root, attempt)
    for name in ("artifacts", "diagnostics"):
        directory = (root / name).resolve()
        directory.relative_to(root)
        if directory.exists() and (not directory.is_dir() or any(directory.iterdir())):
            raise ValueError(f"Unsealed attempt already contains scientific output: {directory}")
    return effective, upstream


def _execute_stage(
    lens_dir: Path, output_dir: Path, stage: StageName, attempt: int,
    effective: EffectiveConfig, upstream_dirs: dict[str, Path],
) -> dict[str, Any]:
    output_dir = validated_run_root(output_dir)
    attempt_root = attempt_dir(output_dir, stage, attempt)
    artifact_dir = (attempt_root / "artifacts").resolve()
    diagnostics_dir = (attempt_root / "diagnostics").resolve()
    for directory in (artifact_dir, diagnostics_dir):
        try:
            directory.relative_to(attempt_root)
        except ValueError as error:
            raise ValueError("attempt output directory escapes its Stage Attempt Record") from error
    result_path = attempt_root / "stage-result.json"
    if result_path.exists():
        raise ValueError("Stage Attempt Record is already completed and cannot be overwritten")
    execution_path = attempt_root / "stage-execution.json"
    if execution_path.exists():
        raise ValueError("Stage Attempt Record already started and cannot be executed again")
    check_stage_input(lens_dir, output_dir)
    validate_config_geometry(effective, output_dir)
    attempt_root.mkdir(parents=True, exist_ok=True)
    stage_log_path = attempt_root / "stage.log"
    traceback_path = attempt_root / "traceback.log"
    if stage_log_path.exists() or stage_log_path.is_symlink():
        raise ValueError("Stage Attempt Record already contains a stage log")
    if traceback_path.exists() or traceback_path.is_symlink():
        raise ValueError("Stage Attempt Record already contains a traceback log")
    execution_temporary = attempt_root / ".stage-execution.json.tmp"
    execution_temporary.write_text(
        json.dumps(
            {
                "schema_version": "stage_execution.v1",
                "stage": stage.value,
                "attempt": attempt,
                "pipeline_release_id": PIPELINE_RELEASE_ID,
                "status": "started",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    os.replace(execution_temporary, execution_path)
    started = time.monotonic()
    result: dict[str, Any] = {
        "lens_id": lens_dir.resolve().name,
        "stage": stage.value,
        "attempt": attempt,
        "status": "failed",
        "runtime_seconds": 0.0,
        "pipeline_release_id": PIPELINE_RELEASE_ID,
        "effective_config": "effective-config.json",
        "artifacts": {},
        "metrics": {},
        "gate_failures": [],
        "eligible_for_review": False,
        "error": None,
    }
    with stage_log_path.open("x", encoding="utf-8", buffering=1) as stage_log:
        print(
            f"[lens-agent] started={datetime.now(timezone.utc).isoformat()} "
            f"stage={stage.value} attempt={attempt}",
            file=stage_log,
            flush=True,
        )
        with contextlib.redirect_stdout(stage_log), contextlib.redirect_stderr(stage_log):
            try:
                artifact_dir.mkdir(parents=True, exist_ok=True)
                diagnostics_dir.mkdir(parents=True, exist_ok=True)
                runtime = {
                    "config": effective.settings,
                    "artifact_dir": artifact_dir,
                    "diagnostics_dir": diagnostics_dir,
                    "upstream_dirs": upstream_dirs,
                    "stage_attempt_reference": f"attempts/{stage.value}/{attempt}",
                }
                if stage == StageName.B:
                    drop_ids = _arc_component_selection(output_dir, attempt_root, attempt)
                    if drop_ids:
                        runtime["dropped_component_ids"] = drop_ids
                pipeline = _load_packaged_pipeline()
                pipeline.configure_runtime(
                    **runtime,
                )
                data = load_lens_data(lens_dir, geometry=effective.settings)
                mask = np.asarray(
                    fits.getdata(output_dir / "preflight" / "modeling_mask.fits"),
                    dtype=bool,
                )
                if mask.shape != data.image.shape:
                    raise ValueError(
                        f"modeling mask shape {mask.shape} does not match "
                        f"image shape {data.image.shape}"
                    )
                RUNNERS[stage](pipeline, data.image, data.noise, data.psf, mask)
                artifacts, metrics = _summarize(artifact_dir, diagnostics_dir, stage)
                if stage == StageName.M0:
                    validate_source_grid_spec(
                        metrics["source_grid_spec"],
                        expected_level=effective.settings.source_grid_level,
                    )
                if stage == StageName.B:
                    metrics.update(
                        _stage_b_coverage_metrics(pipeline, data.image, data.noise, mask)
                    )
                result["status"] = "success"
                result["artifacts"] = artifacts
                result["metrics"] = _safe_json(metrics)
                result["gate_failures"] = _gate_failures(
                    stage, artifacts, metrics, attempt_root
                )
                result["eligible_for_review"] = not result["gate_failures"]
            except Exception as error:
                result["error"] = f"{type(error).__name__}: {error}"
                result["gate_failures"] = ["stage command failed"]
                with traceback_path.open("x", encoding="utf-8") as traceback_log:
                    traceback_log.write(traceback.format_exc())
                result["traceback_log"] = "traceback.log"
            finally:
                result["runtime_seconds"] = time.monotonic() - started
                details = (
                    " traceback=traceback.log" if result["status"] == "failed" else ""
                )
                print(
                    f"[lens-agent] finished={datetime.now(timezone.utc).isoformat()} "
                    f"status={result['status']} "
                    f"runtime_seconds={result['runtime_seconds']:.6f}{details}",
                    file=stage_log,
                    flush=True,
                )
    _write_artifact_manifest(attempt_root, result["artifacts"])
    result_temporary = attempt_root / ".stage-result.json.tmp"
    result_temporary.write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(result_temporary, result_path)
    return result
