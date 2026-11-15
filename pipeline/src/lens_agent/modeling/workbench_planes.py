"""Capture display arrays at the same parameters and source solution as diagnostics."""

import logging

import jax
import jax.numpy as jnp
import numpy as np

from ..workbench_display import active_capture, record_prediction


def _number(profile, name):
    value = getattr(profile, name)
    return float(np.asarray(getattr(value, "value", value)))


def _mapping(likelihood):
    mass, shear = likelihood.phys_model.lens_mass
    kind = {"SIE": "sie-shear", "EPL": "epl-shear"}[type(mass).__name__]
    model = {
        "kind": kind, "theta_E": _number(mass, "theta_E"),
        "e1_mass": _number(mass, "e1"), "e2_mass": _number(mass, "e2"),
        "center_x_mass": _number(mass, "center_x"), "center_y_mass": _number(mass, "center_y"),
        "gamma1": _number(shear, "gamma1"), "gamma2": _number(shear, "gamma2"),
    }
    if kind == "epl-shear":
        model["gamma"] = _number(mass, "gamma")

    def ray(point):
        mx, my = mass.deriv(point[0], point[1])
        gx, gy = shear.deriv(point[0], point[1])
        return point - jnp.stack((mx + gx, my + gy))

    points = jnp.asarray([[-2., -1.5], [-1.2, .8], [0.15, .2], [.4, -.6], [1.5, .1], [1.9, -1.2], [.3, 2.]])
    coordinates = np.asarray(jax.vmap(ray)(points))
    references = [
        {"image": {"x": float(x), "y": float(y)}, "source": {"x": float(u), "y": float(v)}}
        for (x, y), (u, v) in zip(np.asarray(points), coordinates)
    ]
    if kind == "epl-shear":
        determinants = np.asarray(jnp.linalg.det(jax.vmap(jax.jacfwd(ray))(points)))
        for entry, determinant in zip(references, determinants):
            entry["determinant"] = float(determinant)
    if not np.isfinite(coordinates).all() or any(
        "determinant" in entry and not np.isfinite(entry["determinant"]) for entry in references
    ):
        raise ValueError("Nonfinite reference rays")
    return {"model": model, "references": references}


def _record_mapping(capture, likelihood):
    try:
        capture["mapping"] = _mapping(likelihood)
    except Exception as error:
        logging.getLogger(__name__).warning(f"Workbench lens mapping unavailable: {error}")


def capture_parametric(likelihood, result):
    capture = active_capture()
    if capture is None:
        return
    capture["planes"] = {}
    try:
        record_prediction(capture, likelihood.image_data, likelihood.noise_map, result[1], result[0])
        intensities = result[2]
        from TinyLensGpu.ForwardSimulation.LensImage.config import make_grid_2d

        x, y = map(jnp.asarray, make_grid_2d(200, .01, 1))
        source = []
        for index, profile in enumerate(likelihood.sim_obj.phys_model.source_light):
            amplitude = next(name for name in ("flux", "Ie", "amp", "intensity", "I0") if hasattr(profile, name))
            source.append(np.asarray(profile.light(x=x, y=y, **{amplitude: intensities[index]})))
        capture["planes"]["source"] = np.sum(np.stack(source), axis=0)
        capture["source_bounds"] = [-1., 1., -1., 1.]
    except Exception as error:
        logging.getLogger(__name__).warning(f"Workbench parametric planes unavailable: {error}")
    _record_mapping(capture, likelihood)


def capture_pixelized(likelihood, solved, source_bounds, observation, lens_light):
    capture = active_capture()
    if capture is None:
        return
    capture["source_bounds"] = list(source_bounds)
    capture["planes"] = {"source": solved["source_image"]}
    try:
        from TinyLensGpu.ForwardSimulation.LensImage import pixelized_operator as op

        xmin, xmax, ymin, ymax, bx, by, _, _ = likelihood._get_bbox()
        sim = likelihood.sim_obj
        data = sim.precompute_operator_data(xmin, xmax, ymin, ymax, _betas_sub=(bx, by))
        height, width = sim.image_shape
        lensed = op._apply_L_jit(jnp.asarray(solved["source_pixels"]), data.weights, data.indices,
                                 data.flat_indices, height, width, data.nsub,
                                 data.agg_segment_ids, data.agg_n_active)
        full = np.asarray(op._psf_convolve_full_jit(lensed, sim._psf_fft, height, width), dtype=float).copy()
        active = np.asarray(sim.flat_indices)
        saved = solved["model_1d"]
        if not np.isfinite(full).all() or not np.allclose(full[active], saved, rtol=2e-5, atol=1e-6):
            raise ValueError("Full-grid prediction disagrees with the saved active pixels")
        full[active] = saved
        record_prediction(capture, observation, likelihood.noise_map, lens_light, full.reshape(height, width))
    except Exception as error:
        logging.getLogger(__name__).warning(f"Workbench full-grid projection unavailable: {error}")
    _record_mapping(capture, likelihood)
