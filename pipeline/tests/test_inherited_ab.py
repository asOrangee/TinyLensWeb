import hashlib
import json
import pickle
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

from lens_agent.attempts import CORE_EVIDENCE_FILES
from lens_agent.cli import main
from lens_agent.configuration import EffectiveConfig, InputGeometry, PIPELINE_RELEASE_ID, PipelineConfig
from lens_agent.inherited_ab import prepare_inherited_ab
from lens_agent.inspection.diagnostics import _canonical_geometry_header
from lens_agent.inspection.euclid import binary_mask_sha256
from lens_agent.modeling.predicted_image_family import MEDIAN_NAMES, build_predicted_image_family
from lens_agent.models import StageName
from lens_agent.stages import run_stage
from tests.helpers import make_lens_dir, model_inspector_decision


LEGACY_RELEASE = "input-geometry.v1"
SOURCE_RUN_ID = "a" * 32


def _json(path: Path, packet: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(packet, indent=2) + "\n", encoding="utf-8")


def _read(path: Path) -> dict:
    return json.loads(path.read_bytes())


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _files(directory: Path) -> dict[str, bytes]:
    return {
        path.relative_to(directory).as_posix(): path.read_bytes()
        for path in directory.rglob("*")
        if path.is_file()
    }


def _ref(path: Path, root: Path) -> dict:
    return {"path": path.relative_to(root).as_posix(), "sha256": _digest(path)}


def _seal_attempt(
    run: Path,
    lens: Path,
    stage: str,
    attempt: int,
    *,
    settings: PipelineConfig,
    artifacts: dict[str, str],
    decision: str = "accept",
) -> None:
    relative = f"attempts/{stage}/{attempt}"
    root = run / relative
    parent_config = "attempts/a/0/effective-config.json" if stage == "b" else None
    config = EffectiveConfig(parent_config=parent_config, settings=settings).model_dump(mode="json")
    config["pipeline_release_id"] = LEGACY_RELEASE
    _json(root / "effective-config.json", config)
    _json(root / "stage-execution.json", {
        "schema_version": "stage_execution.v1", "stage": stage, "attempt": attempt,
        "pipeline_release_id": LEGACY_RELEASE, "status": "started",
    })
    _json(root / "stage-result.json", {
        "lens_id": lens.name, "stage": stage, "attempt": attempt, "status": "success",
        "runtime_seconds": 0.0, "pipeline_release_id": LEGACY_RELEASE, "gate_failures": [],
        "eligible_for_review": True, "error": None, "effective_config": "effective-config.json",
        "artifacts": artifacts, "metrics": {},
    })
    _json(root / "manifest.json", {
        "schema_version": "attempt_artifact_manifest.v1",
        "artifacts": [
            {"path": relative, "role": role,
             "media_type": {".fits": "application/fits", ".json": "application/json"}
             .get(Path(relative).suffix, "application/octet-stream")}
            for role, relative in artifacts.items()
        ],
    })
    _json(root / "review.json", {"stage": stage, "attempt": attempt, "fixture": "sealed legacy review"})
    (root / "stage.log").write_text("synthetic legacy execution\n", encoding="utf-8")
    evidence = {
        name: _digest(root / name) if (root / name).is_file() else None
        for name in CORE_EVIDENCE_FILES
    }
    evidence.update({f"artifact:{path}": _digest(root / path) for path in artifacts.values()})
    _json(root / "decision.json", {
        "schema_version": "stage_decision.v1", "stage": stage, "attempt": attempt,
        "decision": decision, "evidence_sha256": evidence,
    })
    if decision != "accept":
        return
    _json(run / f"accepted/{stage}.json", {
        "schema_version": "accepted_stage_head.v1", "stage": stage, "accepted_attempt": attempt,
        "attempt_path": f"../{relative}", "effective_config": f"../{relative}/effective-config.json",
    })
    fits_path = lens / f"{lens.name}.fits"
    _json(root / "display-manifest.json", {
        "schema": "tinylens.stage-display.v3", "run": str(run), "run_id": SOURCE_RUN_ID,
        "lens_id": lens.name, "stage": stage, "attempt": attempt,
        "input": {"path": str(fits_path), "sha256": _digest(fits_path),
                  "pixel_scale_arcsec": settings.pixel_scale_arcsec},
        "run_manifest": _ref(run / "run-manifest.json", run),
        "summary": _ref(root / "stage-result.json", root),
        "configuration": _ref(root / "effective-config.json", root),
        "modeling_mask": _ref(run / "preflight/modeling_mask.fits", run),
        "upstream": ([{"stage": "a", "attempt": 0,
                       **_ref(run / "attempts/a/0/stage-result.json", run)}] if stage == "b" else []),
        "planes": {},
    })


@pytest.fixture
def legacy_run(tmp_path: Path) -> tuple[Path, Path, Path]:
    workspace = tmp_path.resolve() / "workspace"
    inputs = workspace / "output/inputs"
    inputs.mkdir(parents=True)
    lens = make_lens_dir(inputs, "lens-146")
    source = workspace / "output/legacy" / lens.name
    target = workspace / "output/source-reconstruction" / lens.name
    target.parent.mkdir(parents=True)
    geometry = InputGeometry(pixel_scale_arcsec=0.1, input_y_direction="decreasing")
    image_shape = (32, 32)
    header = _canonical_geometry_header(image_shape, geometry)
    fits_path = lens / f"{lens.name}.fits"
    domain_mask = np.zeros(image_shape, dtype=np.uint8)
    domain_mask[0, :] = 1
    euclid = {
        "input_fits_sha256": _digest(fits_path),
        "image_shape": list(image_shape),
        "canonical_mask_sha256": binary_mask_sha256(domain_mask),
    }
    _json(source / "run-manifest.json", {
        "schema_version": "lens_run_manifest.v1", "run_id": SOURCE_RUN_ID,
        "pipeline_release_id": LEGACY_RELEASE, "lens_dir": str(lens),
        "input_geometry": geometry.model_dump(), "geometry_evidence": "synthetic calibration",
        "stage_b_defaults": {"arc_snr_threshold": 3.0, "arc_ignor_size": 8},
        "euclid_contamination": euclid,
    })
    preflight = source / "preflight"
    _json(preflight / "inspection.json", {
        "schema_version": "inspection_packet.v5", "lens_id": lens.name, "lens_dir": str(lens),
        "input_geometry": geometry.model_dump(), "image_shape": list(image_shape),
        "euclid_contamination": euclid,
    })
    _json(preflight / "inspector.json", model_inspector_decision(lens.name))
    mask_header = header.copy()
    mask_header["MODELRAD"] = 4.0
    fits.writeto(preflight / "modeling_mask.fits", domain_mask, header=mask_header)
    fits.writeto(preflight / "segmentation.fits", domain_mask.astype(np.int32), header=header)
    a_root = source / "attempts/a/0/artifacts"
    a_root.mkdir(parents=True)
    (a_root / "stage_a.pkl").write_bytes(pickle.dumps({"extra": {"lens_light_model": np.zeros(image_shape)}}))
    _json(a_root / "stage_a_predicted_image_family.json", build_predicted_image_family(
        [[-0.6, -0.5], [0.7, 0.6]],
        medians={name: 0.0 for name in MEDIAN_NAMES},
        image_shape=image_shape, pixel_scale_arcsec=geometry.pixel_scale_arcsec,
        stage_attempt="attempts/a/0", solver="optimization",
        solver_config={"initial_range": 4.0, "n_x": 400, "n_y": 400, "k_keep": 30,
                       "num_iters": 20, "tolerance": 5e-4, "cluster_tol": 0.08},
        threshold_arcsec=0.1, min_log_like=-1e10,
    ))
    settings_a = PipelineConfig(**geometry.model_dump(), arc_snr_threshold=3.0, arc_ignor_size=8)
    _seal_attempt(source, lens, "a", 0, settings=settings_a, artifacts={
        "stage_pickle": "artifacts/stage_a.pkl",
        "predicted_image_family": "artifacts/stage_a_predicted_image_family.json",
    })
    for attempt in (0, 1):
        b_root = source / f"attempts/b/{attempt}/artifacts"
        b_root.mkdir(parents=True)
        feature_mask = np.ones(image_shape, dtype=np.uint8)
        feature_mask[11:15, 10:16] = 0
        fits.writeto(b_root / "feature_mask.fits", feature_mask, header=header)
        _seal_attempt(
            source, lens, "b", attempt,
            settings=settings_a.model_copy(update={"arc_snr_threshold": 6.0 if attempt else 3.0}),
            artifacts={"feature_mask_fits": "artifacts/feature_mask.fits"},
            decision="accept" if attempt else "human_review",
        )
    for stage in ("m0", "m1", "m2", "m3"):
        _json(source / f"attempts/{stage}/0/stage-result.json", {"stage": stage, "legacy_fixture": True})
        _json(source / f"accepted/{stage}.json", {"stage": stage, "accepted_attempt": 0})
    return lens, source, target


def test_inherits_exact_accepted_ab_and_prepares_a_fresh_m0(legacy_run, capsys):
    lens, source, target = legacy_run
    old_files = _files(source)
    old_input = _files(lens)

    main(["rerun", "from-m0", "--source-run", str(source), "--output-dir", str(target)])
    assert capsys.readouterr().out.strip() == str(target)
    manifest = _read(target / "run-manifest.json")
    assert manifest["run_id"] != SOURCE_RUN_ID
    assert manifest["pipeline_release_id"] == PIPELINE_RELEASE_ID
    assert manifest["lens_dir"] == str(lens)
    assert manifest["input_geometry"] == _read(source / "run-manifest.json")["input_geometry"]
    assert manifest["inherited_ab"] == _ref(target / "inherited-ab.json", target)
    assert (target / "inherited-ab-source-manifest.json").read_bytes() == old_files["run-manifest.json"]
    for relative in ("inspection.json", "inspector.json", "modeling_mask.fits", "segmentation.fits"):
        assert (target / "preflight" / relative).read_bytes() == old_files[f"preflight/{relative}"]
    assert {path.name for path in (target / "attempts").iterdir()} == {"a", "b"}
    assert {path.name for path in (target / "accepted").iterdir()} == {"a.json", "b.json"}
    for stage, attempt in (("a", 0), ("b", 1)):
        head = f"accepted/{stage}.json"
        assert (target / head).read_bytes() == old_files[head]
        relative = f"attempts/{stage}/{attempt}"
        copied = _files(target / relative)
        for name in ("effective-config.json", "stage-execution.json", "stage-result.json",
                     "manifest.json", "review.json", "decision.json"):
            assert copied[name] == old_files[f"{relative}/{name}"]
        for name, value in copied.items():
            if name.startswith("artifacts/"):
                assert value == old_files[f"{relative}/{name}"]
    assert not (target / "attempts/b/0").exists()

    assert run_stage(lens, target, StageName.M0, 0, prepare_only=True) == {
        "status": "prepared", "stage": "m0", "attempt": 0,
    }
    m0 = target / "attempts/m0/0"
    config = EffectiveConfig.model_validate_json((m0 / "effective-config.json").read_bytes(), strict=True)
    assert config.pipeline_release_id == PIPELINE_RELEASE_ID
    assert config.parent_config == "attempts/b/1/effective-config.json"
    assert config.settings.source_grid_level == 0
    assert config.settings.arc_snr_threshold == 6.0
    assert not (m0 / "stage-execution.json").exists()
    assert _files(source) == old_files
    assert _files(lens) == old_input


@pytest.mark.parametrize("changed", ["input", "modeling_mask", "segmentation", "stage_b_mask", "stage_a_review"])
def test_refuses_changed_source_evidence_without_creating_a_target(legacy_run, changed):
    lens, source, target = legacy_run
    path = {
        "input": lens / f"{lens.name}.fits",
        "modeling_mask": source / "preflight/modeling_mask.fits",
        "segmentation": source / "preflight/segmentation.fits",
        "stage_b_mask": source / "attempts/b/1/artifacts/feature_mask.fits",
        "stage_a_review": source / "attempts/a/0/review.json",
    }[changed]
    if path.suffix == ".fits":
        with fits.open(path, mode="update", memmap=False) as hdus:
            hdu = hdus["VIS_FLUX"] if changed == "input" else hdus[0]
            hdu.data[0, 0] = 1 - hdu.data[0, 0]
    else:
        _json(path, {**_read(path), "fixture": "tampered review"})
    old_files = _files(source)
    with pytest.raises(ValueError):
        prepare_inherited_ab(source, target)
    assert not target.exists()
    assert _files(source) == old_files


@pytest.mark.parametrize("changed", ["missing_anchor", "receipt", "input", "stage_b_mask"])
def test_legacy_configs_need_an_untampered_inheritance_record(legacy_run, changed):
    lens, source, target = legacy_run
    prepare_inherited_ab(source, target)
    if changed == "missing_anchor":
        manifest = _read(target / "run-manifest.json")
        del manifest["inherited_ab"]
        _json(target / "run-manifest.json", manifest)
    elif changed == "receipt":
        receipt = target / "inherited-ab.json"
        receipt.write_bytes(receipt.read_bytes() + b" ")
    elif changed == "input":
        with fits.open(lens / f"{lens.name}.fits", mode="update", memmap=False) as hdus:
            hdus["VIS_FLUX"].data[0, 0] += 1
    else:
        path = target / "attempts/b/1/artifacts/feature_mask.fits"
        with fits.open(path, mode="update", memmap=False) as hdus:
            hdus[0].data[0, 0] = 0
    with pytest.raises(ValueError):
        run_stage(lens, target, StageName.M0, 0, prepare_only=True)
    assert not (target / "attempts/m0").exists()


def test_imported_preflight_cannot_be_replaced_through_mask_command(legacy_run):
    _, source, target = legacy_run
    prepare_inherited_ab(source, target)
    frozen = _files(target / "preflight")

    with pytest.raises(ValueError, match="Preflight.*frozen"):
        main(["mask", "--output-dir", str(target),
              "--inspection", str(target / "preflight/inspector.json")])

    assert _files(target / "preflight") == frozen


@pytest.mark.parametrize("populated", [False, True])
def test_inheritance_preserves_any_existing_target(legacy_run, populated):
    _, source, target = legacy_run
    target.mkdir()
    if populated:
        (target / "existing.txt").write_bytes(b"an existing result")
    old_files = _files(source)
    existing_files = _files(target)

    with pytest.raises((ValueError, FileExistsError)):
        prepare_inherited_ab(source, target)
    assert target.is_dir()
    assert _files(target) == existing_files
    assert _files(source) == old_files
