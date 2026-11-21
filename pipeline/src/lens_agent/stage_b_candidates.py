"""Generate a sealed comparison of Stage B masks without executing an attempt."""

from __future__ import annotations

import json
import os
import pickle
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from scipy import ndimage

from .attempts import manifest_paths, validate_decision_review_evidence
from .configuration import (
    ARC_SNR_THRESHOLD_MAX,
    ARC_SNR_THRESHOLD_MIN,
    PIPELINE_RELEASE_ID,
    EffectiveConfig,
    InputGeometry,
    run_input_geometry,
    stage_b_threshold_ext_size,
    uses_stage_b_threshold_expansion,
    validate_config_geometry,
    validate_run_manifest,
    validated_run_root,
)
from .data.loader import load_lens_data
from .modeling.arc_mask import construct_arc_mask
from .modeling.morphology_audit import _nearest_pixel_index
from .modeling.predicted_image_family import validate_predicted_image_family
from .stage_input import check_stage_input
from .workbench_display import file_sha256


SCHEMA = "stage_b_candidates.v1"
THRESHOLDS = tuple(range(ARC_SNR_THRESHOLD_MIN, ARC_SNR_THRESHOLD_MAX + 1))
_LEGACY_THRESHOLDS = tuple(range(2, 11))
PKL_REFERENCE = "artifacts/stage_a.pkl"
FAMILY_REFERENCE = "artifacts/stage_a_predicted_image_family.json"
MASK_REFERENCE = "preflight/modeling_mask.fits"


@dataclass(frozen=True)
class _Inputs:
    provenance: dict[str, Any]
    parameters: dict[str, int]
    threshold_expansion: bool
    geometry: InputGeometry
    family: dict[str, Any]
    excluded: np.ndarray
    snr: np.ndarray

    def ext_size(self, threshold: int) -> int:
        if self.threshold_expansion:
            return stage_b_threshold_ext_size(threshold)
        return self.parameters["arc_ext_size"]


class _StageArrays(pickle.Unpickler):
    def find_class(self, module: str, name: str) -> Any:
        if module == "numpy" and name in ("ndarray", "dtype"):
            return getattr(np, name)
        if module in ("numpy.core.multiarray", "numpy._core.multiarray") and name in (
            "_reconstruct", "scalar",
        ):
            return getattr(np.core.multiarray, name)
        if module in ("numpy.core.numeric", "numpy._core.numeric") and name == "_frombuffer":
            return np.core.numeric._frombuffer
        raise ValueError("Unsupported object in accepted Stage A pickle")


def _object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {path.name}")
    return value


def _frozen_input_hashes(
    run: Path, a_root: Path, result_sha: str, run_sha: str,
    fits_path: Path, input_sha: str, mask_sha: str, euclid: Any,
) -> dict[str, str]:
    """Check the preflight and accepted A input bindings, when published."""
    evidence: dict[str, str] = {}
    if euclid is not None and euclid.get("input_fits_sha256") != input_sha:
        raise ValueError("Input FITS differs from the frozen Euclid preflight")
    for folder, stage, attempt in ((run / "preflight", "preflight", None),
                                    (a_root, "a", int(a_root.name))):
        path = folder / "display-manifest.json"
        if not path.is_file():
            continue
        display = _object(path)
        if (display.get("run"), display.get("lens_id"), display.get("stage"), display.get("attempt")) != (
            str(run), run.name, stage, attempt,
        ) or display.get("run_manifest") != {"path": "run-manifest.json", "sha256": run_sha}:
            raise ValueError(f"The {stage} display does not belong to the frozen run")
        source = display.get("input", {})
        if source.get("path") != str(fits_path) or source.get("sha256") != input_sha:
            raise ValueError(f"Input FITS differs from the frozen {stage} input")
        if stage == "a":
            if display.get("summary") != {"path": "stage-result.json", "sha256": result_sha}:
                raise ValueError("Stage A display belongs to a different result")
            domain = display.get("modeling_mask")
            if domain is not None and domain != {"path": MASK_REFERENCE, "sha256": mask_sha}:
                raise ValueError("Modeling mask differs from the domain used by accepted Stage A")
        evidence[path.relative_to(run).as_posix()] = file_sha256(path)
    return evidence


def _read_modeling_mask(run: Path, geometry: InputGeometry, shape: tuple[int, int]) -> np.ndarray:
    with fits.open(run / MASK_REFERENCE, memmap=False) as hdus:
        array = np.asarray(hdus[0].data)
        header = hdus[0].header
    ny, nx = shape
    expected = {
        "CDELT1": geometry.pixel_scale_arcsec, "CDELT2": geometry.pixel_scale_arcsec,
        "CRPIX1": (nx + 1) / 2, "CRPIX2": (ny + 1) / 2,
        "CRVAL1": 0, "CRVAL2": 0, "CUNIT1": "arcsec", "CUNIT2": "arcsec",
        "INPXDIR": geometry.input_x_direction, "INPYDIR": geometry.input_y_direction,
    }
    if (array.shape != shape or not np.isin(array, (0, 1)).all() or array.all()
            or any(header.get(key) != value for key, value in expected.items())):
        raise ValueError("Preflight modeling mask does not match the frozen input domain")
    return array.astype(bool)


def _inputs(run: Path, lens_dir: Path) -> _Inputs:
    check_stage_input(lens_dir, run)
    run_manifest = validate_run_manifest(run)
    geometry = run_input_geometry(run)
    if lens_dir.name != run.name or run_manifest.get("lens_dir", str(lens_dir)) != str(lens_dir):
        raise ValueError("Stage B prescan requires the run's frozen input directory")
    if _object(run / "preflight/inspector.json").get("disposition") != "model":
        raise ValueError("Stage B prescan requires a model disposition")

    head = _object(run / "accepted/a.json")
    a_attempt = head.get("accepted_attempt")
    if type(a_attempt) is not int or a_attempt < 0:
        raise ValueError("Stage B prescan requires an accepted Stage A attempt")
    a_reference = f"attempts/a/{a_attempt}"
    if head != {
        "schema_version": "accepted_stage_head.v1", "stage": "a", "accepted_attempt": a_attempt,
        "attempt_path": f"../{a_reference}", "effective_config": f"../{a_reference}/effective-config.json",
    }:
        raise ValueError("Accepted Stage A head does not identify its exact attempt")
    a_root = run / a_reference
    result = _object(a_root / "stage-result.json")
    decision = _object(a_root / "decision.json")
    if (result.get("lens_id"), result.get("stage"), result.get("attempt"), result.get("status"),
        result.get("pipeline_release_id"), result.get("eligible_for_review"), result.get("gate_failures")) != (
        run.name, "a", a_attempt, "success", PIPELINE_RELEASE_ID, True, [],
    ) or (decision.get("schema_version"), decision.get("stage"), decision.get("attempt"),
          decision.get("decision")) != ("stage_decision.v1", "a", a_attempt, "accept"):
        raise ValueError("The Stage A head does not identify a successful accepted result")
    validate_decision_review_evidence(a_root, decision)
    if not {PKL_REFERENCE, FAMILY_REFERENCE} <= manifest_paths(a_root):
        raise ValueError("Accepted Stage A lens light and predicted positions are not sealed")
    config = EffectiveConfig.model_validate_json((a_root / "effective-config.json").read_bytes())
    validate_config_geometry(config, run)
    settings = config.settings
    defaults = run_manifest.get("stage_b_defaults", {"arc_snr_threshold": 2.0, "arc_ignor_size": 5})
    if not isinstance(defaults, dict) or defaults.get("arc_ignor_size") != settings.arc_ignor_size:
        raise ValueError("Stage A settings disagree with the run's frozen minimum arc island size")
    threshold_expansion = uses_stage_b_threshold_expansion(run_manifest)
    fixed_parameters = {"arc_ignor_size", "arc_close_size"}
    if not threshold_expansion:
        fixed_parameters.add("arc_ext_size")
    parameters = settings.model_dump(include=fixed_parameters)

    references = (
        "run-manifest.json", "accepted/a.json", "preflight/inspection.json", "preflight/inspector.json",
        MASK_REFERENCE, f"{a_reference}/stage-result.json", f"{a_reference}/decision.json",
        f"{a_reference}/effective-config.json", f"{a_reference}/{PKL_REFERENCE}",
        f"{a_reference}/{FAMILY_REFERENCE}",
    )
    source_hashes = {relative: file_sha256(run / relative) for relative in references}
    for relative, evidence_key in (
        ("stage-result.json", "stage-result.json"), ("effective-config.json", "effective-config.json"),
        (PKL_REFERENCE, f"artifact:{PKL_REFERENCE}"), (FAMILY_REFERENCE, f"artifact:{FAMILY_REFERENCE}"),
    ):
        if source_hashes[f"{a_reference}/{relative}"] != decision["evidence_sha256"][evidence_key]:
            raise ValueError("Stage A evidence changed while preparing the Stage B prescan")
    fits_path = lens_dir / f"{lens_dir.name}.fits"
    input_sha = file_sha256(fits_path)
    source_hashes.update(_frozen_input_hashes(
        run, a_root, source_hashes[f"{a_reference}/stage-result.json"],
        source_hashes["run-manifest.json"], fits_path, input_sha, source_hashes[MASK_REFERENCE],
        run_manifest.get("euclid_contamination"),
    ))

    data = load_lens_data(lens_dir, geometry=geometry)
    excluded = _read_modeling_mask(run, geometry, data.image.shape)
    fitted_pixels = result.get("metrics", {}).get("residual_diagnostics", {}).get("pixel_count")
    if fitted_pixels is not None and fitted_pixels != int((~excluded).sum()):
        raise ValueError("Modeling mask is inconsistent with the Stage A fitted pixel count")
    family = validate_predicted_image_family(_object(a_root / FAMILY_REFERENCE))
    coordinate = family["coordinate_system"]
    if (family["stage_attempt"], coordinate["image_shape"], coordinate["pixel_scale_arcsec"]) != (
        a_reference, list(data.image.shape), geometry.pixel_scale_arcsec,
    ):
        raise ValueError("Stage A predicted positions do not belong to the frozen image frame")
    with (a_root / PKL_REFERENCE).open("rb") as handle:
        payload = _StageArrays(handle).load()
    lens_light = np.asarray(payload["extra"]["lens_light_model"])
    if lens_light.shape != data.image.shape or not np.isfinite(lens_light).all():
        raise ValueError("Stage A lens light does not match the frozen image frame")
    snr = (data.image - lens_light) / data.noise
    if not np.isfinite(snr).all():
        raise ValueError("Stage B prescan residual S/N must be finite")
    if input_sha != file_sha256(fits_path) or any(
        expected != file_sha256(run / relative) for relative, expected in source_hashes.items()
    ):
        raise ValueError("Stage B prescan inputs changed while they were read")
    provenance = {
        "run_id": run_manifest.get("run_id"), "lens_id": run.name,
        "pipeline_release_id": PIPELINE_RELEASE_ID, "accepted_stage_a": a_reference,
        "input_fits_sha256": input_sha, "sha256": source_hashes,
    }
    return _Inputs(provenance, parameters, threshold_expansion, geometry, family, excluded, snr)


def _candidate(inputs: _Inputs, threshold: int) -> tuple[np.ndarray, dict[str, Any]]:
    construction = construct_arc_mask(inputs.snr, modeling_mask=inputs.excluded, threshold=threshold,
                                      ignor_size=inputs.parameters["arc_ignor_size"],
                                      ext_size=inputs.ext_size(threshold),
                                      close_size=inputs.parameters["arc_close_size"])
    arc = construction.arc_region
    labels, component_count = ndimage.label(arc, structure=np.ones((3, 3), dtype=int))
    areas = np.bincount(labels.ravel())
    ny, nx = arc.shape
    scale = inputs.geometry.pixel_scale_arcsec
    positions = []
    for item in inputs.family["images"]:
        x, y = item["position_arcsec"]
        row = _nearest_pixel_index(y / scale + (ny - 1) / 2)
        column = _nearest_pixel_index(x / scale + (nx - 1) / 2)
        component = int(labels[row, column])
        positions.append({
            **item, "nearest_pixel": [row, column], "covered": component > 0,
            "component_id": component or None,
        })
    covered = {item["component_id"] for item in positions if item["covered"]}
    return construction.feature_mask, {
        "included_arc_pixels": int(arc.sum()), "component_count": component_count,
        "component_pixel_counts": areas[1:].tolist(),
        "components_without_predicted_positions": component_count - len(covered),
        "surviving_threshold_island_count": len(construction.surviving_threshold_island_ids),
        "excluded_above_threshold_pixel_count": construction.excluded_above_threshold_pixel_count,
        "covered_predicted_image_count": sum(item["covered"] for item in positions),
        "predicted_image_count": len(positions), "predicted_images": positions,
    }


def _plot(path: Path, inputs: _Inputs, entries: list[dict[str, Any]], limits: list[float]) -> None:
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.colors import Normalize
    from matplotlib.figure import Figure

    figure = Figure(figsize=(16.5, 13.6), layout="constrained")
    FigureCanvasAgg(figure)
    axes = figure.subplots(4, 5, sharex=True, sharey=True)
    pixel = inputs.geometry.pixel_scale_arcsec
    ny, nx = inputs.snr.shape
    extent = (-nx * pixel / 2, nx * pixel / 2, -ny * pixel / 2, ny * pixel / 2)
    norm = Normalize(*limits)
    shown = np.ma.array(inputs.snr, mask=inputs.excluded)
    for axis, entry in zip(axes.flat, entries, strict=True):
        axis.set_facecolor("#32323c")
        image = axis.imshow(shown, origin="lower", extent=extent, cmap="inferno", norm=norm,
                            interpolation="nearest")
        arc = fits.getdata(path.parent / entry["mask"]) == 0
        if arc.any() and not arc.all():
            axis.contour(arc, levels=[0.5], origin="lower", extent=extent,
                         colors="#57e4ff", linewidths=0.85)
        metrics = entry["metrics"]
        for item in metrics["predicted_images"]:
            x, y = item["position_arcsec"]
            axis.scatter([x], [y], marker="x", color="#8bff83" if item["covered"] else "#ff647b",
                         s=26, linewidths=1.3)
        coverage = f"{metrics['covered_predicted_image_count']}/{metrics['predicted_image_count']} positions"
        expansion = f" · +{(entry['arc_ext_size'] - 1) // 2} px" if inputs.threshold_expansion else ""
        axis.set_title(f"S/N > {entry['threshold']}{expansion} · {coverage}\n"
                       f"{metrics['included_arc_pixels']} px · {metrics['component_count']} components",
                       fontsize=12)
        axis.label_outer()
    figure.supxlabel("x (arcsec)")
    figure.supylabel("y (arcsec)")
    figure.suptitle("Stage B candidate masks\nCyan: arc boundary · ×: Stage A position (green: covered)")
    figure.colorbar(image, ax=axes, label="Lens-light-subtracted residual S/N", shrink=0.85)
    figure.savefig(path, dpi=130, metadata={"Software": "TinyLens Stage B prescan"})


def _directory(run: Path, attempt: int) -> Path:
    if type(attempt) is not int or attempt < 0:
        raise ValueError("Stage B prescan attempt must be a non-negative integer")
    return run / "stage-b-candidates" / str(attempt)


def _read_package(directory: Path, inputs: _Inputs, attempt: int) -> dict[str, Any]:
    packet = _object(directory / "manifest.json")
    if (packet.get("schema_version"), packet.get("stage"), packet.get("attempt"),
        packet.get("provenance"), packet.get("parameters")) != (
        SCHEMA, "b", attempt, inputs.provenance, inputs.parameters,
    ):
        raise ValueError("Stage B prescan does not match the accepted Stage A or frozen run input")
    entries = packet.get("candidates")
    allowed_thresholds = (THRESHOLDS,) if inputs.threshold_expansion else (THRESHOLDS, _LEGACY_THRESHOLDS)
    if (
        not isinstance(entries, list)
        or any(not isinstance(entry, dict) or type(entry.get("threshold")) is not int for entry in entries)
        or tuple(entry["threshold"] for entry in entries) not in allowed_thresholds
    ):
        raise ValueError("Stage B prescan has an invalid threshold list")
    if packet.get("comparison") != "comparison.png" or (
        packet.get("comparison_sha256") != file_sha256(directory / "comparison.png")
    ):
        raise ValueError("Stage B prescan comparison checksum mismatch")
    for entry in entries:
        name = f"threshold-{entry['threshold']}.fits"
        if entry.get("mask") != name or entry.get("mask_sha256") != file_sha256(directory / name):
            raise ValueError("Stage B prescan mask checksum mismatch")
        if inputs.threshold_expansion:
            ext_size = entry.get("arc_ext_size")
            if type(ext_size) is not int or ext_size != inputs.ext_size(entry["threshold"]):
                raise ValueError("Stage B prescan has an invalid expansion size")
    return packet


def generate_stage_b_candidates(lens_dir: Path, output_dir: Path, attempt: int = 0) -> Path:
    """Publish the current integer thresholds or reuse the frozen comparison manifest."""
    run = validated_run_root(output_dir)
    lens_dir = lens_dir.resolve()
    directory = _directory(run, attempt)
    inputs = _inputs(run, lens_dir)
    if directory.exists():
        _read_package(directory, inputs, attempt)
        return directory / "manifest.json"
    directory.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{attempt}-", dir=directory.parent) as scratch:
        temporary = Path(scratch)
        entries = []
        ny, nx = inputs.snr.shape
        geometry = inputs.geometry
        header = fits.Header({
            "CTYPE1": "LINEAR", "CTYPE2": "LINEAR", "CUNIT1": "arcsec", "CUNIT2": "arcsec",
            "CDELT1": geometry.pixel_scale_arcsec, "CDELT2": geometry.pixel_scale_arcsec,
            "CRPIX1": (nx + 1) / 2, "CRPIX2": (ny + 1) / 2, "CRVAL1": 0.0, "CRVAL2": 0.0,
            "GEOMFRM": "canonical", "INPXDIR": geometry.input_x_direction, "INPYDIR": geometry.input_y_direction,
        })
        for threshold in THRESHOLDS:
            mask, metrics = _candidate(inputs, threshold)
            path = temporary / f"threshold-{threshold}.fits"
            fits.writeto(path, mask.astype(np.uint8), header=header)
            entry = {"threshold": threshold, "mask": path.name, "mask_sha256": file_sha256(path), "metrics": metrics}
            if inputs.threshold_expansion:
                entry["arc_ext_size"] = inputs.ext_size(threshold)
            entries.append(entry)
        low, high = np.percentile(inputs.snr[~inputs.excluded], [1, 99])
        limits = [min(-3.0, float(low)), max(float(ARC_SNR_THRESHOLD_MAX), float(high))]
        comparison = temporary / "comparison.png"
        _plot(comparison, inputs, entries, limits)
        packet = {
            "schema_version": SCHEMA, "stage": "b", "attempt": attempt, "provenance": inputs.provenance,
            "parameters": inputs.parameters, "mask_convention": "1 excludes pixels, 0 includes arc pixels",
            "valid_pixel_count": int((~inputs.excluded).sum()), "comparison_snr_limits": limits,
            "comparison": comparison.name, "comparison_sha256": file_sha256(comparison),
            "candidates": entries,
        }
        (temporary / "manifest.json").write_text(json.dumps(packet, indent=2, allow_nan=False) + "\n",
                                                 encoding="utf-8")
        if _inputs(run, lens_dir).provenance != inputs.provenance:
            raise ValueError("Stage B prescan inputs changed before publication")
        try:
            os.rename(temporary, directory)
        except OSError:
            if not directory.is_dir():
                raise
            _read_package(directory, inputs, attempt)
    return directory / "manifest.json"


def validate_stage_b_candidate(output_dir: Path, attempt: int, threshold: float) -> dict[str, Any]:
    """Check that a selected mask still agrees with the prescan and the frozen inputs."""
    if type(threshold) not in (int, float) or threshold not in THRESHOLDS:
        raise ValueError(
            f"Stage B prescan selection requires an integer threshold from {ARC_SNR_THRESHOLD_MIN} to {ARC_SNR_THRESHOLD_MAX}"
        )
    run = validated_run_root(output_dir)
    directory = _directory(run, attempt)
    lens_dir = Path(_object(run / "preflight/inspection.json")["lens_dir"]).resolve()
    inputs = _inputs(run, lens_dir)
    packet = _read_package(directory, inputs, attempt)
    entry = next((item for item in packet["candidates"] if item["threshold"] == threshold), None)
    if entry is None:
        raise ValueError(f"S/N threshold {int(threshold)} is absent from the frozen Stage B prescan")
    path = directory / entry["mask"]
    expected_mask, expected_metrics = _candidate(inputs, int(threshold))
    if not np.array_equal(fits.getdata(path), expected_mask) or entry["metrics"] != expected_metrics:
        raise ValueError("Selected Stage B prescan mask differs from the frozen Stage A inputs")
    manifest = directory / "manifest.json"
    return {"threshold": int(threshold), "mask_path": path, "mask_sha256": entry["mask_sha256"],
            "manifest_path": manifest, "manifest_sha256": file_sha256(manifest),
            "comparison_path": directory / "comparison.png", "comparison_sha256": packet["comparison_sha256"],
            "metrics": expected_metrics, **inputs.parameters, "arc_ext_size": inputs.ext_size(int(threshold))}
