from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final, Literal


ReviewedStage = Literal["a", "m1", "m2", "m3", "subhalo"]

BLOCKERS_BY_STAGE: Final[Mapping[ReviewedStage, tuple[str, ...]]] = MappingProxyType(
    {
        "a": (
            "structural_image_family_failure",
            "material_prior_truncation",
            "sampling_pathology",
        ),
        "m1": (
            "structural_image_family_failure",
            "material_prior_truncation",
            "sampling_pathology",
            "pathological_source_reconstruction",
            "source_bbox_truncation",
            "unsupported_stage_drift",
        ),
        "m2": (
            "material_prior_truncation",
            "sampling_pathology",
            "regularization_pathology",
        ),
        "m3": (
            "structural_image_family_failure",
            "material_prior_truncation",
            "sampling_pathology",
            "pathological_source_reconstruction",
            "source_bbox_truncation",
            "unsupported_stage_drift",
        ),
        "subhalo": (
            "structural_image_family_failure",
            "material_prior_truncation",
            "sampling_pathology",
            "pathological_source_reconstruction",
            "source_bbox_truncation",
            "unsupported_stage_drift",
        ),
    }
)

WARNINGS_BY_STAGE: Final[Mapping[ReviewedStage, tuple[str, ...]]] = MappingProxyType(
    {
        "a": (
            "model_limited_residual",
            "prior_boundary_contact",
            "visual_prior_conflict",
            "unclassified_warning",
        ),
        "m1": (
            "model_limited_residual",
            "prior_boundary_contact",
            "source_sign_structure",
            "source_clumpiness",
            "supported_stage_drift",
            "unclassified_warning",
        ),
        "m2": (
            "model_limited_residual",
            "prior_boundary_contact",
            "source_sign_structure",
            "source_clumpiness",
            "uniform_like_regularization",
            "unclassified_warning",
        ),
        "m3": (
            "model_limited_residual",
            "prior_boundary_contact",
            "source_sign_structure",
            "source_clumpiness",
            "supported_stage_drift",
            "uniform_like_regularization",
            "visual_prior_conflict",
            "unclassified_warning",
        ),
        "subhalo": (
            "model_limited_residual",
            "prior_boundary_contact",
            "source_sign_structure",
            "source_clumpiness",
            "supported_stage_drift",
            "uniform_like_regularization",
            "visual_prior_conflict",
            "unclassified_warning",
        ),
    }
)
