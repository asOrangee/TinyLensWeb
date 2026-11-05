from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .result_paths import (
    require_lens_local_tree,
    require_nonhistorical_lens_result,
    resolve_current_lens_result_path,
)


PIPELINE_RELEASE_ID = "input-geometry.v1"
CONFIG_SCHEMA_VERSION = "lens_pipeline_config.v5"

Limits = tuple[float, float]


def _validated_run(
    output_dir: Path, *, require_current_pipeline_release: bool
) -> tuple[Path, dict[str, object]]:
    output_dir = resolve_current_lens_result_path(output_dir)
    require_lens_local_tree(output_dir)
    require_nonhistorical_lens_result(output_dir)
    manifest_path = output_dir / "run-manifest.json"
    if not manifest_path.is_file():
        raise ValueError("output root has no current Lens Run Manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError(f"Lens Run Manifest must be a JSON object: {manifest_path}")
    if manifest.get("schema_version") != "lens_run_manifest.v1":
        raise ValueError("unsupported Lens Run Manifest")
    pipeline_release_id = manifest.get("pipeline_release_id")
    if not isinstance(pipeline_release_id, str) or not pipeline_release_id:
        raise ValueError("Lens Run Manifest has no Pipeline Release")
    if require_current_pipeline_release and pipeline_release_id != PIPELINE_RELEASE_ID:
        raise ValueError("output root belongs to a different Pipeline Release")
    return output_dir, manifest


def validate_run_manifest(output_dir: Path) -> dict[str, object]:
    return _validated_run(output_dir, require_current_pipeline_release=True)[1]


def validated_run_root(output_dir: Path) -> Path:
    return _validated_run(output_dir, require_current_pipeline_release=True)[0]


def archiveable_run_root(output_dir: Path) -> Path:
    return _validated_run(output_dir, require_current_pipeline_release=False)[0]


class StrictModel(BaseModel):
    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        allow_inf_nan=False,
        frozen=True,
        validate_default=True,
    )


class PriorConfig(StrictModel):
    prior_type: Literal[
        "uniform",
        "gaussian",
        "truncated_gaussian",
        "truncated_gaussian_uniform_mixture",
    ]
    prior_settings: tuple[float, ...]
    limits: tuple[float, float]

    @field_validator("prior_settings", "limits", mode="before")
    @classmethod
    def freeze_sequence(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value

    @model_validator(mode="after")
    def validate_prior(self) -> "PriorConfig":
        lower, upper = self.limits
        if lower >= upper:
            raise ValueError("prior limits must be strictly increasing")
        expected = 3 if self.prior_type == "truncated_gaussian_uniform_mixture" else 2
        if len(self.prior_settings) != expected:
            raise ValueError(f"{self.prior_type} prior requires {expected} settings")
        first, second = self.prior_settings[:2]
        if self.prior_type == "uniform":
            if not lower <= first < second <= upper:
                raise ValueError("uniform prior interval must lie within limits")
        else:
            if not lower <= first <= upper:
                raise ValueError("Gaussian prior mean must lie within limits")
            if second <= 0:
                raise ValueError("Gaussian prior sigma must be positive")
        if self.prior_type == "truncated_gaussian_uniform_mixture":
            core_weight = self.prior_settings[2]
            if not 0 < core_weight < 1:
                raise ValueError("mixture core weight must lie strictly between zero and one")
        return self


class InputGeometry(StrictModel):
    """Calibrated input conventions, fixed throughout one Lens Run."""

    pixel_scale_arcsec: float = Field(default=0.1, gt=0)
    input_x_direction: Literal["increasing", "decreasing"] = "increasing"
    input_y_direction: Literal["increasing", "decreasing"] = "increasing"

    @classmethod
    def from_settings(cls, settings: "InputGeometry") -> "InputGeometry":
        return cls.model_validate({name: getattr(settings, name) for name in cls.model_fields})


def run_input_geometry(output_dir: Path) -> InputGeometry:
    """Read the run's geometry; absent fields retain the documented legacy defaults."""
    manifest = validate_run_manifest(output_dir)
    geometry = InputGeometry.model_validate(manifest.get("input_geometry", {}), strict=True)
    packet_path = output_dir / "preflight" / "inspection.json"
    if packet_path.is_file():
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
        if InputGeometry.model_validate(packet.get("input_geometry", {}), strict=True) != geometry:
            raise ValueError("Preflight input geometry differs from the run manifest; start a new run")
    return geometry


class PipelineConfig(InputGeometry):
    stage_a_n_live: int = 200
    stage_a_n_eff: int = 800
    stage_m1_n_live: int = 300
    stage_m1_n_eff: int = 600
    stage_m2_n_live: int = 250
    stage_m2_n_eff: int = 600
    stage_m3_n_live: int = 300
    stage_m3_n_eff: int = 600
    stage_subhalo_n_live: int = 600
    stage_subhalo_n_eff: int = 1000
    stage_a_theta_E_initial: float = 1.5
    stage_a_theta_E_prior: PriorConfig = PriorConfig(
        prior_type="uniform", prior_settings=[0.5, 3.0], limits=[0.5, 3.0]
    )
    stage_a_e1_prior: PriorConfig = PriorConfig(
        prior_type="truncated_gaussian", prior_settings=[0.0, 0.2], limits=[-1.0, 1.0]
    )
    stage_a_e2_prior: PriorConfig = PriorConfig(
        prior_type="truncated_gaussian", prior_settings=[0.0, 0.2], limits=[-1.0, 1.0]
    )
    stage_a_center_x_prior: PriorConfig = PriorConfig(
        prior_type="gaussian", prior_settings=[0.0, 0.1], limits=[-1.0, 1.0]
    )
    stage_a_center_y_prior: PriorConfig = PriorConfig(
        prior_type="gaussian", prior_settings=[0.0, 0.1], limits=[-1.0, 1.0]
    )
    stage_a_gamma1_prior: PriorConfig = PriorConfig(
        prior_type="uniform", prior_settings=[-0.2, 0.2], limits=[-0.5, 0.5]
    )
    stage_a_gamma2_prior: PriorConfig = PriorConfig(
        prior_type="uniform", prior_settings=[-0.2, 0.2], limits=[-0.5, 0.5]
    )
    stage_a_src_center_prior: PriorConfig = PriorConfig(
        prior_type="gaussian", prior_settings=[0.0, 0.5], limits=[-3.0, 3.0]
    )
    stage_a_src_e_prior: PriorConfig = PriorConfig(
        prior_type="truncated_gaussian", prior_settings=[0.0, 0.3], limits=[-1.0, 1.0]
    )
    stage_a_lens_light_center_prior: PriorConfig = PriorConfig(
        prior_type="gaussian", prior_settings=[0.0, 0.1], limits=[-1.0, 1.0]
    )
    stage_a_lens_light_e_prior: PriorConfig = PriorConfig(
        prior_type="truncated_gaussian", prior_settings=[0.0, 0.3], limits=[-1.0, 1.0]
    )
    stage_m1_theta_E_prior_limits: Limits = (0.0, 5.0)
    stage_m1_ellipticity_prior_limits: Limits = (-1.0, 1.0)
    stage_m1_shear_prior_limits: Limits = (-0.5, 0.5)
    stage_m3_theta_E_prior_limits: Limits = (0.0, 5.0)
    stage_m3_gamma_prior: PriorConfig = PriorConfig(
        prior_type="uniform", prior_settings=[1.0, 3.0], limits=[1.0, 3.0]
    )
    stage_m3_ellipticity_prior_limits: Limits = (-1.0, 1.0)
    stage_m3_shear_prior_limits: Limits = (-0.5, 0.5)
    arc_snr_threshold: float = 2.0
    arc_ignor_size: Literal[5] = 5
    arc_ext_size: int = 5
    arc_close_size: int = 3
    m0_n_grid: int = 200
    m0_log_lam_min: float = -18.420680743952367
    m0_log_lam_max: float = 18.420680743952367
    adaptive_reg_rho_prior_max: float = 8.0
    source_grid_level: int = 0
    n_gaussians_src: int = 10
    n_gaussians_lens: int = 10

    @model_validator(mode="after")
    def validate_runtime_relationships(self) -> "PipelineConfig":
        theta_lower, theta_upper = self.stage_a_theta_E_prior.limits
        if not theta_lower <= self.stage_a_theta_E_initial <= theta_upper:
            raise ValueError("Stage-A theta_E initial value must lie within prior limits")
        for stage in ("a", "m1", "m2", "m3", "subhalo"):
            n_live = getattr(self, f"stage_{stage}_n_live")
            n_eff = getattr(self, f"stage_{stage}_n_eff")
            if not 1 <= n_live <= n_eff <= 100_000:
                raise ValueError(f"stage_{stage} sampling requires 1 <= n_live <= n_eff <= 100000")
        if not 2 <= self.m0_n_grid <= 100_000:
            raise ValueError("m0_n_grid must be between 2 and 100000")
        if self.m0_log_lam_min >= self.m0_log_lam_max:
            raise ValueError("M0 log-lambda minimum must be below maximum")
        if not 0 < self.adaptive_reg_rho_prior_max <= 100:
            raise ValueError("adaptive_reg_rho_prior_max must be between 0 and 100")
        if self.source_grid_level not in {0, 1, 2}:
            raise ValueError("source_grid_level is outside the fixed grid policy")
        if self.n_gaussians_src <= 0 or self.n_gaussians_lens <= 0:
            raise ValueError("model resolution settings must be positive")
        if not 1.0 <= self.arc_snr_threshold <= 10.0 or any(
            not 0 < value <= 10_000
            for value in (self.arc_ext_size, self.arc_close_size)
        ):
            raise ValueError("Stage-B mask settings are outside their safety bounds")
        for name in type(self).model_fields:
            spec = getattr(self, name)
            if name.endswith("_prior_limits"):
                lower, upper = spec
                if lower >= upper:
                    raise ValueError(f"invalid limits for {name}")
        return self


class EffectiveConfig(StrictModel):
    schema_version: Literal["lens_pipeline_config.v5"] = CONFIG_SCHEMA_VERSION
    pipeline_release_id: Literal["input-geometry.v1"] = (
        PIPELINE_RELEASE_ID
    )
    parent_config: str | None = None
    settings: PipelineConfig = PipelineConfig()


@dataclass(frozen=True)
class TunableSpec:
    stage: Literal["a", "b", "m1", "m2", "m3", "subhalo"]
    role: Literal[
        "stage_a_expert",
        "stage_b_expert",
        "stage_m1_expert",
        "stage_m2_expert",
        "stage_m3_expert",
        "stage_subhalo_expert",
    ]
    blockers: frozenset[str]
    value_type: type[int] | type[float]
    minimum: int | float
    maximum: int | float
    cross_field_peer: str | None = None
    cross_field_relation: Literal["lte", "gte"] | None = None

    @property
    def invalidates_from(self) -> str:
        return self.stage


TUNABLE_CATALOG: dict[str, TunableSpec] = {
    "stage_a_n_live": TunableSpec(
        "a",
        "stage_a_expert",
        frozenset({"sampling_pathology"}),
        int,
        1,
        5_000,
        cross_field_peer="stage_a_n_eff",
        cross_field_relation="lte",
    ),
    "stage_a_n_eff": TunableSpec(
        "a",
        "stage_a_expert",
        frozenset({"sampling_pathology"}),
        int,
        1,
        100_000,
        cross_field_peer="stage_a_n_live",
        cross_field_relation="gte",
    ),
    "stage_m1_n_live": TunableSpec(
        "m1",
        "stage_m1_expert",
        frozenset({"sampling_pathology"}),
        int,
        1,
        5_000,
        cross_field_peer="stage_m1_n_eff",
        cross_field_relation="lte",
    ),
    "stage_m1_n_eff": TunableSpec(
        "m1",
        "stage_m1_expert",
        frozenset({"sampling_pathology"}),
        int,
        1,
        100_000,
        cross_field_peer="stage_m1_n_live",
        cross_field_relation="gte",
    ),
    "stage_m2_n_live": TunableSpec(
        "m2",
        "stage_m2_expert",
        frozenset({"sampling_pathology"}),
        int,
        1,
        5_000,
        cross_field_peer="stage_m2_n_eff",
        cross_field_relation="lte",
    ),
    "stage_m2_n_eff": TunableSpec(
        "m2",
        "stage_m2_expert",
        frozenset({"sampling_pathology"}),
        int,
        1,
        100_000,
        cross_field_peer="stage_m2_n_live",
        cross_field_relation="gte",
    ),
    "adaptive_reg_rho_prior_max": TunableSpec(
        "m2",
        "stage_m2_expert",
        frozenset({"material_prior_truncation", "regularization_pathology"}),
        float,
        0.01,
        100.0,
    ),
    "stage_m3_n_live": TunableSpec(
        "m3",
        "stage_m3_expert",
        frozenset({"sampling_pathology"}),
        int,
        1,
        5_000,
        cross_field_peer="stage_m3_n_eff",
        cross_field_relation="lte",
    ),
    "stage_m3_n_eff": TunableSpec(
        "m3",
        "stage_m3_expert",
        frozenset({"sampling_pathology"}),
        int,
        1,
        100_000,
        cross_field_peer="stage_m3_n_live",
        cross_field_relation="gte",
    ),
    "stage_subhalo_n_live": TunableSpec(
        "subhalo", "stage_subhalo_expert", frozenset({"sampling_pathology"}),
        int, 1, 5_000, cross_field_peer="stage_subhalo_n_eff",
        cross_field_relation="lte",
    ),
    "stage_subhalo_n_eff": TunableSpec(
        "subhalo", "stage_subhalo_expert", frozenset({"sampling_pathology"}),
        int, 1, 100_000, cross_field_peer="stage_subhalo_n_live",
        cross_field_relation="gte",
    ),
    "arc_snr_threshold": TunableSpec(
        "b", "stage_b_expert", frozenset({"arc_mask"}), float, 1.0, 10.0
    ),
    "arc_ext_size": TunableSpec(
        "b", "stage_b_expert", frozenset({"arc_mask"}), int, 1, 10_000
    ),
    "arc_close_size": TunableSpec(
        "b", "stage_b_expert", frozenset({"arc_mask"}), int, 1, 10_000
    ),
}


def validate_config_geometry(config: EffectiveConfig, output_dir: Path) -> None:
    if InputGeometry.from_settings(config.settings) != run_input_geometry(output_dir):
        raise ValueError("Effective input geometry differs from the run manifest; start a new run")
