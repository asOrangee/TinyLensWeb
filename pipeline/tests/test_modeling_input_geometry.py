"""Numerical image-coordinate checks without invoking a physical stage sampler."""
from __future__ import annotations

import json
import pickle
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from astropy.io import fits

from lens_agent.configuration import PipelineConfig
from tests.test_pipeline_diagnostics import _load_pipeline_template


def _configure(pipeline, tmp_path: Path, scale: float = 0.05):
    config = PipelineConfig(pixel_scale_arcsec=scale, input_y_direction="decreasing")
    pipeline.configure_runtime(
        config=config, artifact_dir=tmp_path / "artifacts",
        diagnostics_dir=tmp_path / "diagnostics", upstream_dirs={},
    )
    return config


def test_runtime_scale_controls_centroids_footprints_and_saved_geometry(tmp_path, monkeypatch):
    p = _load_pipeline_template(monkeypatch)
    _configure(p, tmp_path)
    labels = np.zeros((151, 151), dtype=int)
    labels[95, 40] = 1
    catalog = p._arc_component_catalog(
        labels, 1, np.ones_like(labels, dtype=float) * 3,
        labels, labels > 0, kept_ids=(1,), dropped_ids=(),
    )
    # The center of an odd 151-pixel image is exactly pixel 75 (zero based).
    assert catalog[0]["centroid_arcsec"] == pytest.approx([-1.75, 1.0])
    assert p._unmasked_extent(np.zeros_like(labels, dtype=bool), p.DPIX) == pytest.approx(
        [-3.775, 3.775, -3.775, 3.775]
    )
    header = p._image_geometry_header(labels.shape)
    assert header["CRPIX1"] == header["CRPIX2"] == 76.0
    assert header["CDELT1"] == header["CDELT2"] == 0.05
    assert header["INPYDIR"] == "decreasing"
    geometry = json.loads((p.OUT_DIR / "input_geometry.json").read_text())
    assert geometry["pixel_scale_arcsec"] == 0.05
    assert geometry["array_frame"] == "canonical"
    assert geometry["y_direction"] == "increasing"
    p._save_grid_stage(0.0, {"log_lambda_fixed": 1.0})
    with (p.OUT_DIR / "stage_m0.pkl").open("rb") as handle:
        assert pickle.load(handle)["extra"]["input_geometry"] == geometry
    # Reusing the packaged module for a different lens must not retain 0.05.
    _configure(p, tmp_path / "second", 0.1)
    assert p.DPIX == 0.1
    assert p.PARAMETRIC_SOURCE_DPIX == 0.01  # Separate source-plane resolution.


@pytest.mark.parametrize("n", [8, 9])
def test_display_bounds_include_complete_edge_pixels_and_nonzero_single_pixel(n, monkeypatch):
    p = _load_pipeline_template(monkeypatch)
    scale = 0.05
    mask = np.ones((n, n), dtype=bool)
    mask[0, n - 1] = False
    # A display range encloses the pixel footprint, not only its center.
    assert p._unmasked_extent(mask, scale) == pytest.approx([
        (n / 2 - 1) * scale, n / 2 * scale,
        -n / 2 * scale, (-n / 2 + 1) * scale,
    ])
    mask[:] = False
    assert p._unmasked_extent(mask, scale) == pytest.approx([
        -n / 2 * scale, n / 2 * scale, -n / 2 * scale, n / 2 * scale,
    ])


def test_stage_b_fits_use_the_canonical_local_coordinates(tmp_path, monkeypatch):
    p = _load_pipeline_template(monkeypatch)
    _configure(p, tmp_path)
    labels = np.zeros((9, 9), dtype=np.int32)
    labels[3:5, 5:7] = 1
    monkeypatch.setattr(p, "_plot_arc_components", lambda *args, **kwargs: None)
    p._write_arc_component_label_artifacts(
        labels, 1, np.ones_like(labels) * 3, labels, labels > 0,
        np.zeros_like(labels, dtype=bool), (-0.225, 0.225, -0.225, 0.225),
        (-0.225, 0.225, -0.225, 0.225), kept_ids=(1,), dropped_ids=(),
    )
    with fits.open(p.OUT_DIR / "stage_b_component_labels.fits") as hdul:
        np.testing.assert_array_equal(hdul[0].data, labels)
        assert hdul[0].header["CDELT1"] == hdul[0].header["CDELT2"] == 0.05
        assert hdul[0].header["CRPIX1"] == hdul[0].header["CRPIX2"] == 5.0
        assert hdul[0].header["CUNIT1"] == "arcsec"


def test_both_observation_models_receive_the_attempt_scale_without_flipping_again(tmp_path, monkeypatch):
    p = _load_pipeline_template(monkeypatch)
    _configure(p, tmp_path)
    parameter = lambda *args, **kwargs: SimpleNamespace(to_dynamic=lambda: None)
    monkeypatch.setattr(p, "ParamU", parameter)
    monkeypatch.setattr(p, "SIE", lambda **kwargs: SimpleNamespace(**kwargs))
    monkeypatch.setattr(p, "Shear", lambda **kwargs: SimpleNamespace(**kwargs))
    monkeypatch.setattr(p, "_mge", lambda *args, **kwargs: [])
    monkeypatch.setattr(p, "PhysicalModel", lambda **kwargs: SimpleNamespace(**kwargs))
    monkeypatch.setattr(p, "ImageProbModel", lambda **kwargs: SimpleNamespace(**kwargs))
    monkeypatch.setattr(p, "PixelizedImageProbModelOperator", lambda **kwargs: SimpleNamespace(**kwargs))
    image = np.arange(81).reshape(9, 9).astype(float)
    noise = np.ones_like(image)
    psf = np.array([[0.0, 0.1, 0.0], [0.0, 0.6, 0.2], [0.0, 0.1, 0.0]])
    mask = np.zeros_like(image, dtype=bool)
    likelihoods = [
        p.build_stage_a_likelihood(image, noise, psf, mask),
        p._pixel_likelihood(image, noise, psf, mask, None, (), None, None,
                            fixed_source_bbox=(-0.2, 0.2, -0.2, 0.2)),
    ]
    for likelihood in likelihoods:
        assert likelihood.dpix == 0.05
        np.testing.assert_array_equal(likelihood.image_data, image)
        np.testing.assert_array_equal(likelihood.psf_kernel, psf)
