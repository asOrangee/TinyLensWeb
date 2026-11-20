import json
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

from lens_agent.cli import main
from lens_agent.inspection import diagnostics
from lens_agent.stage_input import StageInputError, check_stage_input
from tests.helpers import make_lens_dir, model_inspector_decision


def _euclid_dataset(tmp_path: Path):
    lens = make_lens_dir(tmp_path, image_shape=(100, 100))
    dataset = tmp_path / "release" / lens.name / "dataset"
    (dataset / "segmentation").mkdir(parents=True)
    image = fits.getdata(lens / f"{lens.name}.fits", "VIS_FLUX")
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(image, name="VIS_BGSUB")]).writeto(
        dataset / f"{lens.name}.fits"
    )
    pollution = np.zeros_like(image)
    pollution[23:27, 54:60] = 1
    fits.writeto(dataset / "segmentation" / "artefact_binary.fits", pollution)
    output = tmp_path / "output" / lens.name
    preflight = ["preflight", "--lens-dir", str(lens), "--output-dir", str(output)]
    return lens, dataset, pollution, output, preflight


def test_official_pixels_replace_detection_and_reach_stage_preparation(tmp_path, monkeypatch):
    lens, dataset, pollution, output, preflight = _euclid_dataset(tmp_path)

    def unexpected_detection(*args):
        raise AssertionError("the official mask replaces source detection")

    monkeypatch.setattr(diagnostics, "_three_sigma_segmentation", unexpected_detection)
    monkeypatch.setenv("LENS_AGENT_EUCLID_RELEASE_ROOT", str(dataset.parents[1]))
    main([*preflight, "--input-x-direction", "decreasing", "--input-y-direction", "decreasing"])
    packet_path = output / "preflight" / "inspection.json"
    manifest_path = output / "run-manifest.json"
    packet = json.loads(packet_path.read_text())
    manifest = json.loads(manifest_path.read_text())
    assert packet["euclid_contamination"] == manifest["euclid_contamination"]
    assert packet["segmentation_detection"] == {"method": "euclid_dr1_artefact_binary"}
    assert (packet_path.parent / "display-manifest.json").is_file()
    expected_contamination = pollution[::-1, ::-1] == 1
    np.testing.assert_array_equal(fits.getdata(packet_path.parent / "segmentation.fits") > 0, expected_contamination)

    decision = model_inspector_decision(lens.name)
    response = tmp_path / "response.json"
    response.write_text(json.dumps({**decision, "contaminant_ids": [1]}))
    votes = ["inspector", "votes", "--output-dir", str(output), *(["--response", str(response)] * 3)]
    with pytest.raises(ValueError, match="requires empty contaminant_ids"):
        main(votes)
    assert not (packet_path.parent / "inspector-votes").exists()
    response.write_text(json.dumps(decision))
    main(votes)
    main(["inspector", "synthesis", "--output-dir", str(output), "--response", str(response)])
    main(["mask", "--output-dir", str(output), "--inspection", str(packet_path.parent / "synthesis.json")])

    mask, header = fits.getdata(packet_path.parent / "modeling_mask.fits", header=True)
    yy, xx = np.indices(mask.shape)
    expected_outside = np.hypot(xx - 49.5, yy - 49.5) > 40.0
    np.testing.assert_array_equal(mask, expected_outside | expected_contamination)
    assert header["MASKSRC"] == "EUCLID_DR1"
    assert np.count_nonzero(~mask.astype(bool)) == 5000
    main(["stage", "--lens-dir", str(lens), "--output-dir", str(output),
          "--stage", "a", "--attempt", "0", "--prepare-only"])
    with fits.open(lens / f"{lens.name}.fits", mode="update") as hdus:
        hdus["VIS_FLUX"].data[0, 0] += 1
    with pytest.raises(StageInputError, match="changed since verification"):
        check_stage_input(lens, output)


@pytest.mark.parametrize("mismatch", ["cutout", "mask"])
def test_official_inputs_are_validated_before_creating_a_run(tmp_path, mismatch):
    lens, dataset, _, output, preflight = _euclid_dataset(tmp_path)
    if mismatch == "cutout":
        with fits.open(dataset / f"{lens.name}.fits", mode="update") as hdus:
            hdus["VIS_BGSUB"].data[0, 0] += 1
        expected_error = "pixels do not match"
    else:
        with fits.open(dataset / "segmentation" / "artefact_binary.fits", mode="update") as hdus:
            hdus[0].data[0, 0] = 2
        expected_error = "must be binary"
    with pytest.raises(ValueError, match=expected_error):
        main([*preflight, "--euclid-dataset-dir", str(dataset)])
    assert not output.exists()


def test_mask_source_cannot_change_after_preflight(tmp_path):
    _, dataset, _, output, preflight = _euclid_dataset(tmp_path)
    main([*preflight, "--euclid-dataset-dir", str(dataset)])
    manifest = output / "run-manifest.json"
    segmentation = output / "preflight" / "segmentation.fits"
    before = (manifest.read_bytes(), segmentation.read_bytes())
    with fits.open(dataset / "segmentation" / "artefact_binary.fits", mode="update") as hdus:
        hdus[0].data[31, 17] = 1
    with pytest.raises(ValueError, match="mask has changed since preflight"):
        main(preflight)
    assert (manifest.read_bytes(), segmentation.read_bytes()) == before


def test_original_cutout_provenance_selects_euclid_and_missing_sidecar_falls_back(tmp_path, monkeypatch):
    lens, dataset, _, output, preflight = _euclid_dataset(tmp_path)
    monkeypatch.delenv("LENS_AGENT_EUCLID_RELEASE_ROOT", raising=False)
    sidecar = dataset / "segmentation" / "artefact_binary.fits"
    (lens / "input-provenance.json").write_text(json.dumps({"original_fits": str(dataset / f"{lens.name}.fits")}))
    main(preflight)
    inspection = output / "preflight" / "inspection.json"
    assert json.loads(inspection.read_text())["euclid_contamination"]["dataset_dir"] == str(dataset)
    sidecar.unlink()
    fallback = tmp_path / "fallback" / lens.name
    main([*preflight[:-1], str(fallback)])
    packet = json.loads((fallback / "preflight" / "inspection.json").read_text())
    assert packet["segmentation_detection"]["method"] == "single_threshold"
    assert "euclid_contamination" not in packet
