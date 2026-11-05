"""Tests for Stage-M1 sampling bounds and fixed source-grid policy.

Nautilus with n_live=5000 is sufficient for the SIE+shear posteriors in this
pipeline; higher values are computationally impractical on GPU.
"""
import pytest
from pydantic import ValidationError

from lens_agent.configuration import (
    EffectiveConfig,
    TUNABLE_CATALOG,
)


def test_source_grid_has_no_attempt_local_padding_tunable() -> None:
    settings = EffectiveConfig().settings.model_dump()

    assert not any(name.endswith("source_bbox_padding") for name in settings)
    assert not any(name.endswith("source_bbox_padding") for name in TUNABLE_CATALOG)
    assert "source_grid_level" in settings
    assert "source_grid_level" not in TUNABLE_CATALOG


# --- n_live tunable maximum is 5000 ---

@pytest.mark.parametrize(
    "parameter",
    ["stage_a_n_live", "stage_m1_n_live", "stage_m2_n_live", "stage_m3_n_live"],
)
def test_n_live_tunable_maximum_is_5000(parameter: str) -> None:
    assert TUNABLE_CATALOG[parameter].maximum == 5000


# --- n_eff tunable maximum stays at 100000 ---

@pytest.mark.parametrize(
    "parameter",
    ["stage_a_n_eff", "stage_m1_n_eff", "stage_m2_n_eff", "stage_m3_n_eff"],
)
def test_n_eff_tunable_maximum_unchanged(parameter: str) -> None:
    assert TUNABLE_CATALOG[parameter].maximum == 100_000


# --- arc_ignor_size default ---

def test_arc_ignor_size_default_is_5() -> None:
    assert EffectiveConfig().settings.arc_ignor_size == 5
    assert "arc_ignor_size" not in TUNABLE_CATALOG


@pytest.mark.parametrize("value", [1, 4, 6, 10000])
def test_arc_ignor_size_rejects_nondefault_config(value: int) -> None:
    with pytest.raises(ValidationError, match="arc_ignor_size"):
        EffectiveConfig.model_validate({"settings": {"arc_ignor_size": value}})
