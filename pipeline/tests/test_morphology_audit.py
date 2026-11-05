from __future__ import annotations

import numpy as np
import pytest
from scipy import ndimage

from lens_agent.modeling.arc_mask import construct_arc_mask
from lens_agent.modeling.morphology_audit import (
    build_stage_b_morphology_audit,
    validate_stage_b_morphology_audit,
)
from lens_agent.modeling.predicted_image_family import build_predicted_image_family
from tests.test_predicted_image_family import MEDIANS, SOLVER_CONFIG


def test_morphology_audit_exposes_a_supported_position_filtered_before_catalog() -> None:
    snr = np.zeros((32, 32), dtype=float)
    snr[10, 8:11] = 3.0
    snr[13:15, 12:14] = 3.0
    snr[14, 13] = 4.03
    snr[22:25, 23:26] = 4.0
    construction = construct_arc_mask(
        snr, threshold=2.0, ignor_size=5, ext_size=5, close_size=3
    )
    candidate_labels, _ = ndimage.label(
        construction.arc_region, structure=np.ones((3, 3), dtype=int)
    )
    family = build_predicted_image_family(
        [[-0.25, -0.15], [0.85, 0.75]],
        medians=MEDIANS,
        image_shape=snr.shape,
        pixel_scale_arcsec=0.1,
        stage_attempt="attempts/a/0",
        solver="optimization",
        solver_config=SOLVER_CONFIG,
        threshold_arcsec=0.1,
        min_log_like=-1.0e10,
    )

    audit = build_stage_b_morphology_audit(
        family,
        construction=construction,
        snr=snr,
        modeling_mask=np.zeros_like(snr, dtype=bool),
        candidate_component_labels=candidate_labels,
        selected_arc_region=construction.arc_region,
        stage_attempt="attempts/b/0",
        family_reference="attempts/a/0/artifacts/stage_a_predicted_image_family.json",
        family_sha256="a" * 64,
        threshold=2.0,
        ignor_size=5,
        ext_size=5,
        close_size=3,
    )

    assert audit["schema_version"] == "stage_b_morphology_audit.v2"
    assert audit["valid_modeling_domain"] == {
        "mask_convention": "modeling_mask True excludes pixels",
        "valid_pixel_count": 1024,
        "excluded_pixel_count": 0,
        "excluded_above_threshold_pixel_count": 0,
    }
    assert audit["predicted_image_family"] == {
        "reference": "attempts/a/0/artifacts/stage_a_predicted_image_family.json",
        "sha256": "a" * 64,
    }
    faint = audit["images"][0]
    assert faint["image_id"] == "image_1"
    assert faint["nearest_pixel"] == [14, 13]
    assert faint["nearest_pixel_covered"] is False
    assert faint["local_peak_snr"] == pytest.approx(4.03)
    assert faint["local_above_threshold_pixel_count"] == 4
    assert [(item["total_pixel_count"], item["survives_ignor_size"]) for item in faint["threshold_islands"]] == [
        (4, False)
    ]
    assert faint["candidate_component_ids"] == []
    assert faint["selected_component_ids"] == []
    assert faint["local_selected_arc_pixel_count"] == 0
    assert faint["local_selected_arc_fraction"] == 0.0

    bright = audit["images"][1]
    assert bright["nearest_pixel_covered"] is True
    assert bright["candidate_component_ids"] == [1]
    assert bright["selected_component_ids"] == [1]
    assert validate_stage_b_morphology_audit(audit) == audit

    audit["images"][0]["local_selected_arc_fraction"] = 0.5
    with pytest.raises(ValueError, match="local pixel counts"):
        validate_stage_b_morphology_audit(audit)
    audit["images"][0]["local_selected_arc_fraction"] = 0.0

    audit["unexpected"] = True
    with pytest.raises(ValueError, match="fields"):
        validate_stage_b_morphology_audit(audit)
