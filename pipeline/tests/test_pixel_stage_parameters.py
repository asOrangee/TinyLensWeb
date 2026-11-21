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
    from lens_agent.modeling.source_grid import source_grid_spec

    grid = source_grid_spec(center_x=0.0, center_y=0.0, level=0)
    n = grid["nsrc"]
    p, likelihood, medians, names = _likelihood(n=n)
    solved = {
        "model_1d": np.ones(64), "source_image": np.ones((n, n)),
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
    assert likelihood.solver_type == "fista"
    assert np.all(solved["source_pixels"] >= 0.0)
    expected_rho = 5.47 if rho_mode == "dynamic" else 2.0
    assert solved["adaptive_reg_rho"] == pytest.approx(expected_rho)
    template = np.linspace(0.1, 1.0, 16)
    brightness = np.clip(template / np.percentile(template, 99.5), 0, 1)
    np.testing.assert_allclose(solved["reg_scale_image"].ravel(), np.exp(expected_rho * (1 - brightness)), rtol=2e-6)
    rho = likelihood.phys_model.source_light[0].adaptive_reg_rho
    assert float(getattr(rho, "value", rho)) == pytest.approx(2.0)


def test_m0_scan_does_not_treat_failed_source_solves_as_evidence():
    pytest.importorskip("TinyLensGpu")
    from lens_agent.modeling.pipeline_template import _scan_m0_evidence

    grid = np.arange(3.0)
    np.testing.assert_array_equal(
        _scan_m0_evidence(lambda _: [-1.0e10, -45.0, np.nan], grid, "coarse"),
        [-np.inf, -45.0, -np.inf],
    )
    with pytest.raises(RuntimeError, match="fine evidence grid has no converged"):
        _scan_m0_evidence(lambda _: [-1.0e10, np.nan, np.inf], grid, "fine")


def test_stage_a_workbench_exports_mapping_at_posterior_medians():
    pytest.importorskip("TinyLensGpu")
    from lens_agent.modeling import pipeline_template as p
    from lens_agent.workbench_display import capture_model_planes

    image = np.linspace(0.1, 1.0, 16 * 16).reshape(16, 16)
    exclusion = np.zeros_like(image, dtype=bool)
    exclusion[5:7, 9] = True
    likelihood = p.build_stage_a_likelihood(image, np.full_like(image, 0.05), np.ones((1, 1)), exclusion)
    names = [param.name for param in likelihood.get_dynamic_params()]
    mass_parameters = {
        "theta_E": 0.55, "e1_mass": 0.07, "e2_mass": -0.11,
        "center_x_mass": 0.05, "center_y_mass": -0.02, "gamma1": 0.03, "gamma2": 0.04,
    }
    medians = dict.fromkeys(names, 0.0) | mass_parameters
    with capture_model_planes() as capture:
        p._parametric_planes(likelihood, medians, names)

    np.testing.assert_array_equal(capture["valid_domain"], ~exclusion)
    mapping = capture["mapping"]
    assert mapping["model"]["kind"] == "sie-shear"
    assert capture["mass_parameters"] == pytest.approx(mass_parameters)
    assert mapping["curves"]
    rays = mapping["references"]
    x, y = (p.jnp.asarray([ray["image"][key] for ray in rays]) for key in ("x", "y"))
    source = [[ray["source"]["x"], ray["source"]["y"]] for ray in rays]
    expected = likelihood.phys_model.deflection(x=x, y=y)
    np.testing.assert_allclose(source, np.column_stack(expected), atol=1e-6)


@pytest.mark.parametrize("mass_kind", ["sie-shear", "epl-shear"])
def test_pixel_workbench_exports_full_cutout_and_keeps_fitted_pixels(mass_kind):
    pytest.importorskip("TinyLensGpu")
    from lens_agent.modeling import pipeline_template as p
    from lens_agent.modeling.workbench_planes import capture_pixelized
    from lens_agent.workbench_display import capture_model_planes

    mass_params = dict(theta_E=p.ParamU("theta_E", 0.16), e1=0.12, e2=-0.11,
                       center_x=0.012, center_y=-0.014)
    mass = p.SIE(**mass_params) if mass_kind == "sie-shear" else p.EPL(gamma=1.95, **mass_params)
    mass.theta_E.to_dynamic()
    shear = p.Shear(gamma1=0.01, gamma2=0.02)
    strength = p.ParamU("log_lambda_reg", 0.0)
    strength.to_dynamic()
    source = p.PixelizedSourceModel(n=6, log_lambda_reg=strength, regularization_type=p.REGULARIZATION_TYPE,
                                    adaptive_reg_rho=2.0)
    observation = np.full((9, 9), 0.4)
    lens_light = np.full_like(observation, 0.1)
    noise = np.full_like(observation, 0.2)
    psf = np.array([[0.01, 0.04, 0.08], [0.05, 0.40, 0.12], [0.02, 0.10, 0.18]])
    feature_mask = np.ones_like(observation, dtype=bool)
    feature_mask[2:7, 2:7] = False
    contamination_mask = np.zeros_like(feature_mask)
    contamination_mask[4, 5] = True
    mask = feature_mask | contamination_mask
    bbox = (-0.3, 0.3, -0.3, 0.3)
    template = np.linspace(-0.1, 1.0, 36)
    likelihood = p._pixel_likelihood(
        observation - lens_light, noise, psf, feature_mask, contamination_mask, (mass, shear), source, None,
        fixed_source_bbox=bbox, fixed_reg_template=template,
    )
    names = [param.name for param in likelihood.get_dynamic_params()]
    medians = {"theta_E": 0.16, "log_lambda_reg": 0.0}
    solved = p._solve_source(likelihood, medians, names)
    with p.ck.ActiveContext(likelihood), capture_model_planes() as capture:
        likelihood.fill_params(p.jnp.asarray([medians[name] for name in names]))
        capture_pixelized(likelihood, solved, bbox, observation, lens_light)
        for pair in capture["mapping"]["curves"]:
            stride = max(1, len(pair["critical"]) // 6)
            image_points = pair["critical"][::stride]
            x, y = (p.jnp.asarray([point[key] for point in image_points]) for key in ("x", "y"))
            dx, dy = mass.deriv(x, y)
            gx, gy = shear.deriv(x, y)
            expected = np.column_stack((x - dx - gx, y - dy - gy))
            saved_source = [[point["x"], point["y"]] for point in pair["caustic"][::stride]]
            np.testing.assert_allclose(saved_source, expected, atol=1e-6)
        different_mass = {**medians, "theta_E": 0.19}
        likelihood.fill_params(p.jnp.asarray([different_mass[name] for name in names]))
        np.testing.assert_array_equal(likelihood._get_reg_scale(), solved["reg_scale_image"].ravel())

    planes = capture["planes"]
    np.testing.assert_array_equal(capture["valid_domain"], ~mask)
    assert set(planes) == {"source", "source-lensed", "lens-light", "model", "residual", "chi-square"}
    np.testing.assert_array_equal(planes["lens-light"], lens_light)
    lensed = planes["source-lensed"]
    assert lensed.shape == observation.shape
    np.testing.assert_array_equal(lensed[~mask], solved["model_1d"])
    assert np.any(np.abs(lensed[mask]) > 1e-4)
    np.testing.assert_array_equal(planes["model"], lens_light + lensed)
    fitted_noise = np.asarray(likelihood.noise_map, dtype=float)
    np.testing.assert_array_equal(planes["residual"], (observation - planes["model"]) / fitted_noise)
    np.testing.assert_array_equal(planes["chi-square"], planes["residual"] ** 2)
    np.testing.assert_array_equal(planes["source"], solved["source_image"])
    mapping = capture["mapping"]
    assert mapping["model"]["kind"] == mass_kind
    assert mapping["model"]["theta_E"] == pytest.approx(0.16)
    assert mapping["curves"]
    for pair in mapping["curves"]:
        assert len(pair["critical"]) == len(pair["caustic"]) > 1
        assert all(np.isfinite([point["x"], point["y"]]).all()
                   for path in (pair["critical"], pair["caustic"]) for point in path)


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
