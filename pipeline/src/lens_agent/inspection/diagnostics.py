from __future__ import annotations

import json
import warnings
from inspect import signature
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.patheffects as path_effects
import matplotlib.pyplot as plt
import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from matplotlib import colormaps
from matplotlib.colors import BoundaryNorm, ListedColormap
from photutils.segmentation import SegmentationImage, deblend_sources, detect_sources
from photutils.utils.exceptions import NoDetectionsWarning

from ..configuration import InputGeometry
from ..data import load_lens_data
from ..visualization.stci_core import make_color_array, make_mono_array


PREFLIGHT_DETECTION_SIGMA = 3.0
PREFLIGHT_MIN_CONNECTED_PIXELS = 5
PREFLIGHT_DEBLEND_N_LEVELS = 32
PREFLIGHT_DEBLEND_CONTRAST = 0.001


def _detect_preflight_sources(
    data_bkgsub: np.ndarray, threshold: float
) -> SegmentationImage | None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NoDetectionsWarning)
        # Photutils renamed npixels to n_pixels; retain the same detection policy.
        parameters = signature(detect_sources).parameters
        pixels_keyword = "n_pixels" if "n_pixels" in parameters else "npixels"
        return detect_sources(
            data_bkgsub,
            threshold,
            **{pixels_keyword: PREFLIGHT_MIN_CONNECTED_PIXELS},
        )


def _extent(shape: tuple[int, int], pixel_scale_arcsec: float) -> tuple[float, float, float, float]:
    ny, nx = shape
    return (
        -nx * pixel_scale_arcsec / 2.0,
        nx * pixel_scale_arcsec / 2.0,
        -ny * pixel_scale_arcsec / 2.0,
        ny * pixel_scale_arcsec / 2.0,
    )


def _central_slices(shape: tuple[int, int], radius_pixels: int) -> tuple[slice, slice]:
    # Odd arrays have a central pixel; even arrays have a centre between pixels.
    # Preserve that parity, including the final row/column of a small odd image.
    return tuple(
        slice(max(0, size // 2 - radius_pixels), min(size, size // 2 + radius_pixels + size % 2))
        for size in shape
    )


def _crop_extent(
    image_shape: tuple[int, int], y_slice: slice, x_slice: slice, pixel_scale_arcsec: float
) -> tuple[float, float, float, float]:
    """Pixel-edge coordinates in the parent image's centred coordinate frame."""
    ny, nx = image_shape
    return (
        (x_slice.start - nx / 2.0) * pixel_scale_arcsec,
        (x_slice.stop - nx / 2.0) * pixel_scale_arcsec,
        (y_slice.start - ny / 2.0) * pixel_scale_arcsec,
        (y_slice.stop - ny / 2.0) * pixel_scale_arcsec,
    )


def _data_pixel_scale(data, explicit: float | None) -> float:
    scale = float(getattr(data, "pixel_scale_arcsec", 0.1))
    if not np.isfinite(scale) or scale <= 0:
        raise ValueError("input pixel scale must be finite and positive")
    if explicit is not None and not np.isclose(explicit, scale, rtol=1e-12, atol=0.0):
        raise ValueError("display pixel scale conflicts with the loaded input geometry")
    return scale


def _canonical_geometry_header(shape: tuple[int, int], geometry: InputGeometry) -> fits.Header:
    header = fits.Header()
    header["CDELT1"] = (geometry.pixel_scale_arcsec, "arcsec per canonical column")
    header["CDELT2"] = (geometry.pixel_scale_arcsec, "arcsec per canonical row")
    header["CUNIT1"] = header["CUNIT2"] = "arcsec"
    header["CRPIX1"] = (shape[1] + 1) / 2.0
    header["CRPIX2"] = (shape[0] + 1) / 2.0
    header["CRVAL1"] = header["CRVAL2"] = 0.0
    header["INPXDIR"] = geometry.input_x_direction
    header["INPYDIR"] = geometry.input_y_direction
    return header


def _inspection_rgb(
    data, *, y_slice: slice, x_slice: slice
) -> tuple[np.ndarray, str]:
    """Render the visual crop as a J/Y/VIS composite, with a VIS fallback."""
    if data.image_j is None or data.image_y is None:
        vis = make_mono_array(data.image[y_slice, x_slice], input_mode="raw")
        return np.dstack((vis, vis, vis)), "VIS display (NIR J/Y unavailable)"
    return (
        make_color_array(
            [
                data.image_j[y_slice, x_slice],
                data.image_y[y_slice, x_slice],
                data.image[y_slice, x_slice],
            ],
            input_mode="raw", ReplaceL=True, reference_ROI=None,
        ),
        "STCI MTF colour composite (J / Y / VIS)",
    )


def _add_modeling_radius_marker(
    axis, *, modeling_radius_arcsec: float, colour: str
) -> None:
    """Mark the nominal circular modelling domain with a contrast-aware circle."""
    axis.add_patch(
        plt.Circle(
            (0, 0),
            modeling_radius_arcsec,
            fill=False,
            color=colour,
            lw=1.2,
            zorder=10,
            clip_on=False,
        )
    )


def _segment_label_anchor(
    region: np.ndarray,
    *,
    image_shape: tuple[int, int],
    pixel_scale_arcsec: float,
    field_radius_arcsec: float,
    keep_inside: bool,
    image_extent: tuple[float, float, float, float] | None = None,
) -> tuple[float, float, str, str]:
    yy, xx = np.nonzero(region)
    extent = image_extent if image_extent is not None else _extent(image_shape, pixel_scale_arcsec)
    label_x = extent[0] + (float(np.median(xx)) + 0.5) * pixel_scale_arcsec
    label_y = extent[2] + (float(np.median(yy)) + 0.5) * pixel_scale_arcsec
    horizontal_alignment = "center"
    vertical_alignment = "center"
    if keep_inside:
        edge_margin = 0.3
        if label_x > field_radius_arcsec - edge_margin:
            horizontal_alignment = "right"
        elif label_x < -field_radius_arcsec + edge_margin:
            horizontal_alignment = "left"
        if label_y > field_radius_arcsec - edge_margin:
            vertical_alignment = "top"
        elif label_y < -field_radius_arcsec + edge_margin:
            vertical_alignment = "bottom"
    return label_x, label_y, horizontal_alignment, vertical_alignment


def _draw_central_preflight_panels(
    axes,
    *,
    rgb: np.ndarray,
    zoom_labels: np.ndarray,
    zoom_extent: tuple[float, float, float, float],
    colour_title: str,
    field_title: str,
    field_radius_arcsec: float,
    modeling_radius_arcsec: float,
    pixel_scale_arcsec: float,
    base_colours,
    keep_edge_labels_inside: bool = False,
) -> None:
    """Draw the three central panels retained in the six-panel human audit."""
    for axis, title in zip(
        axes,
        (
            f"{colour_title}\n({field_title})",
            "Colour composite with contours",
            "Colour composite with segment IDs",
        ),
    ):
        axis.imshow(rgb, origin="lower", extent=zoom_extent)
        axis.set_title(title)
        axis.set_xlim(-field_radius_arcsec, field_radius_arcsec)
        axis.set_ylim(-field_radius_arcsec, field_radius_arcsec)

    _add_modeling_radius_marker(
        axes[0], modeling_radius_arcsec=modeling_radius_arcsec, colour="lime"
    )
    for axis in axes[1:]:
        _add_modeling_radius_marker(
            axis, modeling_radius_arcsec=modeling_radius_arcsec, colour="white"
        )

    visible_labels = [int(value) for value in np.unique(zoom_labels) if value]
    for label in sorted(visible_labels):
        region = zoom_labels == label
        colour = base_colours((label - 1) % 20)
        for axis in axes[1:]:
            axis.contour(
                region,
                levels=[0.5],
                colors=[colour],
                linestyles="-",
                linewidths=1.3,
                alpha=1.0,
                origin="lower",
                extent=zoom_extent,
            )
        label_x, label_y, horizontal_alignment, vertical_alignment = (
            _segment_label_anchor(
                region,
                image_shape=zoom_labels.shape,
                pixel_scale_arcsec=pixel_scale_arcsec,
                field_radius_arcsec=field_radius_arcsec,
                keep_inside=keep_edge_labels_inside,
                image_extent=zoom_extent,
            )
        )
        axes[2].text(
            label_x,
            label_y,
            str(label),
            color="yellow",
            fontsize=10,
            fontweight="bold",
            ha=horizontal_alignment,
            va=vertical_alignment,
        )


def _render_preflight_visual_prompt(
    output_dir: Path,
    data,
    labels: np.ndarray,
    *,
    pixel_scale_arcsec: float | None = None,
    modeling_radius_arcsec: float = 4.0,
) -> Path:
    """Render a high-information, display-only prompt for the preflight reviewer."""
    pixel_scale_arcsec = _data_pixel_scale(data, pixel_scale_arcsec)
    full_extent = _extent(data.image.shape, pixel_scale_arcsec)
    radius_pixels = max(1, round(modeling_radius_arcsec / pixel_scale_arcsec))
    y_slice, x_slice = _central_slices(data.image.shape, radius_pixels)
    zoom_extent = _crop_extent(data.image.shape, y_slice, x_slice, pixel_scale_arcsec)
    rgb, colour_title = _inspection_rgb(data, y_slice=y_slice, x_slice=x_slice)
    vis_background_subtracted = data.image - sigma_clipped_stats(data.image, sigma=3.0)[1]

    fig, axes = plt.subplots(2, 3, figsize=(17, 11), constrained_layout=True)
    fig.get_layout_engine().set(rect=(0.0, 0.0, 1.0, 0.92))
    fig.suptitle(f"Preflight visual prompt: {data.lens_id}", fontsize=15, fontweight="bold")

    axis = axes[0, 0]
    axis.imshow(make_mono_array(data.image, input_mode="raw"), origin="lower", cmap="gray", extent=full_extent)
    _add_modeling_radius_marker(
        axis, modeling_radius_arcsec=modeling_radius_arcsec, colour="lime"
    )
    axis.set_title("VIS band (STCI MTF)")

    axis = axes[0, 1]
    vmax = max(float(np.percentile(np.abs(vis_background_subtracted), 99)), np.finfo(float).eps)
    axis.imshow(
        vis_background_subtracted, origin="lower", cmap="RdBu_r", vmin=-0.3 * vmax,
        vmax=vmax, extent=full_extent,
    )
    axis.contour(
        labels > 0, levels=[0.5], colors="cyan", linewidths=0.8,
        extent=full_extent, origin="lower",
    )
    _add_modeling_radius_marker(
        axis, modeling_radius_arcsec=modeling_radius_arcsec, colour="black"
    )
    axis.set_title("Background-subtracted VIS\n(cyan = 3σ segmentation)")

    axis = axes[0, 2]
    label_count = int(labels.max())
    base_colours = colormaps["tab20"]
    segmentation_colours = ListedColormap(
        [base_colours(index % 20) for index in range(max(1, label_count))]
    )
    segmentation_norm = BoundaryNorm(
        np.arange(0.5, max(1, label_count) + 1.5), segmentation_colours.N
    )
    segmentation_image = axis.imshow(
        np.ma.masked_equal(labels, 0), origin="lower", cmap=segmentation_colours,
        norm=segmentation_norm, interpolation="nearest", extent=full_extent,
    )
    _add_modeling_radius_marker(
        axis, modeling_radius_arcsec=modeling_radius_arcsec, colour="black"
    )
    axis.set_title(f"Segmentation map ({int(labels.max())} IDs)")
    if label_count:
        fig.colorbar(
            segmentation_image,
            ax=axis,
            fraction=0.046,
            pad=0.04,
            label="segment label",
        )

    zoom_labels = labels[y_slice, x_slice]
    _draw_central_preflight_panels(
        axes[1],
        rgb=rgb,
        zoom_labels=zoom_labels,
        zoom_extent=zoom_extent,
        colour_title=colour_title,
        field_title=f"central {2 * modeling_radius_arcsec:.0f}\" field",
        field_radius_arcsec=modeling_radius_arcsec,
        modeling_radius_arcsec=modeling_radius_arcsec,
        pixel_scale_arcsec=pixel_scale_arcsec,
        base_colours=base_colours,
    )
    for axis in axes.flat:
        axis.set_xlabel("x [arcsec]")
        axis.set_ylabel("y [arcsec]")
    target = output_dir / "preflight_6panel.png"
    fig.savefig(target, dpi=150)
    plt.close(fig)
    return target


def _render_preflight_inspector_prompt(
    output_dir: Path,
    data,
    labels: np.ndarray,
    *,
    pixel_scale_arcsec: float | None = None,
    modeling_radius_arcsec: float = 4.0,
) -> Path:
    """Render the central two-panel prompt consumed by the System Inspector.

    One pixel of context outside the 4 arcsec circle remains visible so axial boundary crossings
    can be judged as well as crossings near the corners.
    """
    pixel_scale_arcsec = _data_pixel_scale(data, pixel_scale_arcsec)
    radius_pixels = max(
        1,
        int(np.floor(modeling_radius_arcsec / pixel_scale_arcsec + 0.5)) + 1,
    )
    y_slice, x_slice = _central_slices(data.image.shape, radius_pixels)
    zoom_extent = _crop_extent(data.image.shape, y_slice, x_slice, pixel_scale_arcsec)
    rgb, colour_title = _inspection_rgb(data, y_slice=y_slice, x_slice=x_slice)
    field_radius_arcsec = radius_pixels * pixel_scale_arcsec

    # Keep the square sky panels at nearly the same pixel size while removing
    # the unused horizontal canvas that equal-aspect axes otherwise create.
    fig, axes = plt.subplots(1, 2, figsize=(11, 6.4))
    fig.subplots_adjust(left=0.05, right=0.99, top=0.84, bottom=0.10, wspace=0.05)
    fig.suptitle(f"Preflight inspector prompt: {data.lens_id}", fontsize=15, fontweight="bold")
    zoom_labels = labels[y_slice, x_slice]
    titles = (
        (
            f"{colour_title}\n(central {2 * field_radius_arcsec:.1f}\" field; "
            f"{modeling_radius_arcsec:.0f}\" aperture)"
        ),
        "Colour composite with contours and segment IDs",
    )
    for axis, title in zip(axes, titles):
        axis.imshow(rgb, origin="lower", extent=zoom_extent)
        axis.set_title(title)
        axis.set_xlim(-field_radius_arcsec, field_radius_arcsec)
        axis.set_ylim(-field_radius_arcsec, field_radius_arcsec)
        _add_modeling_radius_marker(
            axis, modeling_radius_arcsec=modeling_radius_arcsec, colour="lime"
        )

    for label in sorted(int(value) for value in np.unique(zoom_labels) if value):
        region = zoom_labels == label
        contour = axes[1].contour(
            region,
            levels=[0.5],
            colors=["white"],
            linestyles="-",
            linewidths=1.3,
            alpha=1.0,
            origin="lower",
            extent=zoom_extent,
        )
        contour.set_path_effects(
            [path_effects.withStroke(linewidth=2.5, foreground="black")]
        )
        label_x, label_y, horizontal_alignment, vertical_alignment = (
            _segment_label_anchor(
                region,
                image_shape=zoom_labels.shape,
                pixel_scale_arcsec=pixel_scale_arcsec,
                field_radius_arcsec=field_radius_arcsec,
                keep_inside=True,
                image_extent=zoom_extent,
            )
        )
        text = axes[1].text(
            label_x,
            label_y,
            str(label),
            color="yellow",
            fontsize=10,
            fontweight="bold",
            ha=horizontal_alignment,
            va=vertical_alignment,
        )
        text.set_path_effects(
            [path_effects.withStroke(linewidth=2.0, foreground="black")]
        )
    for axis in axes:
        axis.set_xlabel("x [arcsec]")
        axis.set_ylabel("y [arcsec]")
    target = output_dir / "preflight_2panel.png"
    fig.savefig(target, dpi=150)
    plt.close(fig)
    return target


def _three_sigma_segmentation(data_bkgsub: np.ndarray, std: float) -> np.ndarray:
    segmentation = _detect_preflight_sources(
        data_bkgsub,
        PREFLIGHT_DETECTION_SIGMA * std,
    )
    if segmentation is None:
        return np.zeros(data_bkgsub.shape, dtype=np.int32)
    parameters = signature(deblend_sources).parameters
    segmentation_kwargs = {
        "n_pixels" if "n_pixels" in parameters else "npixels": PREFLIGHT_MIN_CONNECTED_PIXELS,
        "n_levels" if "n_levels" in parameters else "nlevels": PREFLIGHT_DEBLEND_N_LEVELS,
    }
    try:
        segmentation = deblend_sources(
            data_bkgsub,
            segmentation,
            **segmentation_kwargs,
            contrast=PREFLIGHT_DEBLEND_CONTRAST,
            progress_bar=False,
        )
    except ValueError:
        pass
    return np.asarray(segmentation.data, dtype=np.int32)


def build_inspection_packet(
    lens_dir: Path, output_dir: Path, *, geometry: InputGeometry | None = None
) -> Path:
    data = load_lens_data(lens_dir, geometry=geometry)
    input_geometry = InputGeometry(
        pixel_scale_arcsec=data.pixel_scale_arcsec,
        input_x_direction=data.input_x_direction,
        input_y_direction=data.input_y_direction,
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    _, median, std = sigma_clipped_stats(data.image, sigma=3.0)
    data_bkgsub = data.image - median
    labels = _three_sigma_segmentation(data_bkgsub, float(std))
    seg_path = output_dir / "segmentation.fits"
    fits.writeto(seg_path, labels, header=_canonical_geometry_header(labels.shape, input_geometry), overwrite=True)

    human_audit_path = _render_preflight_visual_prompt(output_dir, data, labels)
    inspector_prompt_path = _render_preflight_inspector_prompt(output_dir, data, labels)

    packet = {
        "schema_version": "inspection_packet.v5",
        "lens_id": data.lens_id,
        "lens_dir": str(lens_dir.resolve()),
        "image_shape": list(data.image.shape),
        "input_geometry": input_geometry.model_dump(mode="json"),
        "coordinate_frame": {
            "origin": "image_center",
            "center_pixel_zero_based": [(data.image.shape[1] - 1) / 2.0, (data.image.shape[0] - 1) / 2.0],
            "x_direction": "increasing_with_column",
            "y_direction": "increasing_with_row",
            "units": "arcsec",
        },
        "segment_count": int(labels.max()),
        "segmentation_detection": {
            "method": "single_threshold",
            "threshold_sigma": PREFLIGHT_DETECTION_SIGMA,
            "polarity": "positive",
            "min_connected_pixels": PREFLIGHT_MIN_CONNECTED_PIXELS,
            "deblend_enabled": True,
            "deblend_n_levels": PREFLIGHT_DEBLEND_N_LEVELS,
            "deblend_contrast": PREFLIGHT_DEBLEND_CONTRAST,
        },
        "artifacts": {
            "segmentation_fits": str(seg_path.resolve()),
            "inspector_prompt_png": str(inspector_prompt_path.resolve()),
            "human_audit_png": str(human_audit_path.resolve()),
        },
    }
    target = output_dir / "inspection.json"
    target.write_text(json.dumps(packet, indent=2) + "\n", encoding="utf-8")
    return target


def materialize_modeling_mask(
    output_dir: Path,
    contaminant_ids: list[int],
    *,
    pixel_scale_arcsec: float | None = None,
    modeling_radius_arcsec: float = 4.0,
) -> Path:
    packet_path = output_dir / "inspection.json"
    saved_geometry = None
    if packet_path.is_file():
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
        if "input_geometry" in packet:
            saved_geometry = InputGeometry.model_validate(packet["input_geometry"])
    if saved_geometry is not None:
        if pixel_scale_arcsec is not None and not np.isclose(
            pixel_scale_arcsec, saved_geometry.pixel_scale_arcsec, rtol=1e-12, atol=0.0
        ):
            raise ValueError("mask pixel scale conflicts with the inspection input geometry")
        geometry = saved_geometry
    else:
        # Historical packets predate geometry metadata and used 0.1 by default.
        geometry = InputGeometry(pixel_scale_arcsec=0.1 if pixel_scale_arcsec is None else pixel_scale_arcsec)
    pixel_scale_arcsec = geometry.pixel_scale_arcsec
    labels = np.asarray(fits.getdata(output_dir / "segmentation.fits"), dtype=np.int32)
    known = set(int(value) for value in np.unique(labels))
    unknown = sorted(set(contaminant_ids) - known)
    if unknown:
        raise ValueError(f"unknown segmentation IDs: {unknown}")
    yy, xx = np.indices(labels.shape)
    center_y = (labels.shape[0] - 1) / 2.0
    center_x = (labels.shape[1] - 1) / 2.0
    radius_pixels = modeling_radius_arcsec / pixel_scale_arcsec
    outside_modeling_region = np.hypot(xx - center_x, yy - center_y) > radius_pixels
    mask = outside_modeling_region | np.isin(labels, contaminant_ids)
    target = output_dir / "modeling_mask.fits"
    fits.writeto(target, mask.astype(np.uint8), header=_canonical_geometry_header(mask.shape, geometry), overwrite=True)
    return target
