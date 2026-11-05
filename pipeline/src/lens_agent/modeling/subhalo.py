"""SIS extension of the accepted M3 model, using existing posterior transfer tools."""
from __future__ import annotations

import json
import time
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import Ellipse
import numpy as np

from . import pipeline_template as p
from TinyLensGpu.PhysicalModel.LensImage.Parametric.Mass import SIS
from ..subhalo import EVIDENCE_INTERPRETATION


def mass_from_m3(stage_m3, stage_a):
    cfg = p.get_config()
    mass = p.EPL(
        theta_E=stage_m3.gaussian("theta_E", model="EPL", attr="theta_E",
                                limits=list(cfg.stage_m3_theta_E_prior_limits)),
        gamma=stage_m3.gaussian("gamma", model="EPL", attr="gamma",
                              limits=list(cfg.stage_m3_gamma_prior.limits)),
        e1=stage_m3.gaussian("e1_mass", model="EPL", attr="e1",
                           limits=list(cfg.stage_m3_ellipticity_prior_limits)),
        e2=stage_m3.gaussian("e2_mass", model="EPL", attr="e2",
                           limits=list(cfg.stage_m3_ellipticity_prior_limits)),
        center_x=stage_a.fixed("center_x_mass"), center_y=stage_a.fixed("center_y_mass"),
    )
    shear = p.Shear(
        gamma1=stage_m3.gaussian("gamma1", model="Shear", attr="gamma1",
                               limits=list(cfg.stage_m3_shear_prior_limits)),
        gamma2=stage_m3.gaussian("gamma2", model="Shear", attr="gamma2",
                               limits=list(cfg.stage_m3_shear_prior_limits)),
    )
    return mass, shear


def sis_from_candidate(candidate):
    theta = p.ParamU("theta_E_subhalo", 0.05, prior_type="uniform",
                     prior_settings=candidate["theta_E_limits"], limits=candidate["theta_E_limits"])
    x = p.ParamU("center_x_subhalo", candidate["center_x"], prior_type="gaussian",
                 prior_settings=[candidate["center_x"], candidate["sigma_x"]], limits=[-np.inf, np.inf])
    y = p.ParamU("center_y_subhalo", candidate["center_y"], prior_type="gaussian",
                 prior_settings=[candidate["center_y"], candidate["sigma_y"]], limits=[-np.inf, np.inf])
    for param in (theta, x, y):
        param.to_dynamic()
    return SIS(theta_E=theta, center_x=x, center_y=y)


def pixel_likelihood(image, noise, psf, feature, mask, profiles, position, reg, s1, grid):
    log_lambda = p.ParamU("log_lambda_reg", reg["log_lambda_reg"])
    rho = p.ParamU("adaptive_reg_rho", reg["adaptive_reg_rho"])
    log_lambda.to_static()
    rho.to_static()
    source = p.PixelizedSourceModel(n=grid["nsrc"], log_lambda_reg=log_lambda,
                                   regularization_type=p.REGULARIZATION_TYPE, adaptive_reg_rho=rho)
    return p._pixel_likelihood(image, noise, psf, feature, mask, profiles, source, position,
                               **p._fixed_source_template_kwargs(s1, grid))


def image_arrays(likelihood, solved):
    image = np.asarray(likelihood.image_data)
    valid = np.asarray(likelihood.unmask, dtype=bool)
    model = np.zeros_like(image, dtype=float)
    model[valid] = solved["model_1d"]
    residual = np.zeros_like(image, dtype=float)
    residual[valid] = (image[valid] - model[valid]) / np.asarray(likelihood.noise_map)[valid]
    return image, model, residual, valid


def image_extent(shape):
    ny, nx = shape
    return (-nx*p.DPIX/2, nx*p.DPIX/2, -ny*p.DPIX/2, ny*p.DPIX/2)


def mark_candidate(axis, candidate):
    x, y = candidate["center_x"], candidate["center_y"]
    axis.plot(x, y, marker="+", color="limegreen", ms=11, mew=1.8, label="Prior center")
    axis.add_patch(Ellipse((x, y), 2*candidate["sigma_x"], 2*candidate["sigma_y"],
                           fill=False, edgecolor="limegreen", lw=1.2))


def plot_candidate(image, residual, valid, candidate, target):
    extent = image_extent(image.shape)
    display = p._centered_unmasked_square_extent(~valid, p.DPIX)
    x, y = candidate["center_x"], candidate["center_y"]
    if not extent[0] <= x <= extent[1] or not extent[2] <= y <= extent[3]:
        raise ValueError("candidate center lies outside the observed image")
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.5), constrained_layout=True)
    vmax = max(1e-12, float(np.percentile(image[valid], 99.5)))
    for ax, data, title, cmap, limits in (
        (axes[0], image, "M3 lens-subtracted data", p.PLOT_CMAP_IMAGE, (0, vmax)),
        (axes[1], residual, "M3 normalized residual", p.PLOT_CMAP_RESIDUAL, (-3, 3)),
    ):
        artist = ax.imshow(np.ma.array(data, mask=~valid), origin="lower", extent=extent,
                           cmap=cmap, vmin=limits[0], vmax=limits[1])
        ax.set(xlim=display[:2], ylim=display[2:], title=title, xlabel="x [arcsec]", ylabel="y [arcsec]")
        mark_candidate(ax, candidate)
        fig.colorbar(artist, ax=ax, fraction=.046, pad=.04)
    axes[0].legend(loc="best")
    fig.suptitle(f"SIS candidate ({x:+.2f}, {y:+.2f}) arcsec; "
                 f"Gaussian sigma (x, y) = ({candidate['sigma_x']:.2f}, "
                 f"{candidate['sigma_y']:.2f}) arcsec")
    fig.savefig(target, dpi=160)
    plt.close(fig)


def plot_comparison(baseline, fitted, valid, candidate, medians, delta, target):
    extent = image_extent(baseline.shape)
    display = p._centered_unmasked_square_extent(~valid, p.DPIX)
    x, y = candidate["center_x"], candidate["center_y"]
    fig, axes = plt.subplots(2, 2, figsize=(10, 9), constrained_layout=True)
    for row in range(2):
        for col, data in enumerate((baseline, fitted)):
            ax = axes[row, col]
            artist = ax.imshow(np.ma.array(data, mask=~valid), origin="lower", extent=extent,
                               cmap=p.PLOT_CMAP_RESIDUAL, vmin=-3, vmax=3)
            bounds = display if row == 0 else (x-.4, x+.4, y-.4, y+.4)
            ax.set(xlim=bounds[:2], ylim=bounds[2:], xlabel="x [arcsec]", ylabel="y [arcsec]",
                   title=("M3" if col == 0 else "M3 + SIS") + (" local residual" if row else " residual"))
            mark_candidate(ax, candidate)
            ax.plot(medians["center_x_subhalo"], medians["center_y_subhalo"], "k*", ms=10, label="SIS posterior median")
            fig.colorbar(artist, ax=ax, fraction=.046, pad=.04)
    axes[0, 1].legend(loc="best")
    fig.suptitle(f"Normalized residual comparison; delta ln Z = {delta:+.3f}\nM3 posterior-derived macro priors; local candidate")
    fig.savefig(target, dpi=160)
    plt.close(fig)


def run_subhalo(image, noise, psf, feature, lens_light, stage_a, stage_m1, stage_m3,
                position, reg, s1, grid, candidate, mask, *, preview_only=False):
    started = time.monotonic()
    grid = p._validate_runtime_source_grid(grid)
    lens_subtracted = image - lens_light
    # Reproduce M3 at exactly its posterior medians; never resample or overwrite M3.
    baseline = pixel_likelihood(lens_subtracted, noise, psf, feature, mask,
                                p._free_epl(stage_m1, stage_a), position, reg, s1, grid)
    base_solved = p._solve_source(baseline, stage_m3.medians(), stage_m3.param_names)
    data, base_model, base_residual, valid = image_arrays(baseline, base_solved)
    p.DIAGNOSTICS_DIR.mkdir(parents=True, exist_ok=True)
    plot_candidate(data, base_residual, valid, candidate, p.DIAGNOSTICS_DIR / "subhalo_candidate.png")
    if preview_only:
        return
    profiles = (*mass_from_m3(stage_m3, stage_a), sis_from_candidate(candidate))
    likelihood = pixel_likelihood(lens_subtracted, noise, psf, feature, mask, profiles,
                                  position, reg, s1, grid)
    cfg = p.get_config()
    stage = p._sample(likelihood, n_live=cfg.stage_subhalo_n_live, n_eff=cfg.stage_subhalo_n_eff)
    medians = stage.medians()
    solved = p._solve_source(likelihood, medians, stage.param_names)
    _, model, residual, fitted_valid = image_arrays(likelihood, solved)
    if not np.array_equal(valid, fitted_valid):
        raise ValueError("subhalo and M3 comparison masks differ")
    delta = float(stage.log_z - stage_m3.log_z)
    if not np.isclose(stage_m3.log_z, candidate["m3"]["log_z"], rtol=0, atol=1e-8):
        raise ValueError("M3 pickle and stage result disagree on evidence")
    yy, xx = np.indices(data.shape)
    x_arcsec = (xx + .5 - data.shape[1]/2) * p.DPIX
    y_arcsec = (yy + .5 - data.shape[0]/2) * p.DPIX
    local = valid & ((x_arcsec-candidate["center_x"])**2 +
                     (y_arcsec-candidate["center_y"])**2 <= .4**2)
    comparison_stats = {}
    for label, region in (("global", valid), ("local", local)):
        comparison_stats[label] = {"pixel_count": int(region.sum())}
        for model_name, values in (("m3", base_residual), ("subhalo", residual)):
            comparison_stats[label][model_name + "_chi2"] = float(np.sum(values[region]**2))
            comparison_stats[label][model_name + "_rms"] = (
                float(np.sqrt(np.mean(values[region]**2))) if region.any() else None
            )
    p._save_stage("subhalo", stage, {
        "medians": medians, "mass_model": "EPL+Shear+SIS",
        "reg_hyperparams_fixed": dict(reg), "candidate": candidate,
        "log_z_m3": float(stage_m3.log_z), "delta_log_z": delta,
        "residual_comparison": comparison_stats,
        "evidence_interpretation": EVIDENCE_INTERPRETATION,
        "fixed_mass_center": {name: stage_a.median(name) for name in ("center_x_mass", "center_y_mass")},
        **p._pixelized_scientific_diagnostics(likelihood, solved),
        "time_taken": time.monotonic()-started,
    })
    p._plot_pixel_stage("Stage subhalo: EPL + shear + SIS", likelihood, solved,
                        p.DIAGNOSTICS_DIR / "stage_subhalo_model.png", grid,
                        medians=medians, names=stage.param_names, subhalo_marker=True)
    plot_comparison(base_residual, residual, valid, candidate, medians, delta,
                    p.DIAGNOSTICS_DIR / "subhalo_comparison.png")
    np.savez_compressed(p.OUT_DIR / "subhalo_comparison.npz", lens_subtracted=data,
                        m3_model=base_model, subhalo_model=model, m3_residual=base_residual,
                        subhalo_residual=residual, valid=valid, extent=image_extent(data.shape))
    (p.OUT_DIR / "subhalo_candidate.json").write_text(json.dumps(candidate, indent=2)+"\n")
    return stage, medians
