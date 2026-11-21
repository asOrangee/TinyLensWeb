import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

from lens_agent import stage_b_candidates
from lens_agent.attempts import CORE_EVIDENCE_FILES, configuration_bundle, prepare_attempt
from lens_agent.cli import build_parser
from lens_agent.configuration import EffectiveConfig, PIPELINE_RELEASE_ID, PipelineConfig
from lens_agent.models import StageName
from lens_agent.stage_b_selection import (
    SELECTION_FILE,
    attach_stage_b_prescan,
    is_superseded_stage_b_review,
    select_stage_b_candidate,
    stage_b_candidate_attempt,
)


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _run(tmp_path):
    run = tmp_path / "lens"
    settings = PipelineConfig(arc_snr_threshold=3.0, arc_ignor_size=8)
    _write(run / "run-manifest.json", {
        "schema_version": "lens_run_manifest.v1",
        "pipeline_release_id": PIPELINE_RELEASE_ID,
        "run_id": "stage-b-test",
        "lens_dir": str(tmp_path / "input" / "lens"),
        "input_geometry": {"pixel_scale_arcsec": .1, "input_x_direction": "increasing", "input_y_direction": "increasing"},
    })
    config = EffectiveConfig(settings=settings).model_dump(mode="json")
    _write(run / "attempts/a/0/effective-config.json", config)
    _write(run / "accepted/a.json", {
        "stage": "a", "effective_config": "../attempts/a/0/effective-config.json",
    })
    return run, config


def _terminal_b(run, config):
    parent = run / "attempts/b/0"
    _write(parent / "effective-config.json", config)
    decision = {
        "schema_version": "stage_decision.v1", "stage": "b", "attempt": 0, "decision": "human_review",
        "evidence_sha256": {
            name: hashlib.sha256((parent / name).read_bytes()).hexdigest() if (parent / name).is_file() else None
            for name in CORE_EVIDENCE_FILES
        },
    }
    path = parent / "decision.json"
    _write(path, decision)
    return path, decision


def _candidate(monkeypatch, run, attempt, threshold=6):
    folder = run / "stage-b-candidates" / str(attempt)
    folder.mkdir(parents=True)
    mask = folder / f"threshold-{threshold}.fits"
    comparison = folder / "comparison.png"
    fits.writeto(mask, np.array([[0, 1], [1, 0]], dtype=np.uint8))
    comparison.write_bytes(b"prescan diagnostic")
    entry = {
        "manifest_sha256": "1" * 64,
        "mask_sha256": hashlib.sha256(mask.read_bytes()).hexdigest(),
        "mask_path": mask,
        "comparison_sha256": hashlib.sha256(comparison.read_bytes()).hexdigest(),
        "comparison_path": comparison,
        "arc_ignor_size": 8,
        "arc_ext_size": 5,
        "arc_close_size": 3,
    }

    def validate(output_dir: Path, selected_attempt: int, selected_threshold: int):
        assert (output_dir, selected_attempt, selected_threshold) == (run, attempt, threshold)
        return entry

    monkeypatch.setattr(stage_b_candidates, "validate_stage_b_candidate", validate)


@pytest.mark.parametrize("threshold", [1, 6, 20])
def test_initial_selection_prepares_one_attempt_without_creating_retries(tmp_path, monkeypatch, threshold):
    run, _ = _run(tmp_path)
    assert stage_b_candidate_attempt(run, restart=False) == 0
    _candidate(monkeypatch, run, 0, threshold)
    selection = select_stage_b_candidate(run, 0, threshold, "Observed arc support.", restart=False)
    assert not (run / "attempts/b").exists()
    assert select_stage_b_candidate(run, 0, threshold, "Observed arc support.", restart=False) == selection
    bundle = configuration_bundle(run, StageName.B, 0)
    assert bundle["effective-config.json"]["settings"]["arc_snr_threshold"] == float(threshold)
    assert bundle["effective-config.json"]["parent_config"] == "attempts/a/0/effective-config.json"
    assert "proposal-validation.json" not in bundle
    prepared = prepare_attempt(run, StageName.B, 0).parent
    (prepared / "diagnostics").mkdir()
    (prepared / "artifacts").mkdir()
    mask = prepared / "artifacts/feature_mask.fits"
    fits.writeto(mask, np.array([[0, 0], [1, 0]], dtype=np.uint8))
    with pytest.raises(ValueError, match="different pixels"):
        attach_stage_b_prescan(run, 0, prepared)
    fits.writeto(mask, np.array([[0, 1], [1, 0]], dtype=np.uint8), overwrite=True)
    artifacts = attach_stage_b_prescan(run, 0, prepared)
    assert artifacts["stage_b_candidate_selection"] == SELECTION_FILE
    assert (prepared / artifacts["stage_b_prescan_png"]).read_bytes() == b"prescan diagnostic"


@pytest.mark.parametrize(("threshold", "valid"), [("1", True), ("20", True), ("0", False), ("21", False), ("4.5", False)])
def test_stage_b_select_cli_uses_integer_prescan_bounds(tmp_path, threshold, valid):
    command = ["stage-b", "select", "--output-dir", str(tmp_path), "--attempt", "0",
               "--threshold", threshold, "--reason", "Observed arc support."]
    if valid:
        assert build_parser().parse_args(command).threshold == int(threshold)
    else:
        with pytest.raises(SystemExit) as error:
            build_parser().parse_args(command)
        assert error.value.code == 2


def test_explicit_stage_b_restart_preserves_the_historical_review_and_accepted_a(tmp_path, monkeypatch):
    run, config = _run(tmp_path)
    prior, decision = _terminal_b(run, config)
    head = (run / "accepted/a.json").read_bytes()
    original = prior.read_bytes()
    assert stage_b_candidate_attempt(run, restart=True) == 1
    with pytest.raises(ValueError, match="explicit restart"):
        stage_b_candidate_attempt(run, restart=False)
    _candidate(monkeypatch, run, 1)
    assert not is_superseded_stage_b_review(run, prior)
    select_stage_b_candidate(run, 1, 6, "Preserves the predicted images.", restart=True)
    assert is_superseded_stage_b_review(run, prior)
    bundle = configuration_bundle(run, StageName.B, 1)
    assert bundle[SELECTION_FILE]["restart_of"]["path"] == "attempts/b/0/decision.json"
    assert bundle["effective-config.json"]["settings"]["arc_snr_threshold"] == 6
    assert "proposal-validation.json" not in bundle
    assert prior.read_bytes() == original
    assert (run / "accepted/a.json").read_bytes() == head
    _write(prior, {**decision, "reason": "changed evidence"})
    assert not is_superseded_stage_b_review(run, prior)
    with pytest.raises(ValueError, match="restart evidence"):
        configuration_bundle(run, StageName.B, 1)


def test_stage_b_restart_rejects_downstream_work_or_an_already_accepted_mask(tmp_path):
    run, config = _run(tmp_path)
    _terminal_b(run, config)
    next_stage = run / "attempts/m0/0/effective-config.json"
    _write(next_stage, config)
    with pytest.raises(ValueError, match="downstream attempt"):
        stage_b_candidate_attempt(run, restart=True)
    (run / "accepted/b.json").touch()
    with pytest.raises(ValueError, match="accepted B"):
        stage_b_candidate_attempt(run, restart=True)
