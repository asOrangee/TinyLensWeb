"""Capture display arrays at the same parameters and source solution as diagnostics."""

import logging

import jax
import jax.numpy as jnp
import numpy as np

from ..workbench_display import active_capture, image_bounds, record_prediction


CURVE_GRID_SIZE = 512


def _number(profile, name):
    value = getattr(profile, name)
    return float(np.asarray(getattr(value, "value", value)))


def _curve_pairs(lens_mass, bounds):
    from TinyLensGpu.utils.lensing.critical_line import compute_critical_and_caustics

    critical_paths, caustic_paths = compute_critical_and_caustics(
        lens_mass, x_range=tuple(bounds[:2]), y_range=tuple(bounds[2:]), n_grid=CURVE_GRID_SIZE,
    )
    curves = []
    for critical, caustic in zip(critical_paths, caustic_paths, strict=True):
        image = np.column_stack(critical)
        source = np.column_stack(caustic)
        if image.shape != source.shape or len(image) < 2 or not np.isfinite([image, source]).all():
            raise ValueError("Invalid critical curve and caustic pair")
        curves.append({
            "critical": [{"x": float(x), "y": float(y)} for x, y in image],
            "caustic": [{"x": float(x), "y": float(y)} for x, y in source],
            "closed": bool(np.array_equal(image[0], image[-1])),
        })
    return curves


def _mapping(capture, likelihood, shape):
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
    capture["mass_parameters"] = {key: value for key, value in model.items() if key != "kind"}

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
    bounds = image_bounds(shape, float(likelihood.sim_obj.sim_config.dpix))
    try:
        curves = _curve_pairs(likelihood.phys_model, bounds)
    except Exception as error:
        logging.getLogger(__name__).warning("Workbench critical curves unavailable: %s", error)
        curves = None
    return {"model": model, "references": references, "curves": curves,
            "curve_sampling": {"n_grid": CURVE_GRID_SIZE, "bounds_arcsec": bounds}}


def _record_mapping(capture, likelihood, shape):
    try:
        capture["mapping"] = _mapping(capture, likelihood, shape)
    except Exception as error:
        logging.getLogger(__name__).warning(f"Workbench lens mapping unavailable: {error}")


def capture_parametric(likelihood, result):
    capture = active_capture()
    if capture is None:
        return
    capture["planes"] = {}
    try:
        intensities = result[2]
        physical = likelihood.sim_obj.phys_model
        source_count = len(physical.source_light)
        values = np.asarray(intensities, dtype=float)
        if values.shape == (source_count + len(physical.lens_light),) and np.isfinite(values).all():
            capture["linear_parameters"] = {
                "source_mge_amplitudes": {"values": values[:source_count].tolist()},
                "lens_mge_amplitudes": {"values": values[source_count:].tolist()},
            }
        record_prediction(capture, likelihood.image_data, likelihood.noise_map, result[1], result[0])
        from TinyLensGpu.ForwardSimulation.LensImage.config import make_grid_2d

        x, y = map(jnp.asarray, make_grid_2d(200, .01, 1))
        source = []
        for index, profile in enumerate(physical.source_light):
            amplitude = next(name for name in ("flux", "Ie", "amp", "intensity", "I0") if hasattr(profile, name))
            source.append(np.asarray(profile.light(x=x, y=y, **{amplitude: intensities[index]})))
        capture["planes"]["source"] = np.sum(np.stack(source), axis=0)
        capture["source_bounds"] = [-1., 1., -1., 1.]
    except Exception as error:
        logging.getLogger(__name__).warning(f"Workbench parametric planes unavailable: {error}")
    _record_mapping(capture, likelihood, likelihood.image_data.shape)


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
        pixels = jnp.asarray(solved["source_pixels"])
        psf_response = getattr(sim, "psf_response", None)
        if psf_response is None:
            lensed = op._apply_L_jit(pixels, data.weights, data.indices, data.flat_indices,
                                    height, width, data.nsub, data.agg_segment_ids, data.agg_n_active)
            projection = op._psf_convolve_full_jit(lensed, sim._psf_fft, height, width)
        else:
            brightness = op.render_source(pixels, data.weights, data.indices,
                                          data.render_parents, data.nsub, data.n_render)
            projection = psf_response.full_image(brightness)
        full = np.array(projection, dtype=float, copy=True).reshape(-1)
        active = np.asarray(sim.flat_indices)
        saved = np.asarray(solved["model_1d"])
        fitted = full[active]
        if (fitted.shape != saved.shape or not np.isfinite(full).all()
                or not np.allclose(fitted, saved, rtol=2e-5, atol=1e-6)):
            raise ValueError("Full-grid prediction disagrees with the saved active pixels")
        full[active] = saved
        record_prediction(capture, observation, likelihood.noise_map, lens_light, full.reshape(height, width))
    except Exception as error:
        logging.getLogger(__name__).warning(f"Workbench full-grid projection unavailable: {error}")
    _record_mapping(capture, likelihood, observation.shape)
