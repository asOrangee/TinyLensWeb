"""Read-only diagnostic reconstruction at saved posterior medians.

No sampling, stage execution, runtime configuration, acceptance or remote writes.
Display the complete image grid; the likelihood mask is used only by the
unchanged scientific operator and verification statistics, never as display alpha.
"""
import base64
import hashlib
import io
import json
import os
import pickle
import sys
from pathlib import Path

import numpy as np


def diagnostic_arrays(image, noise, lens_light, source, valid, reference):
    """Compute total light and untrimmed per-pixel chi-square before rendering."""
    image, noise, lens_light, source = [np.asarray(a, dtype=float) for a in (image, noise, lens_light, source)]
    valid = np.asarray(valid)
    if image.ndim != 2 or not 1 <= min(image.shape) <= max(image.shape) <= 512:
        raise ValueError("Invalid image geometry")
    if any(a.shape != image.shape or not np.isfinite(a).all() for a in (noise, lens_light, source)) or not np.isfinite(image).all():
        raise ValueError("Model arrays must be finite and aligned")
    if valid.shape != image.shape or valid.dtype != np.bool_ or not valid.any() or np.any(noise <= 0):
        raise ValueError("Invalid likelihood mask or RMS noise")
    model = lens_light + source
    residual = (image - model) / noise
    chi_square = np.square(residual)
    stats = {"pixel_count": int(valid.sum()), "rms": float(np.sqrt(np.mean(chi_square[valid]))),
             "abs_gt_3sigma_fraction": float(np.mean(np.abs(residual[valid]) > 3)),
             "abs_gt_5sigma_fraction": float(np.mean(np.abs(residual[valid]) > 5)),
             "chi_square_sum": float(chi_square[valid].sum())}
    if stats["pixel_count"] != reference["pixel_count"] or not np.isclose(stats["rms"], reference["rms"], rtol=2e-5, atol=2e-6):
        raise ValueError("Reconstructed residual does not match the saved diagnostic")
    for key in ("abs_gt_3sigma_fraction", "abs_gt_5sigma_fraction"):
        if not np.isclose(stats[key], reference[key], rtol=0, atol=1e-12):
            raise ValueError("Reconstructed residual significance counts disagree")
    return model, residual, chi_square, stats


def full_operator_image(likelihood, pixels):
    """Return the original operator's complete PSF output before active indexing.

    Changing its input mask would change the scientific forward model. Reuse
    its interpolation/PSF primitives, retaining the same source coefficients.
    """
    from TinyLensGpu.ForwardSimulation.LensImage import pixelized_operator as op
    import jax.numpy as jnp
    xmin, xmax, ymin, ymax, bx, by, _, _ = likelihood._get_bbox()
    sim = likelihood.sim_obj
    data = sim.precompute_operator_data(xmin, xmax, ymin, ymax, _betas_sub=(bx, by))
    height, width = sim.image_shape
    lensed = op._apply_L_jit(jnp.asarray(pixels), data.weights, data.indices,
                            data.flat_indices, height, width, data.nsub,
                            data.agg_segment_ids, data.agg_n_active)
    result = op._psf_convolve_full_jit(lensed, sim._psf_fft, height, width)
    active = sim.forward_model(jnp.asarray(pixels), xmin, xmax, ymin, ymax, op_data=data)
    if not np.array_equal(np.asarray(result)[np.asarray(sim.flat_indices)], np.asarray(active)):
        raise ValueError("Full output differs from the original scientific operator")
    image = np.asarray(result, dtype=float).reshape(height, width)
    if not np.isfinite(image).all():
        raise ValueError("Nonfinite complete operator image")
    return image, {"path": op.__file__, "sha256": hashlib.sha256(Path(op.__file__).read_bytes()).hexdigest()}


def png_url(array):
    from PIL import Image
    output = io.BytesIO()
    Image.fromarray(array).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def display_plane(array, valid, pixel, colormap, limits, stretch, bounds=None, raw=False):
    from matplotlib import colormaps
    array = np.asarray(array, dtype=float)
    lo, hi = limits
    normalized = np.full_like(array, .5) if lo == hi else np.clip((array - lo) / (hi - lo), 0, 1)
    if stretch == "asinh" and lo != hi:
        normalized = np.arcsinh(25 * np.clip(array - lo, 0, hi - lo)) / np.arcsinh(25 * (hi - lo))
    rgba = colormaps[colormap](normalized, bytes=True)
    rgba[..., 3] = valid.astype(np.uint8) * 255
    palette = colormaps[colormap](np.linspace(1, 0, 256)[:, None], bytes=True)[..., :3]
    values = array[valid]
    bounds = bounds or [-array.shape[1]*pixel/2, array.shape[1]*pixel/2, -array.shape[0]*pixel/2, array.shape[0]*pixel/2]
    result = {"src": png_url(np.flipud(rgba)), "shape": list(array.shape),
            "bounds_arcsec": bounds,
            "half_extent_arcsec": (bounds[3]-bounds[2])/2, "vmin": float(lo), "vmax": float(hi),
            "data_min": float(values.min()), "data_max": float(values.max()), "stretch": stretch,
            "asinh_a": 25 if stretch == "asinh" else 1, "colormap": "blue-white-red" if colormap == "RdBu_r" else colormap,
            "colormap_src": png_url(palette), "valid_pixel_count": int(valid.sum()),
            "array_sha256": hashlib.sha256(np.ascontiguousarray(values).tobytes()).hexdigest(),
            "mask_sha256": hashlib.sha256(valid.tobytes()).hexdigest()}
    if raw:
        pixels = np.ascontiguousarray(array, dtype="<f8").tobytes()
        result.update(values_base64=base64.b64encode(pixels).decode(), values_sha256=hashlib.sha256(pixels).hexdigest(),
                      mask_base64=base64.b64encode(valid.astype(np.uint8).tobytes()).decode(), array_y_direction="increasing")
    return result


class ArraysOnly(pickle.Unpickler):
    def find_class(self, module, name):
        allowed = {("numpy", "ndarray"): np.ndarray, ("numpy", "dtype"): np.dtype}
        for prefix in ("numpy.core.multiarray", "numpy._core.multiarray"):
            allowed[(prefix, "_reconstruct")] = np.core.multiarray._reconstruct
            allowed[(prefix, "scalar")] = np.core.multiarray.scalar
        if (module, name) not in allowed:
            raise ValueError("Unsupported pickle object")
        return allowed[(module, name)]


def reconstruct(request):
    from astropy.io import fits
    root, run = Path(request["root"]), Path(request["run"])
    if root.resolve(strict=True) != root or run.resolve(strict=True) != run or not run.is_relative_to(root / "output"):
        raise ValueError("Invalid reported run")
    stage, files, hashes = request["stage"], request["files"], {}
    if stage not in ("a", "m0", "m1", "m2", "m3") or stage not in files:
        raise ValueError("Unsupported reported model")

    # Guard against accidental project writes by imported numerical libraries.
    def read_only_project(event, args):
        if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
            mode, flags = args[1], args[2]
            writing = isinstance(mode, str) and any(c in mode for c in "wax+") or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
            if writing and Path(os.fsdecode(args[0])).absolute().is_relative_to(root):
                raise PermissionError("Diagnostic reader cannot write to the pipeline project")
        if event in ("os.mkdir", "os.remove", "os.rmdir", "os.rename"):
            for arg in args[:2]:
                if isinstance(arg, (str, bytes, os.PathLike)) and Path(os.fsdecode(arg)).absolute().is_relative_to(root):
                    raise PermissionError("Diagnostic reader cannot mutate the pipeline project")
    sys.addaudithook(read_only_project)

    def read(path, base=run):
        path = Path(path)
        if path.resolve(strict=True) != path or not path.is_relative_to(base) or not path.is_file() or path.stat().st_size > 64*1024*1024:
            raise ValueError("Invalid declared diagnostic dependency")
        raw = path.read_bytes()
        hashes[str(path)] = hashlib.sha256(raw).hexdigest()
        return raw

    def read_json(path, base=run):
        return json.loads(read(path, base))

    def attempt(tag):
        entry = files[tag]
        base = Path(entry["summary"]).parent
        if base.parent.name != tag or base.parent.parent.name != "attempts" or base.parents[2] != run or base.name != str(entry["attempt"]):
            raise ValueError("Dependency attempt identity mismatch")
        if Path(entry["summary"]).name != "stage-result.json":
            raise ValueError("A reported summary is required")
        if entry.get("posterior") and Path(entry["posterior"]) != base / "artifacts" / ("stage_"+tag+".pkl"):
            raise ValueError("Dependency pickle identity mismatch")
        return base

    saved_payloads = {}
    def payload(tag):
        if tag in saved_payloads:
            return saved_payloads[tag]
        attempt(tag)
        result = ArraysOnly(io.BytesIO(read(files[tag]["posterior"]))).load()
        if not isinstance(result, dict) or not isinstance(result.get("extra"), dict):
            raise ValueError("Invalid saved model payload")
        saved_payloads[tag] = result
        return result

    for tag, entry in files.items():
        attempt(tag)
        declared = read_json(entry["summary"])
        if declared.get("stage") != tag or declared.get("attempt") != entry["attempt"] or declared.get("lens_id") != run.name:
            raise ValueError("Declared upstream summary identity mismatch")
        if entry.get("posterior"):
            payload(tag)

    own_dir = attempt(stage)
    summary = read_json(files[stage]["summary"])
    if summary.get("stage") != stage or summary.get("attempt") != files[stage]["attempt"] or summary.get("lens_id") != run.name:
        raise ValueError("Reported summary identity mismatch")
    config = read_json(own_dir / "effective-config.json")
    if config.get("schema_version") != "lens_pipeline_config.v5" or config.get("pipeline_release_id") != "input-geometry.v1":
        raise ValueError("Unsupported saved diagnostic configuration")
    settings = config["settings"]
    manifest = read_json(run / "run-manifest.json")
    if manifest.get("schema_version") != "lens_run_manifest.v1" or manifest.get("pipeline_release_id") != "input-geometry.v1":
        raise ValueError("Unsupported frozen run")
    lens = Path(manifest["lens_dir"])
    provenance = read_json(lens / "input-provenance.json", root / "output")
    frozen_fits = Path(provenance["packaged_fits_path"])
    if frozen_fits.parent != lens or provenance.get("schema_version") != "mock_input_provenance.v1":
        raise ValueError("Invalid frozen input reference")
    fits_raw = read(frozen_fits, root / "output")
    if hashlib.sha256(fits_raw).hexdigest() != provenance["packaged_fits_sha256"]:
        raise ValueError("Frozen input checksum mismatch")
    geometry = manifest["input_geometry"]
    if geometry != provenance["input_geometry"] or any(settings.get(k) != v for k, v in geometry.items()):
        raise ValueError("Frozen input geometry mismatch")
    with fits.open(io.BytesIO(fits_raw), memmap=False) as hdus:
        image, noise, psf = [np.asarray(hdus[name].data, dtype=float) for name in ("VIS_FLUX", "VIS_RMS", "VIS_PSF")]
    if geometry["input_x_direction"] == "decreasing":
        image, noise, psf = [np.fliplr(a) for a in (image, noise, psf)]
    if geometry["input_y_direction"] == "decreasing":
        image, noise, psf = [np.flipud(a) for a in (image, noise, psf)]

    def mask(path):
        with fits.open(io.BytesIO(read(path)), memmap=False) as hdus:
            data, header = np.asarray(hdus[0].data), hdus[0].header
        # Older preflight masks omit GEOMFRM; their complete positive-axis,
        # centered arcsec WCS below explicitly identifies the canonical frame.
        if data.shape != image.shape or not np.isin(data, [0, 1]).all() or header.get("GEOMFRM") not in (None, "canonical"):
            raise ValueError("Mask must identify its canonical array frame")
        for axis in (1, 2):
            if header.get("CUNIT"+str(axis)) != "arcsec" or not np.isclose(header.get("CDELT"+str(axis), np.nan), geometry["pixel_scale_arcsec"]) or not np.isclose(header.get("CRPIX"+str(axis), np.nan), (image.shape[2-axis]+1)/2) or header.get("CRVAL"+str(axis)) != 0:
                raise ValueError("Mask geometry disagrees with frozen image")
        return data.astype(bool)

    domain = mask(run / "preflight" / "modeling_mask.fits")
    own, a = payload(stage), payload("a")
    for saved in (own, a):
        g = saved["extra"]["input_geometry"]
        if g.get("array_frame") != "canonical" or any(g.get(k) != v for k, v in geometry.items()):
            raise ValueError("Saved model geometry mismatch")
    lens_light = np.asarray(a["extra"]["lens_light_model"], dtype=float)
    source = np.zeros_like(image)
    valid, feature = ~domain, None
    if stage != "a":
        b_dir = attempt("b")
        b_summary = read_json(files["b"]["summary"])
        if b_summary.get("stage") != "b" or b_summary.get("attempt") != files["b"]["attempt"] or b_summary.get("lens_id") != run.name:
            raise ValueError("Arc mask report identity mismatch")
        if b_summary.get("artifacts", {}).get("feature_mask_fits") != "artifacts/feature_mask.fits":
            raise ValueError("An explicit standard feature mask reference is required")
        feature = mask(b_dir / "artifacts" / "feature_mask.fits")
        valid = ~(domain | feature)
        if int((~feature).sum()) != b_summary["metrics"]["included_arc_pixels"] or np.any((~feature) & domain):
            raise ValueError("Arc mask count mismatch")
    import jax
    from lens_agent.modeling import pipeline_template as p
    from lens_agent.configuration import PipelineConfig
    from TinyLensGpu.PhysicalModel import PixelizedSourceModel
    from TinyLensGpu.Inference import ParamU
    if jax.default_backend() != "cpu":
        raise ValueError("Display reconstruction must use CPU")
    def forbidden(*args, **kwargs):
        raise RuntimeError("Sampling, stage execution and artifact writes are forbidden")
    p._sample = forbidden
    for name in list(vars(p)):
        if name.startswith("run_stage_") or name in ("_save_stage", "_save_grid_stage", "configure_runtime"):
            setattr(p, name, forbidden)
    p._CONFIG = PipelineConfig.model_validate_json(json.dumps(settings))
    p.DPIX = float(settings["pixel_scale_arcsec"])
    implementation = {"path": p.__file__, "sha256": hashlib.sha256(Path(p.__file__).read_bytes()).hexdigest(), "jax": jax.__version__, "backend": "cpu"}
    projection_difference = 0.
    method = "saved_source_pixels_full_operator_output"
    if stage == "m1":
        model_1d = np.asarray(own["extra"]["s1"]["model_1d"], dtype=float)
        if model_1d.shape != (int(valid.sum()),) or not np.isfinite(model_1d).all():
            raise ValueError("Saved model vector does not match the actual likelihood mask")
        source[valid] = model_1d
        source_image = np.asarray(own["extra"]["s1"]["source_image"], dtype=float)
        source_x = np.asarray(own["extra"]["s1"]["source_x_axis"], dtype=float)
        source_y = np.asarray(own["extra"]["s1"]["source_y_axis"], dtype=float)
        source_bounds = [float(source_x[0]-(source_x[1]-source_x[0])/2),float(source_x[-1]+(source_x[1]-source_x[0])/2),float(source_y[0]-(source_y[1]-source_y[0])/2),float(source_y[-1]+(source_y[1]-source_y[0])/2)]
        package = own["extra"]["s1"]
        if not np.array_equal(np.asarray(package["source_pixels"]).reshape(source_image.shape), source_image):
            raise ValueError("Saved source coefficients and source image disagree")
        # Recreate M1's original parameter objects/context, rather than replacing
        # the sampled parameterization with a separately frozen approximation.
        mass, shear = p._free_sie(p._stage_from_payload(a))
        log_lambda = ParamU("log_lambda_reg", own["extra"]["medians"]["log_lambda_reg"])
        log_lambda.to_dynamic()
        src = PixelizedSourceModel(n=source_image.shape[0], log_lambda_reg=log_lambda, regularization_type=p.REGULARIZATION_TYPE)
        likelihood = p._pixel_likelihood(image-lens_light, noise, psf, feature, domain,
                                       (mass, shear), src, None, fixed_source_bbox=tuple(package["source_bbox"]))
        if not np.array_equal(valid, np.asarray(likelihood.unmask, dtype=bool)):
            raise ValueError("Saved source operator mask mismatch")
        with p.ck.ActiveContext(likelihood):
            likelihood.fill_params(p.jnp.asarray([own["extra"]["medians"][name] for name in own["param_names"]]))
            full_source, operator_implementation = full_operator_image(likelihood, package["source_pixels"])
        projection_difference = float(np.max(np.abs(full_source[valid]-model_1d)))
        # The saved GPU and CPU FFT paths differ by a few float32 ulps.
        # Verify the complete projection, then retain the exact saved values
        # wherever the original run already supplied its prediction.
        projection_tolerance = 128 * np.finfo(np.float32).eps * max(1., float(np.max(np.abs(model_1d))))
        if projection_difference > projection_tolerance:
            raise ValueError(f"Full-grid output disagrees with saved M1 predictions: max difference {projection_difference}")
        full_source[valid] = model_1d
        source = full_source
        implementation["source_operator"] = operator_implementation
    else:
        medians = own["extra"].get("medians", {})
        if stage == "a":
            likelihood = p.build_stage_a_likelihood(image, noise, psf, domain)
            likelihood.set_values([medians[name] for name in own["param_names"]])
            lensed, light, intensities = likelihood.forward_model(use_linear=True, return_intensity=True, ret_each_plane=True, image_map=likelihood.image_data, noise_map=likelihood.noise_map)
            source, lens_light = np.asarray(lensed, dtype=float), np.asarray(light, dtype=float)
            from TinyLensGpu.ForwardSimulation.LensImage.config import make_grid_2d
            sx, sy = make_grid_2d(200, .01, 1)
            components = []
            for index, profile in enumerate(likelihood.sim_obj.phys_model.source_light):
                amplitude = next(name for name in ("flux", "Ie", "amp", "intensity", "I0") if hasattr(profile, name))
                components.append(np.asarray(profile.light(x=p.jnp.asarray(sx), y=p.jnp.asarray(sy), **{amplitude:intensities[index]})))
            source_image = np.stack(components, axis=-1).sum(axis=-1)
            source_bounds = [-1.,1.,-1.,1.]
        else:
            grid = read_json(attempt("m0") / "artifacts" / "source_grid_spec.json")
            if stage == "m0":
                mass, shear = p._fixed_sie(p._stage_from_payload(a))
                ll = float(own["extra"]["log_lambda_best"])
                kwargs, names, medians, rho = {}, ["log_lambda_reg"], {"log_lambda_reg": ll}, 0.
            else:
                m1 = payload("m1")
                if stage == "m3":
                    if own["extra"].get("m3_mass_model") != "EPL+Shear":
                        raise ValueError("Unsupported saved M3 mass model")
                    fixed = own["extra"]["reg_hyperparams_fixed"]
                    m2_medians = payload("m2")["extra"]["medians"]
                    keys = ("log_lambda_reg", "adaptive_reg_rho")
                    ll, rho = (float(fixed[key]) for key in keys)
                    if not np.isfinite((ll, rho)).all() or (ll, rho) != tuple(float(m2_medians[key]) for key in keys):
                        raise ValueError("Frozen M3 regularization disagrees with the reported M2 result")
                    grid = p._validate_runtime_source_grid(grid)
                    mass, shear = p._free_epl(p._stage_from_payload(m1), p._stage_from_payload(a))
                else:
                    mass, shear = p._fixed_sie_from_medians(own["extra"]["mass_medians_fixed"])
                    ll, rho = float(medians["log_lambda_reg"]), float(medians["adaptive_reg_rho"])
                kwargs, names = p._fixed_source_template_kwargs(m1["extra"]["s1"], grid), own["param_names"]
            log_lambda, reg_rho = ParamU("log_lambda_reg", ll), ParamU("adaptive_reg_rho", rho)
            if stage == "m3":
                log_lambda.to_static()
                reg_rho.to_static()
            else:
                log_lambda.to_dynamic()
                if stage == "m2":
                    reg_rho.to_dynamic()
            src = PixelizedSourceModel(n=grid["nsrc"], log_lambda_reg=log_lambda, regularization_type=p.REGULARIZATION_TYPE, adaptive_reg_rho=reg_rho)
            kwargs.setdefault("fixed_source_bbox", p._pixel_center_bbox(grid))
            likelihood = p._pixel_likelihood(image-lens_light, noise, psf, feature, domain, (mass, shear), src, None, **kwargs)
            if not np.array_equal(valid, np.asarray(likelihood.unmask, dtype=bool)):
                raise ValueError("Likelihood indexing differs from saved mask")
            solved = p._solve_source(likelihood, medians, names)
            source[valid] = np.asarray(solved["model_1d"], dtype=float)
            source_image = np.asarray(solved["source_image"], dtype=float)
            source_bounds = list(map(float, grid["footprint_bbox"]))
            with p.ck.ActiveContext(likelihood):
                likelihood.fill_params(p.jnp.asarray([medians[name] for name in names]))
                full_source, operator_implementation = full_operator_image(likelihood, solved["source_pixels"])
            projection_difference = float(np.max(np.abs(full_source[valid]-source[valid])))
            if not np.allclose(full_source[valid], source[valid], rtol=2e-5, atol=1e-6):
                raise ValueError("Full-grid output disagrees with the frozen conditional solution")
            source = full_source
            implementation["source_operator"] = operator_implementation
        method = "frozen_parameters_conditional_linear_diagnostic_reconstruction"
    reference = own["extra"]["residual_diagnostics"]["all_valid_pixels"]
    reported_reference = summary["metrics"]["residual_diagnostics"]["all_valid_pixels"]
    if any(not np.isclose(reference[key], reported_reference[key], rtol=0, atol=1e-12) for key in ("pixel_count", "rms", "abs_gt_3sigma_fraction", "abs_gt_5sigma_fraction")):
        raise ValueError("Reported summary and saved model diagnostics disagree")
    model, residual, chi_square, stats = diagnostic_arrays(image, noise, lens_light, source, valid, reference)
    pixel = float(geometry["pixel_scale_arcsec"])
    image_limits = (float(image.min()), float(image.max()))
    source_limits = (float(source[valid].min()),float(source[valid].max())) if stage == "a" else (0.,max(1e-12,float(np.percentile((image-lens_light)[valid],99.5))))
    display_valid = np.ones_like(valid)
    planes = {"observation":display_plane(image,display_valid,pixel,"magma",image_limits,"asinh",raw=True),
              "model": display_plane(model, display_valid, pixel, "magma", image_limits, "asinh",raw=True),
              "source-lensed":display_plane(source,display_valid,pixel,"inferno",source_limits,"linear",raw=True),
              "residual":display_plane(residual,display_valid,pixel,"RdBu_r",(-5.,5.) if stage=="a" else (-3.,3.),"linear",raw=True),
              "source":display_plane(source_image,np.ones_like(source_image,dtype=bool),pixel,"magma" if stage=="m1" else "inferno",(float(source_image.min()),float(source_image.max())),"linear",bounds=source_bounds,raw=True),
              "chi-square": display_plane(chi_square, display_valid, pixel, "RdBu_r", (0., 25. if stage == "a" else 9.), "linear",raw=True)}
    for plane in planes.values():
        plane["input_fits_sha256"] = provenance["packaged_fits_sha256"]
    mapping = {}
    if stage != "m3":
        # The browser verifies SIE lens mapping against these per-attempt rays.
        from TinyLensGpu.PhysicalModel.LensImage.Parametric.Mass import SIE
        from TinyLensGpu.PhysicalModel import Shear
        import jax.numpy as jnp
        mass_values = dict(a["extra"]["medians"] if stage=="m0" else own["extra"].get("mass_medians_fixed",own["extra"].get("medians",{})))
        for key in ("center_x_mass","center_y_mass"):
            mass_values.setdefault(key,a["extra"]["medians"][key])
        model_values = {key:float(mass_values[key]) for key in ("theta_E","e1_mass","e2_mass","center_x_mass","center_y_mass","gamma1","gamma2")}
        mass = SIE(theta_E=model_values["theta_E"],e1=model_values["e1_mass"],e2=model_values["e2_mass"],center_x=model_values["center_x_mass"],center_y=model_values["center_y_mass"])
        shear = Shear(gamma1=model_values["gamma1"],gamma2=model_values["gamma2"])
        points=np.asarray([[-2.,-1.5],[-1.2,.8],[0.,0.],[.4,-.6],[1.5,.1],[1.9,-1.2],[.3,2.]],dtype=float)
        mx,my=mass.deriv(jnp.asarray(points[:,0]),jnp.asarray(points[:,1]));gx,gy=shear.deriv(jnp.asarray(points[:,0]),jnp.asarray(points[:,1]))
        betas=points-np.stack([np.asarray(mx+gx),np.asarray(my+gy)],axis=1)
        mapping["display_mapping"]={"schema":"tinylens.lens-mapping.v1","synthetic":False,"stage":stage,"attempt":files[stage]["attempt"],"path":files[stage]["summary"],"summary_sha256":hashes[files[stage]["summary"]],"fits_sha256":provenance["packaged_fits_sha256"],"model":{"kind":"sie-shear",**model_values},"frames":{"image":{key:planes["model"][key] for key in ("shape","bounds_arcsec","half_extent_arcsec")},"source":{key:planes["source"][key] for key in ("shape","bounds_arcsec","half_extent_arcsec")}},"references":[{"image":{"x":float(x),"y":float(y)},"source":{"x":float(bx),"y":float(by)}} for (x,y),(bx,by) in zip(points,betas)]}
    return {"schema": "tinylens.readonly-result.v1", "kind": "summary", "stage": stage, "attempt": files[stage]["attempt"],
            "path": files[stage]["summary"], "sha256": hashes[files[stage]["summary"]], "result": summary, "planes": planes, **mapping,
            "display_derivation": {"schema": "tinylens.model-display-derivation.v1", "method": method,
                "estimate": "saved_evidence_scan_choice_and_conditional_linear_solution" if stage == "m0" else "saved_posterior_medians_and_conditional_linear_solution", "model_expression": "lens_light + lensed_source",
                "chi_square_expression": "((data - model) / noise_rms)^2", "chi_square_is_reduced": False,
                "support": "full_image_grid", "fit_support": "actual_likelihood_mask",
                "fit_mask_base64": base64.b64encode(valid.astype(np.uint8).tobytes()).decode(),
                "fit_mask_sha256": hashlib.sha256(valid.tobytes()).hexdigest(),
                "full_output": "same_scientific_operator_before_active_pixel_indexing",
                "projection_max_difference_on_fit_pixels": projection_difference,
                "fit_prediction_values": "saved_model_1d" if stage == "m1" else "frozen_conditional_solution",
                "lens_light_sha256": hashlib.sha256(np.ascontiguousarray(lens_light, dtype="<f8").tobytes()).hexdigest(),
                "source_solution": "joint_lens_and_source_light" if stage == "a" else "lens_light_subtracted_input",
                "statistics": stats, "reference_statistics": reference,
                "full_grid_statistics": {"pixel_count": int(image.size), "rms": float(np.sqrt(np.mean(chi_square))), "chi_square_sum": float(chi_square.sum())},
                "input_files_sha256": hashes, "implementation": implementation}}


if __name__ == "__main__":
    print(json.dumps(reconstruct(json.loads(sys.stdin.readline())), allow_nan=False, separators=(",", ":")))
