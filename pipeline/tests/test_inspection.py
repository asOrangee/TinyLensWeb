from pathlib import Path
import json

from matplotlib import image as mpl_image
from matplotlib import colormaps
from matplotlib import pyplot as plt
from matplotlib.axes import Axes
from matplotlib.patches import Circle
import numpy as np
import pytest
from astropy.io import fits

from lens_agent.configuration import InputGeometry
from lens_agent.data import load_lens_data
from lens_agent.inspection import build_inspection_packet, materialize_modeling_mask
from lens_agent.inspection.diagnostics import (
    _draw_central_preflight_panels,
    _central_slices,
    _crop_extent,
    _inspection_rgb,
    _render_preflight_inspector_prompt,
    _segment_label_anchor,
    _three_sigma_segmentation,
)
from lens_agent.visualization.stci_core import make_color_array
from tests.helpers import make_lens_dir


def _replace_science_images(lens_dir: Path, image: np.ndarray) -> None:
    fits_path = lens_dir / f"{lens_dir.name}.fits"
    with fits.open(fits_path, mode="update") as hdul:
        hdul["VIS_FLUX"].data[...] = image
        hdul["NIR_Y_FLUX"].data[...] = image
        hdul["NIR_J_FLUX"].data[...] = image


def _write_three_sigma_segmentation_fixture(lens_dir: Path) -> None:
    yy, xx = np.indices((64, 64))
    image = np.where((xx + yy) % 2 == 0, -1.0, 1.0)
    image[20:23, 20:23] = 2.5
    image[20:22, 20:23] = 5.0
    image[40, 40:45] = 2.5
    _replace_science_images(lens_dir, image)


def test_inspection_excludes_pixels_below_the_three_sigma_detection_threshold(
) -> None:
    image = np.zeros((16, 16), dtype=float)
    image[4:7, 4:7] = 2.5
    image[4:6, 4:7] = 5.0

    labels = _three_sigma_segmentation(image, 1.0)

    assert set(np.unique(labels)) == {0, 1}
    assert np.all(labels[4:6, 4:7] == 1)
    assert np.all(labels[6, 4:7] == 0)


def test_inspection_records_single_threshold_segmentation_provenance(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path, image_shape=(64, 64))
    _write_three_sigma_segmentation_fixture(lens_dir)

    packet_path = build_inspection_packet(lens_dir, tmp_path / "inspection")
    packet = json.loads(packet_path.read_text())

    assert packet["schema_version"] == "inspection_packet.v5"
    assert packet["segmentation_detection"] == {
        "method": "single_threshold",
        "threshold_sigma": 3.0,
        "polarity": "positive",
        "min_connected_pixels": 5,
        "deblend_enabled": True,
        "deblend_n_levels": 32,
        "deblend_contrast": 0.001,
    }


def test_three_sigma_segmentation_requires_five_connected_pixels() -> None:
    image = np.zeros((64, 64), dtype=float)
    image[10, 10:15] = 3.5
    image[30, 30:34] = 5.0

    labels = _three_sigma_segmentation(image, 1.0)

    assert set(np.unique(labels)) == {0, 1}
    assert np.all(labels[10, 10:15] == 1)
    assert np.all(labels[30, 30:34] == 0)


def test_preflight_rendering_gives_every_segment_equal_prominence(
    monkeypatch,
) -> None:
    contour_options: list[dict] = []
    text_options: list[dict] = []
    contour = Axes.contour
    draw_text = Axes.text

    def record_contour(axis: Axes, values, *args, **kwargs):
        contour_options.append(kwargs)
        return contour(axis, values, *args, **kwargs)

    def record_text(axis: Axes, *args, **kwargs):
        text_options.append(kwargs)
        return draw_text(axis, *args, **kwargs)

    monkeypatch.setattr(Axes, "contour", record_contour)
    monkeypatch.setattr(Axes, "text", record_text)
    labels = np.zeros((16, 16), dtype=np.int32)
    labels[2:5, 2:5] = 1
    labels[10:13, 10:13] = 2
    fig, axes = plt.subplots(1, 3)
    try:
        _draw_central_preflight_panels(
            axes,
            rgb=np.zeros((16, 16, 3), dtype=float),
            zoom_labels=labels,
            zoom_extent=(-0.8, 0.8, -0.8, 0.8),
            colour_title="test",
            field_title="test field",
            field_radius_arcsec=0.8,
            modeling_radius_arcsec=0.6,
            pixel_scale_arcsec=0.1,
            base_colours=colormaps["tab20"],
        )
    finally:
        plt.close(fig)

    assert [options["linestyles"] for options in contour_options] == ["-"] * 4
    assert [options["linewidths"] for options in contour_options] == [1.3] * 4
    assert [options["alpha"] for options in contour_options] == [1.0] * 4
    assert [options["fontsize"] for options in text_options] == [10, 10]
    assert [options["fontweight"] for options in text_options] == ["bold", "bold"]
    assert [options["color"] for options in text_options] == ["yellow", "yellow"]


def test_three_sigma_segmentation_deblends_multiple_peaks(
    tmp_path: Path,
) -> None:
    lens_dir = make_lens_dir(tmp_path, image_shape=(64, 64))
    yy, xx = np.indices((64, 64))
    image = np.where((xx + yy) % 2 == 0, -1.0, 1.0)
    image += 15.0 * np.exp(-((xx - 20) ** 2 + (yy - 20) ** 2) / (2 * 1.2**2))
    image += 15.0 * np.exp(-((xx - 26) ** 2 + (yy - 20) ** 2) / (2 * 1.2**2))
    image[20, 20:27] = 5.0
    _replace_science_images(lens_dir, image)

    packet_path = build_inspection_packet(lens_dir, tmp_path / "inspection")
    packet = json.loads(packet_path.read_text())
    labels = np.asarray(fits.getdata(packet["artifacts"]["segmentation_fits"]), dtype=int)

    assert packet["segment_count"] == 2
    assert {int(labels[20, 20]), int(labels[20, 26])} == {1, 2}


def test_three_sigma_segments_are_labelled_consecutively(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path, image_shape=(64, 64))
    yy, xx = np.indices((64, 64))
    image = np.where((xx + yy) % 2 == 0, -1.0, 1.0)
    image[10, 10:15] = 5.0
    image[20, 10:15] = 3.5
    image[30, 10:15] = 5.0
    _replace_science_images(lens_dir, image)

    packet_path = build_inspection_packet(lens_dir, tmp_path / "inspection")
    packet = json.loads(packet_path.read_text())
    labels = np.asarray(fits.getdata(packet["artifacts"]["segmentation_fits"]), dtype=int)

    assert packet["segment_count"] == 2
    assert int(labels[10, 10]) == 1
    assert int(labels[20, 10]) == 0
    assert int(labels[30, 10]) == 2
    assert set(np.unique(labels)) == {0, 1, 2}


def test_inspection_writes_empty_segmentation_when_no_three_sigma_detection_exists(
    tmp_path: Path,
) -> None:
    lens_dir = make_lens_dir(tmp_path, image_shape=(64, 64))
    yy, xx = np.indices((64, 64))
    image = np.where((xx + yy) % 2 == 0, -1.0, 1.0)
    image[30, 20:25] = 3.5
    _replace_science_images(lens_dir, image)

    packet_path = build_inspection_packet(lens_dir, tmp_path / "inspection")
    packet = json.loads(packet_path.read_text())
    labels = np.asarray(fits.getdata(packet["artifacts"]["segmentation_fits"]), dtype=int)

    assert not np.any(labels)
    assert packet["segment_count"] == 0


def test_inspection_does_not_exempt_unseeded_boundary_crossing_island(
    tmp_path: Path,
) -> None:
    lens_dir = make_lens_dir(tmp_path, image_shape=(100, 100))
    yy, xx = np.indices((100, 100))
    image = np.where((xx + yy) % 2 == 0, -1.0, 1.0)
    image[20, 20:25] = 5.0
    image[50, 88:93] = 3.5
    _replace_science_images(lens_dir, image)

    packet_path = build_inspection_packet(lens_dir, tmp_path / "inspection")
    packet = json.loads(packet_path.read_text())
    labels = np.asarray(fits.getdata(packet["artifacts"]["segmentation_fits"]), dtype=int)

    assert np.all(labels[20, 20:25] == 1)
    assert np.all(labels[50, 88:93] == 0)


def test_human_audit_contours_only_the_three_sigma_segments(
    tmp_path: Path, monkeypatch
) -> None:
    contour_inputs: list[np.ndarray] = []
    contour_options: list[dict] = []
    contour_sets = []
    contour = Axes.contour

    def record_contour(axis: Axes, values, *args, **kwargs):
        contour_inputs.append(np.asarray(values))
        contour_options.append(kwargs)
        result = contour(axis, values, *args, **kwargs)
        contour_sets.append(result)
        return result

    monkeypatch.setattr(Axes, "contour", record_contour)
    lens_dir = make_lens_dir(tmp_path, image_shape=(64, 64))
    _write_three_sigma_segmentation_fixture(lens_dir)

    build_inspection_packet(lens_dir, tmp_path / "inspection")

    assert len(contour_inputs) == 4
    assert contour_inputs[0].dtype == np.dtype(bool)
    assert np.all(contour_inputs[0][20:22, 20:23])
    assert not np.any(contour_inputs[0][22, 20:23])
    assert all(not np.any(values[40, 40:45]) for values in contour_inputs)
    assert all(options["linestyles"] == "-" for options in contour_options[1:])
    assert all(options["linewidths"] == 1.3 for options in contour_options[1:])
    assert all(options["alpha"] == 1.0 for options in contour_options[1:])
    assert contour_options[-1]["colors"] == ["white"]
    assert contour_sets[-1].get_path_effects()


def test_inspection_materializes_exact_local_mask(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output = tmp_path / "inspection"
    packet_path = build_inspection_packet(lens_dir, output, geometry=InputGeometry(pixel_scale_arcsec=0.2))
    packet = json.loads(packet_path.read_text())

    mask_path = materialize_modeling_mask(output, [], pixel_scale_arcsec=0.2)
    mask = np.asarray(fits.getdata(mask_path), dtype=bool)

    assert not mask[mask.shape[0] // 2, mask.shape[1] // 2]
    assert mask[0, 0]
    assert packet["schema_version"] == "inspection_packet.v5"
    assert set(packet["artifacts"]) == {
        "segmentation_fits",
        "inspector_prompt_png",
        "human_audit_png",
    }
    prompt = Path(packet["artifacts"]["inspector_prompt_png"])
    audit = Path(packet["artifacts"]["human_audit_png"])
    assert prompt.name == "preflight_2panel.png"
    assert audit.name == "preflight_6panel.png"
    assert prompt.is_file()
    assert audit.is_file()
    assert prompt.stat().st_size > 10_000
    assert audit.stat().st_size > 10_000
    assert mpl_image.imread(prompt).shape[:2] == (960, 1650)
    assert mpl_image.imread(audit).shape[:2] == (1650, 2550)


def test_selected_segment_is_not_dilated(tmp_path: Path) -> None:
    lens_dir = make_lens_dir(tmp_path)
    output = tmp_path / "inspection"
    build_inspection_packet(lens_dir, output, geometry=InputGeometry(pixel_scale_arcsec=0.2))
    labels = np.asarray(fits.getdata(output / "segmentation.fits"), dtype=int)
    segment_id = int(labels.max())
    assert segment_id > 0

    mask = np.asarray(
        fits.getdata(materialize_modeling_mask(output, [segment_id], pixel_scale_arcsec=0.2)),
        dtype=bool,
    )

    assert np.all(mask[labels == segment_id])
    assert np.any((labels == 0) & ~mask)


def test_boundary_crossing_segment_is_not_added_when_inspector_omits_it(tmp_path: Path) -> None:
    output = tmp_path / "inspection"
    output.mkdir()
    labels = np.zeros((100, 100), dtype=np.int32)
    labels[50, 69:71] = 1
    fits.writeto(output / "segmentation.fits", labels)

    mask = np.asarray(
        fits.getdata(materialize_modeling_mask(output, [], pixel_scale_arcsec=0.2)),
        dtype=bool,
    )

    assert not mask[50, 69]
    assert mask[50, 70]


def test_preflight_visuals_mark_modeling_radius_on_all_eight_panels(
    tmp_path: Path, monkeypatch
) -> None:
    circles: list[tuple[Axes, Circle]] = []
    add_patch = Axes.add_patch

    def record_circle(axis: Axes, patch):
        if isinstance(patch, Circle):
            circles.append((axis, patch))
        return add_patch(axis, patch)

    monkeypatch.setattr(Axes, "add_patch", record_circle)
    build_inspection_packet(make_lens_dir(tmp_path), tmp_path / "inspection")

    assert len(circles) == 8
    assert {axis.get_xlabel() for axis, _ in circles} == {"x [arcsec]"}
    assert {axis.get_ylabel() for axis, _ in circles} == {"y [arcsec]"}
    assert {(circle.center, circle.radius) for _, circle in circles} == {((0, 0), 4.0)}
    assert [circle.get_edgecolor() for _, circle in circles] == [
        (0.0, 1.0, 0.0, 1.0),
        (0.0, 0.0, 0.0, 1.0),
        (0.0, 0.0, 0.0, 1.0),
        (0.0, 1.0, 0.0, 1.0),
        (1.0, 1.0, 1.0, 1.0),
        (1.0, 1.0, 1.0, 1.0),
        (0.0, 1.0, 0.0, 1.0),
        (0.0, 1.0, 0.0, 1.0),
    ]


def test_inspector_prompt_keeps_one_pixel_outside_the_four_arcsec_circle(
    tmp_path: Path, monkeypatch
) -> None:
    image_shapes: list[tuple[int, ...]] = []
    x_limits: list[tuple[float, float]] = []
    imshow = Axes.imshow
    set_xlim = Axes.set_xlim

    def record_image(axis: Axes, image, *args, **kwargs):
        image_shapes.append(np.asarray(image).shape)
        return imshow(axis, image, *args, **kwargs)

    def record_xlim(axis: Axes, *args, **kwargs):
        if len(args) >= 2 and all(isinstance(value, (int, float)) for value in args[:2]):
            x_limits.append((float(args[0]), float(args[1])))
        return set_xlim(axis, *args, **kwargs)

    monkeypatch.setattr(Axes, "imshow", record_image)
    monkeypatch.setattr(Axes, "set_xlim", record_xlim)
    build_inspection_packet(
        make_lens_dir(tmp_path, image_shape=(100, 100)), tmp_path / "inspection"
    )

    assert image_shapes[-2:] == [(82, 82, 3)] * 2
    np.testing.assert_allclose(x_limits[-2:], [(-4.1, 4.1)] * 2)


def test_inspection_rgb_normalizes_only_the_visual_crop(tmp_path: Path) -> None:
    data = load_lens_data(make_lens_dir(tmp_path))
    y_slice = x_slice = slice(8, 24)

    rendered, _ = _inspection_rgb(data, y_slice=y_slice, x_slice=x_slice)

    expected = make_color_array(
        [
            data.image_j[y_slice, x_slice],
            data.image_y[y_slice, x_slice],
            data.image[y_slice, x_slice],
        ],
        input_mode="raw",
        ReplaceL=True,
        reference_ROI=None,
    )
    np.testing.assert_array_equal(rendered, expected)


def test_preflight_accepts_renamed_photutils_keywords_without_changing_policy(monkeypatch) -> None:
    from photutils.segmentation import SegmentationImage
    from lens_agent.inspection import diagnostics

    labels = np.zeros((5, 5), dtype=np.int32)
    labels[1:4, 1:4] = 1
    calls = {}

    def detect_with_new_names(data, threshold, n_pixels):
        calls["detect"] = (threshold, n_pixels)
        return SegmentationImage(labels.copy())

    def deblend_with_new_names(data, segment_img, n_pixels, *, n_levels, contrast, progress_bar):
        calls["deblend"] = (n_pixels, n_levels, contrast, progress_bar)
        return segment_img

    monkeypatch.setattr(diagnostics, "detect_sources", detect_with_new_names)
    monkeypatch.setattr(diagnostics, "deblend_sources", deblend_with_new_names)
    actual = diagnostics._three_sigma_segmentation(np.ones((5, 5)), 2.0)

    np.testing.assert_array_equal(actual, labels)
    assert calls["detect"] == (6.0, 5)
    assert calls["deblend"] == (5, 32, 0.001, False)


@pytest.mark.parametrize(
    "shape,radius,expected",
    [
        ((151, 151), 80, (slice(0, 151), slice(0, 151))),
        ((100, 100), 41, (slice(9, 91), slice(9, 91))),
        ((101, 101), 41, (slice(9, 92), slice(9, 92))),
        ((151, 100), 80, (slice(0, 151), slice(0, 100))),
    ],
)
def test_central_crop_preserves_pixel_parity_and_parent_origin(shape, radius, expected):
    slices = _central_slices(shape, radius)
    assert slices == expected
    extent = _crop_extent(shape, *slices, 0.05)
    assert extent[0] == -extent[1]
    assert extent[2] == -extent[3]
    for size, crop, lower in zip(shape[::-1], slices[::-1], (extent[0], extent[2])):
        # Each displayed pixel retains exactly its parent-array coordinate.
        np.testing.assert_allclose(
            lower + (np.arange(crop.stop - crop.start) + 0.5) * 0.05,
            (np.arange(crop.start, crop.stop) - (size - 1) / 2.0) * 0.05,
            atol=1e-14,
        )


def test_asymmetric_crop_and_segment_anchor_keep_the_parent_coordinate_origin():
    extent = _crop_extent((151, 151), slice(1, 149), slice(3, 150), 0.05)
    np.testing.assert_allclose(extent, (-3.625, 3.725, -3.725, 3.675))
    region = np.zeros((148, 147), dtype=bool)
    region[74, 72] = True  # Parent pixel (75, 75) is the coordinate origin.
    x, y, *_ = _segment_label_anchor(
        region, image_shape=region.shape, pixel_scale_arcsec=0.05,
        field_radius_arcsec=4.0, keep_inside=False, image_extent=extent,
    )
    np.testing.assert_allclose((x, y), (0.0, 0.0), atol=1e-14)


def test_native_mock_geometry_reaches_segmentation_visuals_and_mask(tmp_path, monkeypatch):
    lens_dir = make_lens_dir(tmp_path, image_shape=(151, 151))
    yy, xx = np.indices((151, 151))
    image = np.where((xx + yy) % 2 == 0, -1.0, 1.0)
    image[20:23, 30:33] = 10.0
    _replace_science_images(lens_dir, image)
    displayed = []
    contour_options = []
    original_imshow, original_contour = Axes.imshow, Axes.contour

    def record_image(axis, array, *args, **kwargs):
        displayed.append((np.shape(array), kwargs.get("extent")))
        return original_imshow(axis, array, *args, **kwargs)

    def record_contour(axis, array, *args, **kwargs):
        contour_options.append(kwargs)
        return original_contour(axis, array, *args, **kwargs)

    monkeypatch.setattr(Axes, "imshow", record_image)
    monkeypatch.setattr(Axes, "contour", record_contour)
    geometry = InputGeometry(pixel_scale_arcsec=0.05, input_y_direction="decreasing")
    output = tmp_path / "inspection"
    packet = json.loads(build_inspection_packet(lens_dir, output, geometry=geometry).read_text())
    labels = fits.getdata(output / "segmentation.fits")
    assert packet["input_geometry"] == geometry.model_dump(mode="json")
    assert packet["coordinate_frame"]["center_pixel_zero_based"] == [75.0, 75.0]
    assert labels.shape == (151, 151)
    assert np.all(labels[128:131, 30:33] == 1)
    assert not np.any(labels[20:23, 30:33])
    assert displayed[-2:][0][0] == displayed[-2:][1][0] == (151, 151, 3)
    np.testing.assert_allclose([item[1] for item in displayed[-2:]], [(-3.775, 3.775, -3.775, 3.775)] * 2)
    assert all(options["origin"] == "lower" for options in contour_options)

    mask_path = materialize_modeling_mask(output, [])
    mask = np.asarray(fits.getdata(mask_path), dtype=bool)
    expected_outside = np.hypot((xx - 75) * 0.05, (yy - 75) * 0.05) > 4.0
    np.testing.assert_array_equal(mask, expected_outside)
    assert np.count_nonzero(~mask) == 19469
    header = fits.getheader(mask_path)
    assert (header["CDELT1"], header["CDELT2"], header["CRPIX1"], header["CRPIX2"]) == (0.05, 0.05, 76.0, 76.0)
    assert header["INPYDIR"] == "decreasing"
    with pytest.raises(ValueError, match="mask pixel scale conflicts"):
        materialize_modeling_mask(output, [], pixel_scale_arcsec=0.1)
    data = load_lens_data(lens_dir, geometry=geometry)
    with pytest.raises(ValueError, match="display pixel scale conflicts"):
        _render_preflight_inspector_prompt(output, data, labels, pixel_scale_arcsec=0.1)


def test_historical_mask_packet_keeps_legacy_default_scale(tmp_path):
    labels = np.zeros((101, 101), dtype=np.int32)
    fits.writeto(tmp_path / "segmentation.fits", labels)
    (tmp_path / "inspection.json").write_text(json.dumps({"schema_version": "inspection_packet.v5"}))
    mask = np.asarray(fits.getdata(materialize_modeling_mask(tmp_path, [])), dtype=bool)
    assert not mask[50, 90]
    assert mask[50, 91]
    assert fits.getheader(tmp_path / "modeling_mask.fits")["CDELT1"] == 0.1
