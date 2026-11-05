"""Exercise parameter restoration with the real TinyLensGpu/caskade models."""
from __future__ import annotations

import numpy as np
import pytest


def _likelihood(n=4, rho_mode="dynamic"):
    pytest.importorskip("TinyLensGpu")
    from lens_agent.modeling import pipeline_template as p

    mass = p.SIE(theta_E=p.ParamU("theta_E", 1.25), e1=0.12, e2=-0.11,
                 center_x=0.05, center_y=-0.05)
    mass.theta_E.to_dynamic()
    rho = p.ParamU("adaptive_reg_rho", 2.0)
    rho.to_dynamic()
    if rho_mode == "static":
        rho.to_static()
    elif rho_mode == "scalar":
        rho = 2.0
    source = p.PixelizedSourceModel(
        n=n, log_lambda_reg=0.0, adaptive_reg_rho=rho,
        regularization_type=p.REGULARIZATION_TYPE,
    )
    image = np.ones((8, 8))
    likelihood = p._pixel_likelihood(
        image, image, np.ones((1, 1)), np.zeros_like(image, dtype=bool),
        None, (mass, p.Shear(gamma1=0.0, gamma2=0.0)), source, None,
        fixed_source_bbox=(-0.79, 0.79, -0.79, 0.79),
        fixed_reg_template=np.linspace(0.1, 1.0, n*n),
    )
    medians = {"theta_E": 1.13, "adaptive_reg_rho": 5.47}
    names = [param.name for param in likelihood.get_dynamic_params()]
    return p, likelihood, medians, names


def test_pixel_overlay_uses_posterior_parameters_and_restores_model(tmp_path, monkeypatch):
    p, likelihood, medians, names = _likelihood(n=80)
    grid = p.source_grid_spec(center_x=0.0, center_y=0.0, level=0)
    solved = {
        "model_1d": np.ones(64), "source_image": np.ones((80, 80)),
        "source_bbox": grid["pixel_center_bbox"],
    }
    seen = []

    def overlay(*, lens_mass, **kwargs):
        seen.append(float(lens_mass.lens_mass[0].theta_E.value))

    monkeypatch.setattr(p, "overlay_critical_and_caustics", overlay)
    p._plot_pixel_stage(
        "Stage M1", likelihood, solved, tmp_path / "model.png", grid,
        medians=medians, names=names,
    )
    assert seen == pytest.approx([1.13])
    assert float(likelihood.phys_model.lens_mass[0].theta_E.value) == pytest.approx(1.25)


@pytest.mark.parametrize("rho_mode", ["dynamic", "static", "scalar"])
def test_source_solution_reports_evaluated_rho_after_context_exit(rho_mode):
    p, likelihood, medians, names = _likelihood(rho_mode=rho_mode)
    solved = p._solve_source(likelihood, medians, names)
    assert solved["adaptive_reg_rho"] == pytest.approx(5.47 if rho_mode == "dynamic" else 2.0)
    rho = likelihood.phys_model.source_light[0].adaptive_reg_rho
    assert float(getattr(rho, "value", rho)) == pytest.approx(2.0)


@pytest.mark.parametrize("scale", [0.05, 0.1])
def test_real_observation_models_use_configured_native_pixel_grid(tmp_path, monkeypatch, scale):
    """Check both TinyLens grids numerically; no posterior sampling is performed."""
    pytest.importorskip("TinyLensGpu")
    from lens_agent.configuration import PipelineConfig
    from lens_agent.modeling import pipeline_template as p

    for name in ("_CONFIG", "DPIX", "OUT_DIR", "DIAGNOSTICS_DIR", "_UPSTREAM_DIRS",
                 "_ARC_DROP_COMPONENT_IDS", "_STAGE_ATTEMPT_REFERENCE"):
        monkeypatch.setattr(p, name, getattr(p, name))
    p.configure_runtime(
        config=PipelineConfig(pixel_scale_arcsec=scale, input_y_direction="decreasing"),
        artifact_dir=tmp_path / "artifacts", diagnostics_dir=tmp_path / "diagnostics",
        upstream_dirs={},
    )
    image = np.ones((9, 9))
    mask = np.zeros_like(image, dtype=bool)
    psf = np.ones((1, 1))
    parametric = p.build_stage_a_likelihood(image, image, psf, mask)
    mass = p.SIE(theta_E=1.25, e1=0.12, e2=-0.11, center_x=0.05, center_y=-0.05)
    source = p.PixelizedSourceModel(n=4, log_lambda_reg=0.0, adaptive_reg_rho=2.0,
                                    regularization_type=p.REGULARIZATION_TYPE)
    pixelized = p._pixel_likelihood(
        image, image, psf, mask, None,
        (mass, p.Shear(gamma1=0.0, gamma2=0.0)), source, None,
        fixed_source_bbox=(-0.2, 0.2, -0.2, 0.2),
        fixed_reg_template=np.ones(4 * 4),
    )
    expected = (np.arange(9) - 4) * scale
    for likelihood in (parametric, pixelized):
        grid = likelihood.sim_obj.sim_config
        assert grid.dpix == scale
        np.testing.assert_allclose(np.asarray(grid.xgrid)[4, :], expected, atol=1e-7)
        np.testing.assert_allclose(np.asarray(grid.ygrid)[:, 4], expected, atol=1e-7)
        np.testing.assert_allclose(np.asarray(grid.xgrid_sub).mean(axis=0).reshape(9, 4).mean(axis=1),
                                   expected, atol=1e-7)
