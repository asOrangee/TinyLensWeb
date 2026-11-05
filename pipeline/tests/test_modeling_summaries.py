from __future__ import annotations

import json
import pickle

import numpy as np

from lens_agent import stages
from lens_agent.modeling.summaries import stage_summary
from lens_agent.models import StageName


def test_stage_summary_reports_continuous_prior_boundary_evidence() -> None:
    payload = {
        "samples": np.asarray([[0.0], [0.25], [0.75], [1.0]], dtype=float),
        "weights": np.full(4, 0.25),
        "param_names": ["theta_E"],
        "log_z": 2.0,
        "stage_schema": {
            "param_names": ["theta_E"],
            "prior_specs": [
                {
                    "name": "theta_E",
                    "prior_type": "uniform",
                    "settings": [0.0, 1.0],
                    "limits": [0.0, 1.0],
                }
            ],
        },
        "extra": {},
    }

    summary = stage_summary(payload, "m1")

    assert "boundary_flags" not in summary
    evidence = summary["prior_boundary_diagnostics"]["theta_E"]
    assert evidence["prior_limits"] == {"lower": 0.0, "upper": 1.0}
    assert evidence["posterior_width_q16_q84"] > 0
    assert evidence["near_boundary_reference_fraction_of_prior_width"] == 0.01
    assert evidence["posterior_mass_near_lower_limit"] == 0.25
    assert evidence["posterior_mass_near_upper_limit"] == 0.25
    for quantile in ("q16", "q50", "q84"):
        assert set(evidence["quantile_distances"][quantile]) == {
            "value",
            "to_lower_limit",
            "to_upper_limit",
            "to_nearest_limit",
            "nearest_over_posterior_width",
            "nearest_over_prior_width",
        }


def test_stage_summary_exposes_saved_scientific_diagnostics() -> None:
    source_sign = {"negative_pixel_fraction": 0.2}
    residual = {"all_valid_pixels": {"rms": 1.1}}
    payload = {
        "samples": np.asarray([[0.0], [1.0]], dtype=float),
        "weights": np.asarray([0.5, 0.5]),
        "param_names": ["x"],
        "log_z": 1.0,
        "stage_schema": {
            "param_names": ["x"],
            "prior_specs": [{"name": "x", "limits": [-1.0, 2.0]}],
        },
        "extra": {
            "source_sign_diagnostics": source_sign,
            "residual_diagnostics": residual,
        },
    }

    summary = stage_summary(payload, "m1")

    assert "source_bbox_info" not in summary
    assert summary["source_sign_diagnostics"] == source_sign
    assert summary["residual_diagnostics"] == residual


def test_stage_a_summary_reports_visual_prior_conflict_evidence() -> None:
    payload = {
        "samples": np.asarray([[1.0], [1.35], [1.7], [2.0]], dtype=float),
        "weights": np.full(4, 0.25),
        "param_names": ["theta_E"],
        "log_z": 2.0,
        "stage_schema": {"param_names": ["theta_E"], "prior_specs": []},
        "extra": {},
    }
    provenance = {
        "eligible": True,
        "theta_E_hint": {
            "estimate_arcsec": 1.35,
            "plausible_range_arcsec": [1.05, 1.7],
        },
        "effective_prior": {
            "prior_type": "truncated_gaussian_uniform_mixture",
            "prior_settings": [1.35, 0.405, 0.8],
            "limits": [0.5, 3.0],
        },
    }

    summary = stage_summary(payload, "a", visual_prior_provenance=provenance)

    evidence = summary["visual_prior_conflict_diagnostics"]
    assert evidence["posterior_median_arcsec"] == 1.35
    assert evidence["median_minus_hint_arcsec"] == 0.0
    assert evidence["median_minus_hint_in_core_sigma"] == 0.0
    assert evidence["posterior_mass_in_plausible_range"] == 0.5
    assert evidence["posterior_mass_within_one_core_sigma"] == 0.75
    assert "conflict" not in evidence


def test_stage_a_artifact_summary_reads_attempt_local_visual_prior_provenance(tmp_path) -> None:
    artifact_dir = tmp_path / "artifacts"
    diagnostics_dir = tmp_path / "diagnostics"
    artifact_dir.mkdir()
    diagnostics_dir.mkdir()
    payload = {
        "samples": np.asarray([[1.2], [1.35], [1.5]], dtype=float),
        "weights": np.full(3, 1 / 3),
        "param_names": ["theta_E"],
        "log_z": 2.0,
        "stage_schema": {"param_names": ["theta_E"], "prior_specs": []},
        "extra": {"medians": {"theta_E": 1.35}},
    }
    with (artifact_dir / "stage_a.pkl").open("wb") as handle:
        pickle.dump(payload, handle)
    (tmp_path / "visual-prior-provenance.json").write_text(
        json.dumps(
            {
                "eligible": True,
                "theta_E_hint": {
                    "estimate_arcsec": 1.35,
                    "plausible_range_arcsec": [1.05, 1.7],
                },
                "effective_prior": {
                    "prior_settings": [1.35, 0.405, 0.8],
                },
            }
        ),
        encoding="utf-8",
    )

    _, metrics = stages._summarize(artifact_dir, diagnostics_dir, StageName.A)

    assert "visual_prior_conflict_diagnostics" in metrics


def test_stage_a_retry_summary_reuses_attempt_zero_visual_prior_provenance(tmp_path) -> None:
    attempt_zero = tmp_path / "attempts" / "a" / "0"
    attempt_one = tmp_path / "attempts" / "a" / "1"
    artifact_dir = attempt_one / "artifacts"
    diagnostics_dir = attempt_one / "diagnostics"
    attempt_zero.mkdir(parents=True)
    artifact_dir.mkdir(parents=True)
    diagnostics_dir.mkdir()
    payload = {
        "samples": np.asarray([[1.2], [1.35], [1.5]], dtype=float),
        "weights": np.full(3, 1 / 3),
        "param_names": ["theta_E"],
        "log_z": 2.0,
        "stage_schema": {"param_names": ["theta_E"], "prior_specs": []},
        "extra": {"medians": {"theta_E": 1.35}},
    }
    with (artifact_dir / "stage_a.pkl").open("wb") as handle:
        pickle.dump(payload, handle)
    (attempt_zero / "visual-prior-provenance.json").write_text(
        json.dumps(
            {
                "eligible": True,
                "theta_E_hint": {
                    "estimate_arcsec": 1.35,
                    "plausible_range_arcsec": [1.05, 1.7],
                },
                "effective_prior": {"prior_settings": [1.35, 0.405, 0.8]},
            }
        ),
        encoding="utf-8",
    )

    _, metrics = stages._summarize(artifact_dir, diagnostics_dir, StageName.A)

    assert "visual_prior_conflict_diagnostics" in metrics
