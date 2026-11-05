import pytest
from pydantic import ValidationError

from lens_agent.configuration import (
    CONFIG_SCHEMA_VERSION,
    PIPELINE_RELEASE_ID,
    EffectiveConfig,
    PipelineConfig,
    PriorConfig,
)
from lens_agent.modeling.source_grid import source_grid_spec, validate_source_grid_spec


def test_pipeline_priors_use_named_settings_and_limits() -> None:
    prior = PipelineConfig().stage_a_theta_E_prior

    assert prior.model_dump(mode="json") == {
        "prior_type": "uniform",
        "prior_settings": [0.5, 3.0],
        "limits": [0.5, 3.0],
    }


def test_mixture_prior_accepts_three_settings() -> None:
    prior = PriorConfig(
        prior_type="truncated_gaussian_uniform_mixture",
        prior_settings=[1.35, 0.405, 0.8],
        limits=[0.5, 3.0],
    )

    assert prior.prior_settings == (1.35, 0.405, 0.8)


def test_mixture_prior_rejects_invalid_core_weight() -> None:
    with pytest.raises(ValidationError, match="core weight"):
        PriorConfig(
            prior_type="truncated_gaussian_uniform_mixture",
            prior_settings=[1.35, 0.405, 1.0],
            limits=[0.5, 3.0],
        )


def test_stage_a_theta_e_initial_must_lie_within_prior_limits() -> None:
    with pytest.raises(ValidationError, match="theta_E initial value"):
        PipelineConfig(stage_a_theta_E_initial=6.0)


def test_prior_configuration_sequences_are_immutable() -> None:
    prior = PipelineConfig().stage_a_theta_E_prior

    with pytest.raises(TypeError):
        prior.limits[0] = 0.0


def test_fixed_source_grid_release_rejects_removed_stage_local_settings() -> None:
    assert CONFIG_SCHEMA_VERSION == "lens_pipeline_config.v5"
    assert PIPELINE_RELEASE_ID == "input-geometry.v1"
    assert "stage_m1_gamma_prior" not in EffectiveConfig().settings.model_dump()

    with pytest.raises(ValidationError, match="source_bbox_padding"):
        PipelineConfig(stage_m1_source_bbox_padding=0.2)


def test_source_grid_policy_maps_level_to_exact_pixel_footprint() -> None:
    initial = source_grid_spec(center_x=0.1, center_y=-0.2, level=0)
    assert {key: value for key, value in initial.items() if not key.endswith("bbox")} == {
        "schema_version": "source_grid_spec.v1",
        "anchor_center": {"x": 0.1, "y": -0.2},
        "grid_level": 0,
        "half_width_arcsec": 0.8,
        "pixel_scale_arcsec": 0.02,
        "nsrc": 80,
    }
    assert initial["footprint_bbox"] == pytest.approx([-0.7, 0.9, -1.0, 0.6])
    assert initial["pixel_center_bbox"] == pytest.approx([-0.69, 0.89, -0.99, 0.59])

    enlarged = source_grid_spec(center_x=0.1, center_y=-0.2, level=2)
    assert enlarged["half_width_arcsec"] == 1.2
    assert enlarged["nsrc"] == 120
    assert enlarged["pixel_center_bbox"] == pytest.approx(
        [-1.09, 1.29, -1.39, 0.99]
    )


def test_source_grid_spec_rejects_inconsistent_array_shape() -> None:
    spec = source_grid_spec(center_x=0.0, center_y=0.0, level=1)

    with pytest.raises(ValueError, match="array shape"):
        validate_source_grid_spec(spec, source_shape=(80, 80))

    assert validate_source_grid_spec(spec, source_shape=(100, 100)) == spec


def test_source_grid_spec_rejects_configuration_level_mismatch() -> None:
    spec = source_grid_spec(center_x=0.0, center_y=0.0, level=1)

    with pytest.raises(ValueError, match="does not match its configuration"):
        validate_source_grid_spec(spec, expected_level=0)
