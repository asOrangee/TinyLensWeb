import json
from types import SimpleNamespace

import numpy as np
import pytest
from astropy.io import fits

from lens_agent.workbench_display import SCHEMA, file_sha256, publish_display, record_prediction


def _json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.fixture
def mask_run(tmp_path):
    lens_id = "lens-001"
    run = tmp_path / "output" / lens_id
    preflight = run / "preflight"
    preflight.mkdir(parents=True)
    image = np.arange(49, dtype=float).reshape(7, 7)
    pixel = 0.1
    path = tmp_path / f"{lens_id}.fits"
    fits.HDUList([
        fits.PrimaryHDU(),
        fits.ImageHDU(image, header=fits.Header({"BUNIT": "electron/s"}), name="VIS_FLUX"),
        fits.ImageHDU(np.ones_like(image), name="VIS_RMS"),
        fits.ImageHDU(np.ones((3, 3)), name="VIS_PSF"),
    ]).writeto(path)
    data = SimpleNamespace(lens_id=lens_id, pixel_scale_arcsec=pixel, fits_path=path, image=image)
    geometry = {
        "pixel_scale_arcsec": pixel, "input_x_direction": "increasing",
        "input_y_direction": "decreasing",
    }
    frozen = {"schema_version": "lens_run_manifest.v1", "input_geometry": geometry}
    packet = {"lens_id": lens_id, "image_shape": [7, 7], "input_geometry": geometry}
    _json(run / "run-manifest.json", frozen)
    _json(preflight / "inspection.json", packet)
    _json(preflight / "inspector.json", {
        "lens_id": lens_id, "disposition": "model", "contaminant_ids": [4, 7],
    })
    header = fits.Header({
        "CDELT1": pixel, "CDELT2": pixel, "CUNIT1": "arcsec", "CUNIT2": "arcsec",
        "CRPIX1": 4, "CRPIX2": 4, "CRVAL1": 0, "CRVAL2": 0,
        "INPXDIR": "increasing", "INPYDIR": "decreasing",
    })
    aperture = np.zeros((7, 7), dtype=bool)
    aperture[2:5, 2:5] = True
    aperture[3, 1:6] = True
    aperture[[1, 5], 3] = True
    labels = np.zeros((7, 7), dtype=np.int32)
    labels[2, 3], labels[0, 0], labels[3, 5] = 4, 7, 9
    contamination = np.isin(labels, [4, 7])
    modeling = ~aperture | contamination
    fits.writeto(preflight / "segmentation.fits", labels, header=header)
    domain_header = header.copy()
    domain_header["MODELRAD"] = 0.2
    fits.writeto(preflight / "modeling_mask.fits", modeling.astype(np.uint8), header=domain_header)
    arc = np.zeros((7, 7), dtype=bool)
    arc[3, 2:4] = True
    return SimpleNamespace(
        run=run, data=data, frozen=frozen, packet=packet, header=header, domain_header=domain_header,
        aperture=aperture, contamination=contamination, modeling=modeling, labels=labels, arc=arc,
    )


def _stage(fixture, name, attempt, arc=None):
    folder = fixture.run / "attempts" / name / str(attempt)
    artifacts = folder / "artifacts"
    artifacts.mkdir(parents=True)
    summary = {"lens_id": fixture.run.name, "stage": name, "attempt": attempt,
               "status": "success", "artifacts": {}, "metrics": {}}
    if name == "b":
        fits.writeto(artifacts / "feature_mask.fits", (~arc).astype(np.uint8), header=fixture.header)
        summary["artifacts"]["feature_mask_fits"] = "artifacts/feature_mask.fits"
        summary["metrics"]["included_arc_pixels"] = int(arc.sum())
    _json(folder / "stage-result.json", summary)
    _json(folder / "effective-config.json", {"settings": {}})
    return folder, summary


def _publish(fixture, stage, attempt=0, upstream=None):
    folder, summary = _stage(fixture, stage, attempt, fixture.arc)
    image = fixture.data.image
    capture = {
        "planes": {
            "model": image, "source-lensed": image, "residual": image,
            "chi-square": image, "source": np.ones((3, 3)),
        },
        "source_bounds": [-0.3, 0.3, -0.3, 0.3],
        "valid_domain": ~fixture.modeling if stage == "a" else fixture.arc,
    }
    target = publish_display(
        fixture.run, folder, stage, attempt, fixture.data, upstream=upstream,
        capture=capture, domain_mask=fixture.modeling, result=summary,
    )
    return folder, json.loads(target.read_bytes())


@pytest.mark.parametrize(
    ("stage", "prefix"),
    [("a", "StageA"), ("b", "StageB"), ("m0", "StageM0"),
     ("m1", "StageM1"), ("m2", "StageM2"), ("m3", "StageM3")],
)
def test_fixed_masks_use_name_polarity_and_pixel_frame(mask_run, stage, prefix):
    upstream = None
    if stage.startswith("m"):
        older, _ = _stage(mask_run, "b", 1, mask_run.arc)
        newest_arc = np.zeros_like(mask_run.arc)
        newest_arc[4, 3] = True
        _stage(mask_run, "b", 2, newest_arc)
        (mask_run.run / "accepted").mkdir()
        _json(mask_run.run / "accepted" / "b.json", {"accepted_attempt": 2})
        upstream = {"b": older / "artifacts"}
    folder, manifest = _publish(mask_run, stage, upstream=upstream)
    names = {"aperture": "ApertureMask", "contamination": "ContaminationMask"}
    if stage != "a":
        names["arc"] = "ArcMask"
    assert set(manifest["mask_layers"]) == names.keys()
    for layer, name in names.items():
        ref = manifest["mask_layers"][layer]
        assert ref["path"] == f"display/{prefix}_{name}.fits"
        path = folder / ref["path"]
        assert ref["sha256"] == file_sha256(path)
        with fits.open(path) as hdus:
            assert hdus[0].data.dtype == np.uint8
            np.testing.assert_array_equal(hdus[0].data, getattr(mask_run, layer))
            header = hdus[0].header
            assert header["CRPIX1"] == header["CRPIX2"] == 1
            assert header["CRVAL1"] == header["CRVAL2"] == pytest.approx(-0.3)
            assert header["CDELT1"] == header["CDELT2"] == pytest.approx(0.1)
    if stage == "b":
        assert manifest["mask_layers"]["arc"] == {
            key: manifest["planes"]["mask"][key] for key in ("path", "sha256")
        }


def test_mismatched_contamination_does_not_hide_aperture_or_arc(mask_run):
    mask_run.modeling[4, 3] = True
    fits.writeto(
        mask_run.run / "preflight" / "modeling_mask.fits", mask_run.modeling.astype(np.uint8),
        header=mask_run.domain_header, overwrite=True,
    )
    _, manifest = _publish(mask_run, "b")
    assert set(manifest["mask_layers"]) == {"aperture", "arc"}


def test_arc_requires_the_bound_stage_b_pixel_count(mask_run):
    stage_b, summary = _stage(mask_run, "b", 1, mask_run.arc)
    summary["metrics"]["included_arc_pixels"] += 1
    _json(stage_b / "stage-result.json", summary)
    _, manifest = _publish(mask_run, "m3", upstream={"b": stage_b / "artifacts"})
    assert set(manifest["mask_layers"]) == {"aperture", "contamination"}


def test_new_manifest_marks_missing_layers_with_an_empty_map(mask_run):
    preflight = mask_run.run / "preflight"
    del mask_run.domain_header["MODELRAD"]
    fits.writeto(
        preflight / "modeling_mask.fits", mask_run.modeling.astype(np.uint8),
        header=mask_run.domain_header, overwrite=True,
    )
    (preflight / "segmentation.fits").unlink()
    _, manifest = _publish(mask_run, "a")
    assert manifest["mask_layers"] == {}


@pytest.mark.parametrize("valid_hash", [True, False])
def test_euclid_contamination_uses_verified_positive_labels(mask_run, valid_hash):
    from lens_agent.inspection.euclid import binary_mask_sha256

    contamination = mask_run.labels > 0
    binding = {
        "image_shape": [7, 7], "input_fits_sha256": file_sha256(mask_run.data.fits_path),
        "canonical_mask_sha256": binary_mask_sha256(contamination) if valid_hash else "0" * 64,
    }
    mask_run.frozen["euclid_contamination"] = mask_run.packet["euclid_contamination"] = binding
    _json(mask_run.run / "run-manifest.json", mask_run.frozen)
    _json(mask_run.run / "preflight" / "inspection.json", mask_run.packet)
    mask_run.modeling = ~mask_run.aperture | contamination
    fits.writeto(
        mask_run.run / "preflight" / "modeling_mask.fits", mask_run.modeling.astype(np.uint8),
        header=mask_run.domain_header, overwrite=True,
    )
    folder, manifest = _publish(mask_run, "a")
    if valid_hash:
        ref = manifest["mask_layers"]["contamination"]
        np.testing.assert_array_equal(fits.getdata(folder / ref["path"]), contamination)
    else:
        assert set(manifest["mask_layers"]) == {"aperture"}


def test_historical_manifest_is_never_backfilled(mask_run):
    folder, summary = _stage(mask_run, "a", 0)
    target = folder / "display-manifest.json"
    _json(target, {"schema": SCHEMA, "stage": "a", "attempt": 0})
    original = target.read_bytes()
    assert publish_display(mask_run.run, folder, "a", 0, mask_run.data, result=summary) == target
    assert target.read_bytes() == original
    assert not (folder / "display").exists()


@pytest.mark.parametrize("stage", ["a", "m0", "m1", "m2", "m3"])
def test_model_display_publishes_the_native_lens_light_plane(mask_run, stage):
    folder, summary = _stage(mask_run, stage, 0)
    image = mask_run.data.image
    lens_light = image / 10 + 0.1
    lensed_source = image[::-1] + 1
    capture = {"planes": {"source": np.ones((3, 3))}, "source_bounds": [-0.3, 0.3, -0.3, 0.3]}
    valid = ~mask_run.modeling if stage == "a" else mask_run.arc
    record_prediction(capture, image, np.ones_like(image), lens_light, lensed_source, valid=valid)
    target = publish_display(
        mask_run.run, folder, stage, 0, mask_run.data, capture=capture,
        domain_mask=mask_run.modeling, result=summary,
    )
    planes = json.loads(target.read_bytes())["planes"]
    reference = planes["lens-light"]
    path = folder / reference["path"]
    assert reference["path"] == f"display/Stage{stage.upper()}_LensLight.fits"
    assert reference["shape"] == planes["observation"]["shape"]
    assert reference["bounds_arcsec"] == planes["observation"]["bounds_arcsec"]
    assert reference["unit"] == "electron/s"
    assert reference["sha256"] == file_sha256(path)
    native, header = fits.getdata(path, header=True)
    assert header["BUNIT"] == "electron/s"
    np.testing.assert_array_equal(native, lens_light)
    np.testing.assert_array_equal(fits.getdata(folder / planes["model"]["path"]), lens_light + lensed_source)
    assert "chi-square" in planes


def test_a_broadcastable_component_does_not_publish_a_lens_light_plane():
    image = np.ones((3, 3))
    capture = {"planes": {}}
    record_prediction(capture, image, image, np.zeros((1, 3)), image)
    assert "lens-light" not in capture["planes"]
    np.testing.assert_array_equal(capture["planes"]["model"], image)
