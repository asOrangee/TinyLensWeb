from __future__ import annotations

import numpy as np
import pytest
from TinyLensGpu.utils.misc import arc_mask_from

from lens_agent.modeling.arc_mask import construct_arc_mask


def test_arc_mask_trace_explains_split_faint_image_filtering() -> None:
    snr = np.zeros((16, 16), dtype=float)
    snr[5, 4:7] = 3.0
    snr[9:11, 9:11] = 3.0
    snr[9, 9] = 4.03

    construction = construct_arc_mask(
        snr, threshold=2.0, ignor_size=5, ext_size=5, close_size=3
    )

    assert construction.threshold_island_sizes == {1: 3, 2: 4}
    assert construction.surviving_threshold_island_ids == ()
    assert not construction.arc_region.any()
    assert construction.feature_mask.all()


def test_masked_high_snr_source_cannot_seed_arc_pixels() -> None:
    snr = np.zeros((20, 20), dtype=float)
    snr[4:7, 4:7] = 4.0
    snr[12:15, 12:15] = 5.0
    modeling_mask = np.zeros_like(snr, dtype=bool)
    modeling_mask[12:15, 12:15] = True

    construction = construct_arc_mask(
        snr,
        modeling_mask=modeling_mask,
        threshold=2.0,
        ignor_size=5,
        ext_size=5,
        close_size=3,
    )

    assert construction.threshold_island_sizes == {1: 9}
    assert construction.excluded_above_threshold_pixel_count == 9
    assert construction.arc_region[4:7, 4:7].all()
    assert not construction.arc_region[10:17, 10:17].any()
    assert not construction.arc_region[modeling_mask].any()


def test_arc_expansion_cannot_jump_across_the_modeling_mask() -> None:
    snr = np.zeros((20, 20), dtype=float)
    snr[8:11, 4:7] = 4.0
    modeling_mask = np.zeros_like(snr, dtype=bool)
    modeling_mask[:, 7] = True

    construction = construct_arc_mask(
        snr,
        modeling_mask=modeling_mask,
        threshold=2.0,
        ignor_size=5,
        ext_size=5,
        close_size=1,
    )

    assert construction.arc_region[:, :7].any()
    assert not construction.arc_region[:, 7:].any()


def test_arc_expansion_cannot_jump_across_a_finite_mask_segment() -> None:
    snr = np.zeros((20, 20), dtype=float)
    snr[8:11, 4:7] = 4.0
    modeling_mask = np.zeros_like(snr, dtype=bool)
    modeling_mask[7:12, 7] = True

    construction = construct_arc_mask(
        snr,
        modeling_mask=modeling_mask,
        threshold=2.0,
        ignor_size=5,
        ext_size=5,
        close_size=1,
    )

    assert construction.arc_region[:, :7].any()
    assert not construction.arc_region[7:12, 8:].any()


def test_constrained_closing_never_removes_arc_seed_pixels() -> None:
    snr = np.zeros((20, 20), dtype=float)
    snr[8:11, 4:7] = 4.0
    modeling_mask = np.zeros_like(snr, dtype=bool)
    modeling_mask[7:12, 7] = True

    construction = construct_arc_mask(
        snr,
        modeling_mask=modeling_mask,
        threshold=2.0,
        ignor_size=5,
        ext_size=1,
        close_size=5,
    )

    assert np.all(construction.closed_signal[construction.filtered_signal])
    assert not construction.closed_signal[7:12, 8:].any()


def test_arc_mask_construction_is_pixel_identical_to_previous_implementation() -> None:
    rng = np.random.default_rng(7)
    snr = rng.normal(size=(32, 32))
    snr[10:13, 8:12] += 4.0
    snr[20:24, 22:25] += 3.0

    construction = construct_arc_mask(
        snr, threshold=2.0, ignor_size=5, ext_size=5, close_size=3
    )

    expected = arc_mask_from(
        snr, threshold=2.0, ignor_size=5, ext_size=5, close_size=3
    )
    np.testing.assert_array_equal(construction.feature_mask, expected)


@pytest.mark.parametrize("footprint_size", range(1, 7))
def test_unmasked_square_footprint_meaning_is_preserved(footprint_size: int) -> None:
    rng = np.random.default_rng(9)
    snr = rng.normal(size=(32, 32))
    snr[10:14, 10:14] += 4.0

    construction = construct_arc_mask(
        snr,
        threshold=2.0,
        ignor_size=1,
        ext_size=footprint_size,
        close_size=footprint_size,
    )
    expected = arc_mask_from(
        snr,
        threshold=2.0,
        ignor_size=1,
        ext_size=footprint_size,
        close_size=footprint_size,
    )

    np.testing.assert_array_equal(construction.feature_mask, expected)
