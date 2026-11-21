import json
import pickle
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

from lens_agent.attempts import CORE_EVIDENCE_FILES, configuration_bundle, prepare_attempt
from lens_agent.configuration import EffectiveConfig, InputGeometry, PIPELINE_RELEASE_ID, PipelineConfig, STAGE_B_EXPANSION_POLICY
from lens_agent.inspection.diagnostics import _canonical_geometry_header, materialize_modeling_mask
from lens_agent.modeling.arc_mask import construct_arc_mask
from lens_agent.modeling.predicted_image_family import MEDIAN_NAMES, build_predicted_image_family
from lens_agent.models import StageName
from lens_agent.stage_b_candidates import (
    FAMILY_REFERENCE,
    MASK_REFERENCE,
    PKL_REFERENCE,
    generate_stage_b_candidates,
    validate_stage_b_candidate,
)
from lens_agent.workbench_display import file_sha256
from lens_agent.stage_b_selection import attach_stage_b_prescan, select_stage_b_candidate
from tests.helpers import model_inspector_decision
from tests.test_pipeline_diagnostics import _load_pipeline_template


def _json(path, payload):
    path.write_text(json.dumps(payload) + "\n", encoding="utf-8")


def _prepared_run(tmp_path: Path, *, legacy_defaults: bool = False, threshold_expansion: bool = False):
    lens = tmp_path / "inputs" / "mock"
    lens.mkdir(parents=True)
    run = tmp_path / "output" / lens.name
    preflight = run / "preflight"
    a = run / "attempts/a/0"
    (a / "artifacts").mkdir(parents=True)
    (run / "accepted").mkdir()
    preflight.mkdir()
    geometry = InputGeometry(pixel_scale_arcsec=0.2, input_x_direction="decreasing")
    shape = (44, 44)
    snr = np.zeros(shape)
    snr[8:12, 9:12] = 4
    snr[30:34, 31:34] = 25 if threshold_expansion else 8
    snr[10:14, 28:30] = 3
    snr[26:28, 11:14] = 5  # A six-pixel island differentiates the frozen defaults.
    snr[19:23, 20:25] = 21  # This region must stay excluded at every threshold.
    light = np.full(shape, 1.25)
    noise = np.full(shape, 0.125)
    source = lens / f"{lens.name}.fits"
    fits.HDUList([
        fits.PrimaryHDU(),
        fits.ImageHDU((light + snr * noise)[:, ::-1], name="VIS_FLUX"),
        fits.ImageHDU(noise, name="VIS_RMS"),
        fits.ImageHDU(np.ones((3, 3)) / 9, name="VIS_PSF"),
    ]).writeto(source)
    frozen = {
        "schema_version": "lens_run_manifest.v1", "run_id": "mock-run", "lens_dir": str(lens),
        "pipeline_release_id": PIPELINE_RELEASE_ID, "input_geometry": geometry.model_dump(),
    }
    size = 5 if legacy_defaults else 8
    if not legacy_defaults:
        frozen["stage_b_defaults"] = {"arc_snr_threshold": 3.0, "arc_ignor_size": size}
    if threshold_expansion:
        frozen["stage_b_expansion_policy"] = STAGE_B_EXPANSION_POLICY
    _json(run / "run-manifest.json", frozen)
    _json(preflight / "inspection.json", {
        "lens_id": lens.name, "lens_dir": str(lens), "input_geometry": geometry.model_dump(),
    })
    labels = np.zeros(shape, dtype=np.int32)
    labels[19:23, 20:25] = 1
    fits.writeto(preflight / "segmentation.fits", labels, header=_canonical_geometry_header(shape, geometry))
    _json(preflight / "inspector.json", {**model_inspector_decision(lens.name), "contaminant_ids": [1]})
    mask = materialize_modeling_mask(preflight, [1])
    excluded = fits.getdata(mask).astype(bool)

    config = EffectiveConfig(settings=PipelineConfig(**geometry.model_dump(), arc_ignor_size=size))
    _json(a / "effective-config.json", config.model_dump(mode="json"))
    reference = "attempts/a/0"
    family = build_predicted_image_family(
        [[-2.3, -2.5], [2.1, 2.1]], medians={name: 0.0 for name in MEDIAN_NAMES},
        image_shape=shape, pixel_scale_arcsec=geometry.pixel_scale_arcsec,
        stage_attempt=reference, solver="optimization",
        solver_config={"initial_range": 4.0, "n_x": 400, "n_y": 400, "k_keep": 30,
                       "num_iters": 20, "tolerance": 5e-4, "cluster_tol": 0.08},
        threshold_arcsec=0.1, min_log_like=-1e10,
    )
    _json(a / FAMILY_REFERENCE, family)
    (a / PKL_REFERENCE).write_bytes(pickle.dumps({"extra": {"lens_light_model": light}}, protocol=5))
    _json(a / "stage-result.json", {
        "lens_id": lens.name, "stage": "a", "attempt": 0, "status": "success", "eligible_for_review": True,
        "pipeline_release_id": PIPELINE_RELEASE_ID, "gate_failures": [],
        "metrics": {"residual_diagnostics": {"pixel_count": int((~excluded).sum())}},
    })
    _json(a / "manifest.json", {
        "schema_version": "attempt_artifact_manifest.v1",
        "artifacts": [{"path": name, "role": Path(name).stem, "media_type": "application/octet-stream"}
                      for name in (PKL_REFERENCE, FAMILY_REFERENCE)],
    })
    evidence = {name: file_sha256(a / name) if (a / name).is_file() else None for name in CORE_EVIDENCE_FILES}
    evidence.update({f"artifact:{name}": file_sha256(a / name) for name in (PKL_REFERENCE, FAMILY_REFERENCE)})
    _json(a / "decision.json", {
        "schema_version": "stage_decision.v1", "stage": "a", "attempt": 0, "decision": "accept",
        "evidence_sha256": evidence,
    })
    _json(run / "accepted/a.json", {
        "schema_version": "accepted_stage_head.v1", "stage": "a", "accepted_attempt": 0,
        "attempt_path": f"../{reference}", "effective_config": f"../{reference}/effective-config.json",
    })
    _json(a / "display-manifest.json", {
        "run": str(run), "lens_id": lens.name, "stage": "a", "attempt": 0,
        "run_manifest": {"path": "run-manifest.json", "sha256": file_sha256(run / "run-manifest.json")},
        "summary": {"path": "stage-result.json", "sha256": file_sha256(a / "stage-result.json")},
        "input": {"path": str(source), "sha256": file_sha256(source)},
        "modeling_mask": {"path": MASK_REFERENCE, "sha256": file_sha256(mask)},
    })
    return lens, run, snr, excluded


@pytest.mark.parametrize("legacy_defaults", [False, True])
def test_prescan_masks_match_formal_morphology_and_keep_attempt_history(tmp_path, legacy_defaults):
    lens, run, snr, excluded = _prepared_run(tmp_path, legacy_defaults=legacy_defaults)
    existing_files = {path: file_sha256(path) for path in run.rglob("*") if path.is_file()}
    manifest = generate_stage_b_candidates(lens, run, attempt=1)
    assert manifest == run / "stage-b-candidates/1/manifest.json"
    packet = json.loads(manifest.read_bytes())
    assert packet["attempt"] == 1
    assert packet["comparison_snr_limits"][0] <= -3.0
    assert packet["comparison_snr_limits"][1] >= 20.0
    assert packet["comparison_sha256"] == file_sha256(manifest.with_name("comparison.png"))
    assert [entry["threshold"] for entry in packet["candidates"]] == list(range(1, 21))
    assert packet["parameters"] == {"arc_ignor_size": 5 if legacy_defaults else 8,
                                    "arc_ext_size": 5, "arc_close_size": 3}
    for entry in packet["candidates"]:
        threshold = entry["threshold"]
        expected = construct_arc_mask(snr, modeling_mask=excluded, threshold=threshold,
                                      ignor_size=5 if legacy_defaults else 8, ext_size=5, close_size=3)
        mask = fits.getdata(manifest.with_name(entry["mask"]))
        np.testing.assert_array_equal(mask, expected.feature_mask)
        assert mask[excluded].all()
        assert entry["metrics"]["included_arc_pixels"] == int(expected.arc_region.sum())
    extra = 1 if legacy_defaults else 0
    assert packet["candidates"][0]["metrics"]["component_count"] == 3 + extra
    assert packet["candidates"][0]["metrics"]["covered_predicted_image_count"] == 2
    assert packet["candidates"][3]["metrics"]["covered_predicted_image_count"] == 1
    assert packet["candidates"][-1]["metrics"]["included_arc_pixels"] == 0
    selected = validate_stage_b_candidate(run, 1, 4.0)
    assert selected["manifest_sha256"] == file_sha256(manifest)
    assert selected["mask_path"] == manifest.with_name("threshold-4.fits")
    assert selected["mask_sha256"] == file_sha256(selected["mask_path"])
    assert selected["comparison_path"] == manifest.with_name("comparison.png")
    _json(manifest.with_name("selection.json"), {"selection_written_elsewhere": True})
    assert generate_stage_b_candidates(lens, run, attempt=1) == manifest
    assert selected == validate_stage_b_candidate(run, 1, 4)
    if not legacy_defaults:
        for threshold in (1, 20):
            assert validate_stage_b_candidate(run, 1, threshold)["mask_path"] == manifest.with_name(
                f"threshold-{threshold}.fits"
            )
        second = generate_stage_b_candidates(lens, run, attempt=2)
        second_packet = json.loads(second.read_bytes())
        assert second_packet["comparison_sha256"] == packet["comparison_sha256"]
        assert second_packet["candidates"] == packet["candidates"]
    assert existing_files == {path: file_sha256(path) for path in existing_files}
    assert not (run / "attempts/b").exists()
    assert not (run / "accepted/b.json").exists()


def test_threshold_expansion_is_recorded_and_matches_formal_mask(tmp_path, monkeypatch):
    lens, run, snr, excluded = _prepared_run(tmp_path, threshold_expansion=True)
    initial = configuration_bundle(run, StageName.B, 0)["effective-config.json"]["settings"]
    assert (initial["arc_snr_threshold"], initial["arc_ext_size"]) == (3, 1)
    manifest = generate_stage_b_candidates(lens, run)
    packet = json.loads(manifest.read_bytes())
    assert packet["parameters"] == {"arc_ignor_size": 8, "arc_close_size": 3}
    assert [entry["arc_ext_size"] for entry in packet["candidates"]] == [1] * 4 + [3] * 6 + [5] * 10
    for threshold, radius in ((4, 0), (5, 1), (10, 1), (11, 2)):
        candidate = validate_stage_b_candidate(run, 0, threshold)
        assert candidate["arc_ext_size"] == 2 * radius + 1
        mask = fits.getdata(candidate["mask_path"]).astype(bool)
        np.testing.assert_array_equal(mask, construct_arc_mask(
            snr, modeling_mask=excluded, threshold=threshold,
            ignor_size=8, ext_size=2 * radius + 1, close_size=3,
        ).feature_mask)
        assert not mask[30 - radius, 31 - radius]
        assert mask[29 - radius, 31 - radius]
        assert mask[excluded].all()

    select_stage_b_candidate(run, 0, 5, "The expanded arc footprint covers the bright image.", restart=False)
    config_path = prepare_attempt(run, StageName.B, 0)
    attempt = config_path.parent
    config = EffectiveConfig.model_validate_json(config_path.read_bytes())
    assert (config.settings.arc_snr_threshold, config.settings.arc_ext_size) == (5, 3)
    diagnostics = attempt / "diagnostics"
    diagnostics.mkdir()
    pipeline = _load_pipeline_template(monkeypatch)
    pipeline.configure_runtime(config=config.settings, artifact_dir=attempt / "artifacts",
                               diagnostics_dir=diagnostics, upstream_dirs={}, stage_attempt_reference="attempts/b/0")
    family = json.loads((run / "attempts/a/0" / FAMILY_REFERENCE).read_bytes())
    pipeline.run_stage_b(snr, np.ones_like(snr), np.zeros_like(snr), family, modeling_mask=excluded)
    attach_stage_b_prescan(run, 0, attempt)  # Requires exact equality with the selected FITS mask.

    packet["candidates"][0]["arc_ext_size"] = True
    _json(manifest, packet)
    with pytest.raises(ValueError, match="invalid expansion size"):
        validate_stage_b_candidate(run, 0, 1)


def test_prescan_resumes_a_frozen_legacy_threshold_package(tmp_path):
    lens, run, _, _ = _prepared_run(tmp_path)
    manifest = generate_stage_b_candidates(lens, run)
    packet = json.loads(manifest.read_bytes())
    packet["candidates"] = [entry for entry in packet["candidates"] if 2 <= entry["threshold"] <= 10]
    _json(manifest, packet)
    for threshold in (1, *range(11, 21)):
        manifest.with_name(f"threshold-{threshold}.fits").unlink()
    files = {path: file_sha256(path) for path in manifest.parent.iterdir()}

    assert generate_stage_b_candidates(lens, run) == manifest
    for threshold in (2, 10):
        assert validate_stage_b_candidate(run, 0, threshold)["threshold"] == threshold
    for threshold in (1, 11, 20):
        with pytest.raises(ValueError, match="absent from the frozen Stage B prescan"):
            validate_stage_b_candidate(run, 0, threshold)
    assert {path: file_sha256(path) for path in manifest.parent.iterdir()} == files

    del packet["candidates"][2]
    _json(manifest, packet)
    with pytest.raises(ValueError, match="invalid threshold list"):
        generate_stage_b_candidates(lens, run)


def test_prescan_rejects_changed_evidence_and_selection_bytes(tmp_path):
    lens, run, _, _ = _prepared_run(tmp_path)
    manifest = generate_stage_b_candidates(lens, run)
    manifest_bytes = manifest.read_bytes()
    threshold = manifest.with_name("threshold-3.fits")
    threshold_bytes = threshold.read_bytes()
    for invalid in (0, 3.5, 21):
        with pytest.raises(ValueError, match="integer threshold"):
            validate_stage_b_candidate(run, 0, invalid)
    with fits.open(threshold, mode="update", memmap=False) as hdus:
        hdus[0].data[11, 11] = 1
    with pytest.raises(ValueError, match="checksum mismatch"):
        validate_stage_b_candidate(run, 0, 3)
    packet = json.loads(manifest_bytes)
    packet["candidates"][2]["mask_sha256"] = file_sha256(threshold)
    _json(manifest, packet)
    with pytest.raises(ValueError, match="differs from the frozen Stage A inputs"):
        validate_stage_b_candidate(run, 0, 3)
    threshold.write_bytes(threshold_bytes)
    manifest.write_bytes(manifest_bytes)

    comparison = manifest.with_name("comparison.png")
    png = comparison.read_bytes()
    comparison.write_bytes(png + b"altered")
    with pytest.raises(ValueError, match="comparison checksum mismatch"):
        validate_stage_b_candidate(run, 0, 3)
    comparison.write_bytes(png)

    mask = run / MASK_REFERENCE
    mask_bytes = mask.read_bytes()
    with fits.open(mask, mode="update", memmap=False) as hdus:
        # Keep the same fitted pixel count but change the valid region.
        hdus[0].data[0, 0], hdus[0].data[11, 11] = 0, 1
    with pytest.raises(ValueError, match="domain used by accepted Stage A"):
        validate_stage_b_candidate(run, 0, 3)
    mask.write_bytes(mask_bytes)

    accepted = run / "accepted/a.json"
    accepted_bytes = accepted.read_bytes()
    head = json.loads(accepted_bytes)
    head["attempt_path"] = "../attempts/a/1"
    _json(accepted, head)
    with pytest.raises(ValueError, match="exact attempt"):
        validate_stage_b_candidate(run, 0, 3)
    accepted.write_bytes(accepted_bytes)

    (run / "attempts/a/0" / PKL_REFERENCE).write_bytes(b"unsealed pickle")
    with pytest.raises(ValueError, match="no longer matches its adjudicated evidence"):
        validate_stage_b_candidate(run, 0, 3)
