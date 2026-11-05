"""Input calibration is fixed per run; these CPU checks perform no lens fitting."""

import json
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from pydantic import ValidationError
from scipy.signal import convolve2d

from lens_agent import cli, stages
from lens_agent.configuration import (
    CONFIG_SCHEMA_VERSION,
    PIPELINE_RELEASE_ID,
    TUNABLE_CATALOG,
    EffectiveConfig,
    InputGeometry,
    PipelineConfig,
)
from lens_agent.data import load_lens_data
from lens_agent.models import StageName
from tests.helpers import make_lens_dir, model_inspector_decision


GEOMETRY = {
    "pixel_scale_arcsec": 0.05,
    "input_x_direction": "increasing",
    "input_y_direction": "decreasing",
}


def _json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _snapshot(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def _preflight_args(lens, output):
    return ["preflight", "--lens-dir", str(lens), "--output-dir", str(output)]


@pytest.fixture
def geometry_run(tmp_path):
    lens = make_lens_dir(tmp_path, image_shape=(33, 33))
    output = tmp_path / "output" / lens.name
    cli.main([
        *_preflight_args(lens, output),
        "--pixel-scale-arcsec", "0.05",
        "--input-x-direction", "increasing",
        "--input-y-direction", "decreasing",
        "--geometry-evidence", "Synthetic fixture: 0.05 arcsec/pixel, decreasing input y.",
    ])
    return lens, output


def _prepare_a(lens, output, tmp_path):
    response = tmp_path / "inspector-response.json"
    response.write_text(json.dumps(model_inspector_decision(lens.name)), encoding="utf-8")
    cli.main(["mask", "--output-dir", str(output), "--inspection", str(response)])
    return stages.run_stage(lens, output, StageName.A, 0, prepare_only=True)


def test_input_geometry_defaults_are_explicit_immutable_and_not_tunables():
    expected = {
        "pixel_scale_arcsec": 0.1,
        "input_x_direction": "increasing",
        "input_y_direction": "increasing",
    }
    geometry = InputGeometry()
    assert geometry.model_dump() == expected
    assert InputGeometry.from_settings(PipelineConfig()).model_dump() == expected
    assert set(expected).isdisjoint(TUNABLE_CATALOG)
    with pytest.raises(ValidationError, match="frozen"):
        geometry.pixel_scale_arcsec = 0.05


@pytest.mark.parametrize("value", [0.0, -0.05, float("nan"), float("inf"), True, "0.05"])
@pytest.mark.parametrize("model", [InputGeometry, PipelineConfig])
def test_input_geometry_rejects_invalid_pixel_scales(model, value):
    with pytest.raises(ValidationError):
        model(pixel_scale_arcsec=value)


@pytest.mark.parametrize("field", ["input_x_direction", "input_y_direction"])
@pytest.mark.parametrize("value", ["up", "left", -1, None])
def test_input_geometry_rejects_ambiguous_axis_values(field, value):
    with pytest.raises(ValidationError):
        InputGeometry(**{field: value})


def _asymmetric_fits(tmp_path):
    lens = tmp_path / "asymmetric"
    lens.mkdir()
    yy, xx = np.indices((9, 9))
    image = (2 * xx + 7 * yy + xx * yy).astype(float)
    noise = 0.2 + (xx + 3 * yy) / 100.0
    psf = np.array([[0.0, 1.0, 3.0], [2.0, 7.0, 4.0], [1.0, 0.0, 2.0]])
    image_y, image_j = image + 31.0, image * 0.7 + yy
    planes = {
        "VIS_FLUX": image, "VIS_RMS": noise, "VIS_PSF": psf,
        "NIR_Y_FLUX": image_y, "NIR_J_FLUX": image_j,
    }
    path = lens / f"{lens.name}.fits"
    fits.HDUList([fits.PrimaryHDU(), *[
        fits.ImageHDU(array, name=name) for name, array in planes.items()
    ]]).writeto(path)
    return lens, path, planes


@pytest.mark.parametrize("x_direction", ["increasing", "decreasing"])
@pytest.mark.parametrize("y_direction", ["increasing", "decreasing"])
def test_loader_reflects_every_aligned_plane_without_resampling_or_changing_fits(
    tmp_path, x_direction, y_direction,
):
    lens, path, planes = _asymmetric_fits(tmp_path)
    original_bytes = path.read_bytes()
    geometry = InputGeometry(pixel_scale_arcsec=0.05, input_x_direction=x_direction,
                             input_y_direction=y_direction)
    loaded = load_lens_data(lens, geometry=geometry)
    axes = tuple(axis for axis, value in ((0, y_direction), (1, x_direction)) if value == "decreasing")
    mapping = {"VIS_FLUX": "image", "VIS_RMS": "noise", "VIS_PSF": "psf",
               "NIR_Y_FLUX": "image_y", "NIR_J_FLUX": "image_j"}
    for extension, attribute in mapping.items():
        expected = np.flip(planes[extension], axis=axes)
        actual = getattr(loaded, attribute)
        np.testing.assert_array_equal(actual, expected)
        assert actual.shape == planes[extension].shape
        assert actual.flags.c_contiguous
    assert loaded.pixel_scale_arcsec == 0.05
    assert path.read_bytes() == original_bytes

    # Both the science image and an asymmetric odd PSF must reflect. A PSF-only
    # or image-only flip would fail this physical convolution correspondence.
    raw_convolution = convolve2d(planes["VIS_FLUX"], planes["VIS_PSF"], mode="same")
    canonical_convolution = convolve2d(loaded.image, loaded.psf, mode="same")
    np.testing.assert_allclose(canonical_convolution, np.flip(raw_convolution, axis=axes),
                               rtol=1e-13, atol=1e-12)
    assert loaded.psf[1, 1] == planes["VIS_PSF"][1, 1]


@pytest.mark.parametrize("psf_shape,axis_field", [
    ((3, 4), "input_x_direction"),
    ((4, 3), "input_y_direction"),
])
def test_reflection_rejects_even_psf_extent_on_the_reflected_axis(tmp_path, psf_shape, axis_field):
    lens, path, _ = _asymmetric_fits(tmp_path)
    with fits.open(path, mode="update") as hdul:
        hdul["VIS_PSF"].data = np.ones(psf_shape, dtype=float)
    original_bytes = path.read_bytes()
    geometry = InputGeometry(**{axis_field: "decreasing"})
    with pytest.raises(ValueError):
        load_lens_data(lens, geometry=geometry)
    assert path.read_bytes() == original_bytes


def test_preflight_freezes_geometry_and_unspecified_repeat_inherits_it(geometry_run):
    lens, output = geometry_run
    manifest_path = output / "run-manifest.json"
    packet_path = output / "preflight/inspection.json"
    assert _json(manifest_path)["input_geometry"] == GEOMETRY
    assert _json(packet_path)["input_geometry"] == GEOMETRY
    original_manifest = manifest_path.read_bytes()
    cli.main(_preflight_args(lens, output))
    assert manifest_path.read_bytes() == original_manifest
    assert _json(packet_path)["input_geometry"] == GEOMETRY


@pytest.mark.parametrize("flag,value", [
    ("--pixel-scale-arcsec", "0.1"),
    ("--input-x-direction", "decreasing"),
    ("--input-y-direction", "increasing"),
])
def test_conflicting_preflight_preserves_every_existing_artifact(geometry_run, flag, value):
    lens, output = geometry_run
    before = _snapshot(output)
    with pytest.raises(ValueError, match="[Gg]eometry"):
        cli.main([*_preflight_args(lens, output), flag, value])
    assert _snapshot(output) == before


def test_stage_a_preparation_inherits_frozen_geometry_without_model_execution(geometry_run, tmp_path):
    lens, output = geometry_run
    assert _prepare_a(lens, output, tmp_path) == {"status": "prepared", "stage": "a", "attempt": 0}
    attempt = output / "attempts/a/0"
    effective = EffectiveConfig.model_validate_json((attempt / "effective-config.json").read_text())
    assert InputGeometry.from_settings(effective.settings).model_dump() == GEOMETRY
    assert not (attempt / "stage-execution.json").exists()
    assert not (attempt / "stage-result.json").exists()


@pytest.mark.parametrize("boundary", ["manifest", "effective_config", "cached_result"])
def test_changed_geometry_blocks_prepared_or_cached_stage_without_execution(
    geometry_run, tmp_path, boundary,
):
    lens, output = geometry_run
    _prepare_a(lens, output, tmp_path)
    attempt = output / "attempts/a/0"
    if boundary == "manifest":
        path = output / "run-manifest.json"
        payload = _json(path)
        payload["input_geometry"]["pixel_scale_arcsec"] = 0.1
    else:
        path = attempt / "effective-config.json"
        payload = _json(path)
        payload["settings"]["input_y_direction"] = "increasing"
        if boundary == "cached_result":
            # A cached return must not skip geometry validation just because a
            # result exists. No computation or scientific acceptance is mocked.
            (attempt / "stage-result.json").write_text(json.dumps({
                "status": "success", "stage": "a", "attempt": 0,
            }))
    path.write_text(json.dumps(payload), encoding="utf-8")
    before = _snapshot(attempt)
    with pytest.raises(ValueError, match="[Gg]eometry|configuration"):
        stages.run_stage(lens, output, StageName.A, 0, prepare_only=True)
    assert _snapshot(attempt) == before
    assert not (attempt / "stage-execution.json").exists()


def test_previous_release_is_not_silently_resumed_or_rewritten(tmp_path):
    lens = make_lens_dir(tmp_path)
    output = tmp_path / "output" / lens.name
    output.mkdir(parents=True)
    path = output / "run-manifest.json"
    path.write_text(json.dumps({
        "schema_version": "lens_run_manifest.v1",
        "pipeline_release_id": "stage-a-1800s-timeout.v1",
    }), encoding="utf-8")
    before = _snapshot(output)
    with pytest.raises(ValueError, match="different Pipeline Release"):
        cli.main(_preflight_args(lens, output))
    assert _snapshot(output) == before
    assert CONFIG_SCHEMA_VERSION == "lens_pipeline_config.v5"
    assert PIPELINE_RELEASE_ID == "input-geometry.v1"
