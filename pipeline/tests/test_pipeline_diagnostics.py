from __future__ import annotations

import importlib.util
import json
import pickle
import sys
from contextlib import nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest
from astropy.io import fits

from lens_agent import stages
from lens_agent.configuration import EffectiveConfig, PIPELINE_RELEASE_ID, PriorConfig
from lens_agent.modeling.source_grid import source_grid_spec
from lens_agent.modeling.predicted_image_family import build_predicted_image_family
from lens_agent.models import StageName

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PIPELINE_TEMPLATE = REPOSITORY_ROOT / "src" / "lens_agent" / "modeling" / "pipeline_template.py"


class _Placeholder:
    def __init__(self, *args, **kwargs) -> None:
        pass


class _StagePosterior:
    @classmethod
    def from_schema(cls, *args, **kwargs):
        return cls()


def _install_module(monkeypatch, name: str, **attributes) -> ModuleType:
    module = ModuleType(name)
    module.__dict__.update(attributes)
    monkeypatch.setitem(sys.modules, name, module)
    return module


def _load_pipeline_template(
    monkeypatch, *, arc_mask_from=None, overlay_critical_and_caustics=None,
) -> ModuleType:
    """Load the stage renderer with only the modeling dependencies it imports."""
    _install_module(monkeypatch, "jax")
    monkeypatch.setitem(sys.modules, "jax.numpy", np)
    _install_module(monkeypatch, "nautilus", Sampler=_Placeholder)
    _install_module(monkeypatch, "caskade", ActiveContext=lambda _: nullcontext())

    _install_module(monkeypatch, "TinyLensGpu")
    _install_module(monkeypatch, "TinyLensGpu.Inference", ParamU=_Placeholder, StagePosterior=_StagePosterior)
    _install_module(monkeypatch, "TinyLensGpu.Inference.build_likelihood", make_likelihood=_Placeholder)
    _install_module(monkeypatch, "TinyLensGpu.Inference.build_prior", make_prior_transformation=_Placeholder)
    _install_module(monkeypatch, "TinyLensGpu.ObservationModel", PointSourceProbModel=_Placeholder)
    _install_module(monkeypatch, "TinyLensGpu.ObservationModel.LensImage")
    _install_module(
        monkeypatch,
        "TinyLensGpu.ObservationModel.LensImage.parametric_image_model",
        ImageProbModel=_Placeholder,
    )
    _install_module(
        monkeypatch,
        "TinyLensGpu.ObservationModel.LensImage.pixelized_image_model_operator",
        PixelizedImageProbModelOperator=_Placeholder,
    )
    _install_module(
        monkeypatch,
        "TinyLensGpu.PhysicalModel",
        PhysicalModel=_Placeholder,
        PixelizedSourceModel=_Placeholder,
        Shear=_Placeholder,
    )
    _install_module(monkeypatch, "TinyLensGpu.PhysicalModel.LensImage")
    _install_module(monkeypatch, "TinyLensGpu.PhysicalModel.LensImage.Parametric")
    _install_module(monkeypatch, "TinyLensGpu.PhysicalModel.LensImage.Parametric.Light", GaussianEllipse=_Placeholder)
    _install_module(monkeypatch, "TinyLensGpu.PhysicalModel.LensImage.Parametric.Mass", EPL=_Placeholder, SIE=_Placeholder)
    _install_module(
        monkeypatch,
        "TinyLensGpu.utils",
        generate_radial_basis_knots=_Placeholder,
    )
    _install_module(monkeypatch, "TinyLensGpu.utils.geometry")
    _install_module(
        monkeypatch,
        "TinyLensGpu.utils.geometry.transforms",
        ellipticity2phi_q=lambda _e1, _e2: (0.0, 1.0),
    )
    sys.modules["TinyLensGpu.utils.geometry"].ellipticity2phi_q = (
        lambda _e1, _e2: (0.0, 1.0)
    )
    _install_module(
        monkeypatch,
        "TinyLensGpu.utils.misc",
        arc_mask_from=arc_mask_from or (lambda snr, threshold, **_: np.asarray(snr) <= threshold),
    )
    _install_module(
        monkeypatch,
        "TinyLensGpu.visualizer",
        overlay_critical_and_caustics=overlay_critical_and_caustics or (lambda **_: None),
        plot_model_results=lambda *_, **__: None,
    )

    module_name = "lens_agent.modeling.pipeline_template_for_diagnostics_test"
    spec = importlib.util.spec_from_file_location(module_name, PIPELINE_TEMPLATE)
    assert spec is not None and spec.loader is not None
    pipeline = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, module_name, pipeline)
    spec.loader.exec_module(pipeline)
    return pipeline


def _predicted_family(
    image_shape: tuple[int, int], positions: list[list[float]],
) -> dict[str, object]:
    return build_predicted_image_family(
        positions,
        medians={
            "theta_E": 1.6,
            "e1_mass": -0.1,
            "e2_mass": 0.06,
            "center_x_mass": 0.05,
            "center_y_mass": 0.06,
            "gamma1": -0.05,
            "gamma2": -0.06,
            "center_x_src": 0.12,
            "center_y_src": 0.18,
        },
        image_shape=image_shape,
        pixel_scale_arcsec=0.1,
        stage_attempt="attempts/a/0",
        solver="optimization",
        solver_config={
            "initial_range": 4.0, "n_x": 400, "n_y": 400, "k_keep": 30,
            "num_iters": 20, "tolerance": 5.0e-4, "cluster_tol": 0.08,
        },
        threshold_arcsec=0.1,
        min_log_like=-1.0e10,
    )


def test_pipeline_prior_adapter_preserves_mixture_settings(monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    prior = PriorConfig(
        prior_type="truncated_gaussian_uniform_mixture",
        prior_settings=[1.35, 0.405, 0.8],
        limits=[0.5, 3.0],
    )

    assert pipeline._prior(prior) == {
        "prior_type": "truncated_gaussian_uniform_mixture",
        "prior_settings": [1.35, 0.405, 0.8],
        "limits": [0.5, 3.0],
    }


def test_stage_a_theta_e_parameter_uses_attempt_local_initial_and_prior(monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    captured: dict[str, object] = {}

    def capture_param(name, initial, **kwargs):
        captured.update(name=name, initial=initial, **kwargs)
        return object()

    monkeypatch.setattr(pipeline, "ParamU", capture_param)
    config = EffectiveConfig().settings.model_copy(
        update={
            "stage_a_theta_E_initial": 1.35,
            "stage_a_theta_E_prior": PriorConfig(
                prior_type="truncated_gaussian_uniform_mixture",
                prior_settings=[1.35, 0.405, 0.8],
                limits=[0.5, 3.0],
            ),
        }
    )

    pipeline._stage_a_theta_E_parameter(config)

    assert captured == {
        "name": "theta_E",
        "initial": 1.35,
        "prior_type": "truncated_gaussian_uniform_mixture",
        "prior_settings": [1.35, 0.405, 0.8],
        "limits": [0.5, 3.0],
    }


def test_stage_a_source_grid_anchor_contains_only_the_posterior_center(monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    medians = {
        "center_x_src": 0.1,
        "center_y_src": -0.2,
        "e1_src": 0.0,
        "e2_src": 0.0,
    }

    assert pipeline._stage_a_source_grid_anchor(medians) == {
        "center_x": 0.1,
        "center_y": -0.2,
    }


def test_stage_a_writes_the_predicted_image_family_from_its_median_model(
    tmp_path: Path, monkeypatch,
) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    pipeline.OUT_DIR = tmp_path
    pipeline._STAGE_ATTEMPT_REFERENCE = "attempts/a/2"
    medians = {
        "theta_E": 1.6,
        "e1_mass": -0.1,
        "e2_mass": 0.06,
        "center_x_mass": 0.05,
        "center_y_mass": 0.06,
        "gamma1": -0.05,
        "gamma2": -0.06,
        "center_x_src": 0.12,
        "center_y_src": 0.18,
    }
    monkeypatch.setattr(
        pipeline,
        "_solve_stage_a_image_positions",
        lambda _medians: np.asarray([[1.2, 1.1], [-0.7, -1.0]]),
    )

    family = pipeline._write_stage_a_predicted_image_family(medians, (300, 300))

    assert family["stage_attempt"] == "attempts/a/2"
    assert family["images"] == [
        {"image_id": "image_1", "position_arcsec": [-0.7, -1.0]},
        {"image_id": "image_2", "position_arcsec": [1.2, 1.1]},
    ]
    assert json.loads(
        (tmp_path / "stage_a_predicted_image_family.json").read_text(encoding="utf-8")
    ) == family


def test_mass_schedule_uses_sie_until_m3(monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)

    class Parameter:
        def __init__(self, name, value=None, **_kwargs):
            self.name = name
            self.value = value

        def to_static(self, *_args):
            return None

        def to_dynamic(self):
            return None

    class Profile:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class Posterior:
        def __init__(self):
            self.gaussian_names = []
            self.fixed_names = []

        def gaussian(self, name, **_kwargs):
            self.gaussian_names.append(name)
            return Parameter(name)

        def fixed(self, name):
            self.fixed_names.append(name)
            return Parameter(name)

    monkeypatch.setattr(pipeline, "ParamU", Parameter)
    monkeypatch.setattr(pipeline, "SIE", Profile)
    monkeypatch.setattr(pipeline, "EPL", Profile)
    monkeypatch.setattr(pipeline, "Shear", Profile)

    stage_a = Posterior()
    m1_mass, _ = pipeline._free_sie(stage_a)
    assert not hasattr(m1_mass, "gamma")
    assert stage_a.gaussian_names == ["theta_E", "e1_mass", "e2_mass", "gamma1", "gamma2"]
    assert stage_a.fixed_names == ["center_x_mass", "center_y_mass"]

    m2_mass, _ = pipeline._fixed_sie_from_medians(
        {
            "theta_E": 1.2,
            "e1_mass": 0.1,
            "e2_mass": -0.1,
            "center_x_mass": 0.02,
            "center_y_mass": -0.03,
            "gamma1": 0.01,
            "gamma2": -0.02,
        }
    )
    assert not hasattr(m2_mass, "gamma")

    stage_m1 = Posterior()
    stage_a = Posterior()
    m3_mass, _ = pipeline._free_epl(stage_m1, stage_a)
    assert hasattr(m3_mass, "gamma")
    assert stage_m1.gaussian_names == ["theta_E", "e1_mass", "e2_mass", "gamma1", "gamma2"]
    assert stage_a.fixed_names == ["center_x_mass", "center_y_mass"]


def test_source_template_must_match_m0_sealed_grid(monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    grid = source_grid_spec(center_x=0.0, center_y=0.0, level=0)
    package = {
        "source_pixels": np.ones(80 * 80),
        "source_bbox": tuple(grid["pixel_center_bbox"]),
        "source_x_axis": np.linspace(-0.79, 0.79, 80),
        "source_y_axis": np.linspace(-0.79, 0.79, 80),
        "n": 80,
        "lambda_best": 1.0,
        "log_lambda_best": 0.0,
    }

    assert pipeline._validate_source_template_package(package, grid) is package
    different_grid = source_grid_spec(center_x=0.0, center_y=0.0, level=1)
    with pytest.raises(ValueError, match="M0-Sealed Source Grid"):
        pipeline._validate_source_template_package(package, different_grid)


def test_stage_b_writes_six_panel_coverage_audit(tmp_path: Path, monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    pipeline.OUT_DIR = tmp_path
    pipeline.DIAGNOSTICS_DIR = tmp_path
    pipeline._STAGE_ATTEMPT_REFERENCE = "attempts/b/0"
    figures = []
    monkeypatch.setattr(pipeline.plt, "close", figures.append)

    image = np.zeros((32, 32), dtype=float)
    image[15:18, 9:12] = 4.0
    image[15:18, 20:23] = 4.0
    pipeline.run_stage_b(
        image,
        np.ones_like(image),
        np.zeros_like(image),
        _predicted_family(image.shape, [[-0.55, 0.05], [0.55, 0.05]]),
        modeling_mask=np.zeros_like(image, dtype=bool),
    )

    assert (tmp_path / "feature_mask.fits").is_file()
    assert (tmp_path / "stage_b_mask.png").is_file()
    assert (tmp_path / "stage_b_component_labels.fits").is_file()
    assert (tmp_path / "stage_b_components.json").is_file()
    assert (tmp_path / "stage_b_components.png").is_file()
    assert (tmp_path / "stage_b_morphology_audit.json").is_file()
    assert (tmp_path / "stage_b_morphology_audit.png").is_file()
    assert not (tmp_path / "arc_mask_selection.json").exists()

    figure = figures[-1]
    assert not figure.axes[4].texts
    assert figure.axes[5].get_legend() is not None
    morphology = figures[-2]
    assert morphology.axes[0].get_xlim() == (-4.0, 4.0)
    assert morphology.axes[0].get_ylim() == (-4.0, 4.0)
    assert [axis.get_title() for axis in figure.axes if axis.get_title()] == [
        "residual = image - stage-A lens light",
        "S/N map + arc mask boundary",
        "S/N > 2.0 pixels",
        "arc mask region",
        "coverage diagnostic",
    ]


def test_stage_b_excludes_preflight_contaminants_before_arc_construction(
    tmp_path: Path, monkeypatch
) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    pipeline.OUT_DIR = tmp_path
    pipeline.DIAGNOSTICS_DIR = tmp_path
    pipeline._STAGE_ATTEMPT_REFERENCE = "attempts/b/0"
    figures = []
    monkeypatch.setattr(pipeline.plt, "close", figures.append)
    image = np.zeros((32, 32), dtype=float)
    image[8:11, 8:11] = 4.0
    image[8:11, 18:21] = 4.0
    image[24:27, 14:17] = 5.0
    modeling_mask = np.zeros_like(image, dtype=bool)
    modeling_mask[24:27, 14:17] = True

    feature_mask = pipeline.run_stage_b(
        image,
        np.ones_like(image),
        np.zeros_like(image),
        _predicted_family(image.shape, [[-0.75, -0.75], [0.25, -0.75]]),
        modeling_mask=modeling_mask,
    )

    assert feature_mask[22:29, 12:19].all()
    catalog = json.loads((tmp_path / "stage_b_components.json").read_text())
    assert catalog["schema_version"] == "stage_b_arc_components.v2"
    assert catalog["excluded_above_threshold_pixel_count"] == 9
    assert catalog["all_components_have_arc_seed"] is True
    assert [
        (item["arc_seed_ids"], item["arc_seed_pixel_count"], item["has_arc_seed"])
        for item in catalog["components"]
    ] == [([1], 9, True), ([2], 9, True)]
    audit_text = "\n".join(
        item.get_text() for axis in figures[-1].axes for item in axis.texts
    )
    legend = figures[-1].axes[5].get_legend()
    assert "valid modeling domain boundary" in [text.get_text() for text in legend.texts]
    assert not figures[-1].axes[4].texts
    assert len(figures[-1].axes[4].collections) == 2
    assert "excluded S/N>2.0 pixels: 9" in audit_text


def test_stage_b_component_records_every_merged_arc_seed(
    tmp_path: Path, monkeypatch
) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    pipeline.OUT_DIR = tmp_path
    pipeline.DIAGNOSTICS_DIR = tmp_path
    pipeline._STAGE_ATTEMPT_REFERENCE = "attempts/b/0"
    image = np.zeros((32, 32), dtype=float)
    image[8:11, 5:8] = 4.0
    image[8:11, 11:14] = 4.0

    pipeline.run_stage_b(
        image,
        np.ones_like(image),
        np.zeros_like(image),
        _predicted_family(image.shape, [[-0.95, -0.75], [-0.35, -0.75]]),
        modeling_mask=np.zeros_like(image, dtype=bool),
    )

    catalog = json.loads((tmp_path / "stage_b_components.json").read_text())
    assert catalog["candidate_component_count"] == 1
    assert catalog["components"][0]["arc_seed_ids"] == [1, 2]
    assert catalog["components"][0]["arc_seed_pixel_count"] == 18


def test_stage_b_component_lineage_excludes_filtered_threshold_islands(
    tmp_path: Path, monkeypatch
) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    pipeline.OUT_DIR = tmp_path
    pipeline.DIAGNOSTICS_DIR = tmp_path
    pipeline._STAGE_ATTEMPT_REFERENCE = "attempts/b/0"
    image = np.zeros((32, 32), dtype=float)
    image[8:11, 5:8] = 4.0
    image[9, 9] = 4.0

    pipeline.run_stage_b(
        image,
        np.ones_like(image),
        np.zeros_like(image),
        _predicted_family(image.shape, [[-0.95, -0.75], [-0.75, -0.55]]),
        modeling_mask=np.zeros_like(image, dtype=bool),
    )

    catalog = json.loads((tmp_path / "stage_b_components.json").read_text())
    assert catalog["components"][0]["arc_seed_ids"] == [1]
    assert catalog["components"][0]["arc_seed_pixel_count"] == 9


def test_stage_b_dropped_components_are_persisted_and_removed(tmp_path: Path, monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    pipeline.OUT_DIR = tmp_path
    pipeline.DIAGNOSTICS_DIR = tmp_path
    pipeline._STAGE_ATTEMPT_REFERENCE = "attempts/b/0"
    image = np.zeros((32, 32), dtype=float)
    image[4:7, 4:7] = 4.0
    image[22:25, 22:25] = 4.0
    pipeline._ARC_DROP_COMPONENT_IDS = (2,)

    feature_mask = pipeline.run_stage_b(
        image,
        np.ones_like(image),
        np.zeros_like(image),
        _predicted_family(image.shape, [[-1.05, -1.05], [0.75, 0.75]]),
        modeling_mask=np.zeros_like(image, dtype=bool),
    )

    labels = fits.getdata(tmp_path / "stage_b_component_labels.fits")
    assert set(np.unique(labels)) == {0, 1, 2}
    assert not feature_mask[5, 5]
    assert feature_mask[23, 23]
    assert labels[5, 5] == 1
    assert labels[23, 23] == 2

    catalog = json.loads((tmp_path / "stage_b_components.json").read_text(encoding="utf-8"))
    assert catalog["selection"] == {
        "effective_keep_component_ids": [1],
        "drop_component_ids": [2],
    }
    assert [(item["id"], item["status"]) for item in catalog["components"]] == [
        (1, "kept"), (2, "dropped"),
    ]
    assert not (tmp_path / "arc_mask_selection.json").exists()


def test_stage_b_rejects_an_unknown_dropped_component(tmp_path: Path, monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    pipeline.OUT_DIR = tmp_path
    pipeline.DIAGNOSTICS_DIR = tmp_path
    image = np.zeros((32, 32), dtype=float)
    image[4:7, 4:7] = 4.0
    image[22:25, 22:25] = 4.0
    pipeline._ARC_DROP_COMPONENT_IDS = (3,)

    with pytest.raises(ValueError, match="references absent IDs"):
        pipeline.run_stage_b(
            image,
            np.ones_like(image),
            np.zeros_like(image),
            _predicted_family(image.shape, [[-1.05, -1.05], [0.75, 0.75]]),
            modeling_mask=np.zeros_like(image, dtype=bool),
        )


def test_pixelized_stage_writes_five_panel_centered_diagnostic(tmp_path: Path, monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    figures = []
    monkeypatch.setattr(pipeline.plt, "close", figures.append)

    image = np.zeros((32, 32), dtype=float)
    unmask = np.zeros_like(image, dtype=bool)
    unmask[13:19, 9:23] = True
    image[unmask] = np.linspace(0.1, 2.0, unmask.sum())
    likelihood = SimpleNamespace(
        fill_params=lambda _: None,
        image_data=image,
        noise_map=np.ones_like(image),
        unmask=unmask,
        phys_model=SimpleNamespace(),
    )
    grid = source_grid_spec(center_x=0.0, center_y=0.0, level=0)
    solved = {
        "model_1d": image[unmask] * 0.9,
        "source_image": np.arange(80 * 80, dtype=float).reshape(80, 80),
        "source_bbox": tuple(grid["pixel_center_bbox"]),
        "reg_scale_image": np.linspace(1.0, 3.0, 80 * 80).reshape(80, 80),
        "adaptive_reg_rho": 2.5,
        "adaptive_regularization": True,
    }

    pipeline._plot_pixel_stage(
        "Stage M2", likelihood, solved, tmp_path / "stage_m2_model.png", grid,
        medians={}, names=[],
    )

    assert (tmp_path / "stage_m2_model.png").is_file()
    figure = figures[-1]
    panels = [axis for axis in figure.axes if axis.get_title()]
    assert [axis.get_title() for axis in panels] == [
        "lens-subtracted data",
        "pixelized model",
        "normalized residual",
        "source reconstruction",
        "regularization scale (adaptive, rho=2.50)",
    ]
    assert [axis.images[0].get_cmap().name for axis in panels] == [
        "inferno", "inferno", "RdBu_r", "inferno", "inferno",
    ]
    for axis in panels[:3]:
        assert axis.get_xlim()[0] == -axis.get_xlim()[1]
        assert axis.get_ylim()[0] == -axis.get_ylim()[1]
    for axis in panels[3:]:
        assert axis.get_xlim() == pytest.approx(grid["footprint_bbox"][:2])
        assert axis.get_ylim() == pytest.approx(grid["footprint_bbox"][2:])


def test_source_panel_stays_at_bbox_when_caustic_extends_outside(
    tmp_path: Path, monkeypatch,
) -> None:
    def overlay(*, source_ax, **_kwargs):
        source_ax.plot([-2.0, 2.0], [-3.0, 3.0])

    pipeline = _load_pipeline_template(
        monkeypatch, overlay_critical_and_caustics=overlay
    )
    figures = []
    monkeypatch.setattr(pipeline.plt, "close", figures.append)
    image = np.ones((8, 8), dtype=float)
    grid = source_grid_spec(center_x=0.0, center_y=-0.1, level=0)
    solved = {
        "model_1d": image.ravel(),
        "source_image": np.ones((80, 80), dtype=float),
        "source_bbox": tuple(grid["pixel_center_bbox"]),
    }
    likelihood = SimpleNamespace(
        fill_params=lambda _: None,
        image_data=image,
        noise_map=np.ones_like(image),
        unmask=np.ones_like(image, dtype=bool),
        phys_model=SimpleNamespace(),
    )

    pipeline._plot_pixel_stage(
        "Stage M1", likelihood, solved, tmp_path / "m1.png", grid, medians={}, names=[]
    )

    source_axis = [axis for axis in figures[-1].axes if axis.get_title()][3]
    assert source_axis.get_xlim() == pytest.approx((-0.8, 0.8))
    assert source_axis.get_ylim() == pytest.approx((-0.9, 0.7))


def test_pixelized_uniform_stage_labels_the_unit_regularization_scale(tmp_path: Path, monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    figures = []
    monkeypatch.setattr(pipeline.plt, "close", figures.append)
    image = np.ones((16, 16), dtype=float)
    likelihood = SimpleNamespace(
        fill_params=lambda _: None,
        image_data=image,
        noise_map=np.ones_like(image),
        unmask=np.ones_like(image, dtype=bool),
        phys_model=SimpleNamespace(),
    )
    grid = source_grid_spec(center_x=0.0, center_y=0.0, level=0)
    solved = {
        "model_1d": image.ravel(),
        "source_image": np.ones((80, 80), dtype=float),
        "source_bbox": tuple(grid["pixel_center_bbox"]),
    }

    pipeline._plot_pixel_stage(
        "Stage M0", likelihood, solved, tmp_path / "stage_m0_model.png", grid,
        medians={}, names=[],
    )

    panels = [axis for axis in figures[-1].axes if axis.get_title()]
    assert panels[-1].get_title() == "regularization scale (uniform, scale=1)"


def test_m0_source_grid_review_plot_marks_outer_two_pixel_ring(
    tmp_path: Path, monkeypatch
) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    figures = []
    monkeypatch.setattr(pipeline.plt, "close", figures.append)
    grid = source_grid_spec(center_x=0.1, center_y=-0.2, level=0)
    source = np.zeros((80, 80), dtype=float)
    source[35:45, 35:45] = 1.0
    solved = {
        "source_image": source,
        "source_bbox": tuple(grid["pixel_center_bbox"]),
    }

    target = tmp_path / "stage_m0_source_grid.png"
    pipeline._plot_source_grid_review(solved, grid, target)

    assert target.is_file()
    panels = [axis for axis in figures[-1].axes if axis.get_title()]
    assert [axis.get_title() for axis in panels] == [
        "signed source (linear)", "positive source (asinh)",
    ]
    assert all(len(axis.patches) == 1 for axis in panels)
    text = "\n".join(item.get_text() for item in figures[-1].axes[2].texts)
    assert "inner edge of outer two-pixel ring" in text
    assert "positive flux in outer 2 px: 0.0" in text


def test_source_sign_diagnostics_are_descriptive_not_categorical(monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    source = np.asarray(
        [
            [-2.0, 0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0, 0.0],
            [0.0, 0.0, 4.0, 0.0],
            [0.0, 0.0, 0.0, np.nan],
        ]
    )

    diagnostics = pipeline._source_sign_diagnostics(source, (-0.3, 0.3, -0.3, 0.3))

    assert diagnostics["non_finite_pixel_count"] == 1
    assert diagnostics["negative_pixel_fraction"] == pytest.approx(2 / 15)
    assert diagnostics["negative_to_positive_integrated_flux_ratio"] == pytest.approx(3 / 5)
    assert diagnostics["negative_to_positive_peak_amplitude_ratio"] == pytest.approx(0.5)
    assert diagnostics["positive_flux_fraction_at_bbox_edge"] == pytest.approx(1 / 5)
    assert diagnostics["negative_flux_fraction_at_bbox_edge"] == pytest.approx(2 / 3)
    assert diagnostics["positive_flux_fraction_in_outer_two_pixel_ring"] == pytest.approx(1.0)
    assert diagnostics["negative_flux_fraction_in_outer_two_pixel_ring"] == pytest.approx(1.0)
    assert diagnostics["positive_flux_fraction_by_bbox_edge"] == pytest.approx(
        {"bottom": 1 / 5, "top": 0.0, "left": 0.0, "right": 0.0}
    )
    assert diagnostics["source_bbox"] == pytest.approx((-0.3, 0.3, -0.3, 0.3))
    assert diagnostics["source_grid_pixel_scale"] == pytest.approx({"x": 0.2, "y": 0.2})
    assert "classification" not in diagnostics


def test_residual_diagnostics_split_arc_regions_and_connected_signs(monkeypatch) -> None:
    pipeline = _load_pipeline_template(monkeypatch)
    residual = np.zeros((5, 5), dtype=float)
    residual[1, 1:3] = 4.0
    residual[3, 3] = -6.0
    arc_region = np.zeros_like(residual, dtype=bool)
    arc_region[:3, :] = True
    modeled_support = np.zeros_like(residual, dtype=bool)
    modeled_support[1, 1] = True

    diagnostics = pipeline._residual_diagnostics(
        residual,
        valid_mask=np.ones_like(residual, dtype=bool),
        arc_region=arc_region,
        modeled_support=modeled_support,
    )

    all_pixels = diagnostics["all_valid_pixels"]
    assert all_pixels["abs_gt_3sigma_fraction"] == pytest.approx(3 / 25)
    assert all_pixels["abs_gt_5sigma_fraction"] == pytest.approx(1 / 25)
    assert all_pixels["positive_connected_region_count"] == 1
    assert all_pixels["positive_connected_region_max_area_pixels"] == 2
    assert all_pixels["negative_connected_region_count"] == 1
    assert all_pixels["negative_connected_region_max_area_pixels"] == 1
    assert diagnostics["inside_arc_region"]["pixel_count"] == 15
    assert diagnostics["outside_arc_region"]["pixel_count"] == 10
    assert diagnostics["significant_residual_modeled_support_overlap_fraction"] == pytest.approx(
        1 / 3
    )
    assert diagnostics["significance_reference_sigma"] == 3.0


def test_stage_local_prior_settings_do_not_modify_an_upstream_stage() -> None:
    source = PIPELINE_TEMPLATE.read_text(encoding="utf-8")

    assert "cfg.stage_a_lens_light_center_prior" in source
    assert "cfg.stage_a_lens_light_e_prior" in source
    assert "def _free_sie" in source
    assert "def _fixed_sie_from_medians" in source
    assert "def _free_epl" in source
    assert "stage_m1_gamma_prior" not in source
    assert "stage_m3_gamma_prior" in source
    assert "source_bbox_padding" not in source
    assert "fixed_source_bbox" in source


def test_stage_b_metrics_treat_diagonal_misses_as_one_component(tmp_path: Path, monkeypatch) -> None:
    image = np.zeros((32, 32), dtype=float)
    diagonal_components = np.array(
        [(10, 10), (10, 11), (11, 10), (12, 11), (12, 12), (13, 12)]
    )
    image[diagonal_components[:, 0], diagonal_components[:, 1]] = 4.0
    pipeline_module = _load_pipeline_template(monkeypatch)
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    fits.writeto(artifact_dir / "feature_mask.fits", np.ones_like(image, dtype=np.uint8))
    pipeline = SimpleNamespace(
        OUT_DIR=artifact_dir,
        get_config=lambda: SimpleNamespace(arc_snr_threshold=2.0, arc_ignor_size=5),
        _load_stage=lambda _tag: {"extra": {"lens_light_model": np.zeros_like(image)}},
        _stage_from_payload=lambda payload: payload,
        _connected_component_area_filter=pipeline_module._connected_component_area_filter,
    )

    metrics = stages._stage_b_coverage_metrics(
        pipeline, image, np.ones_like(image), np.zeros_like(image, dtype=bool)
    )

    assert metrics["large_uncovered_threshold_islands"] == 1
    assert metrics["large_uncovered_threshold_pixels"] == 6
