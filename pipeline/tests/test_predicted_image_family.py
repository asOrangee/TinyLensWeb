from __future__ import annotations

import pytest

from lens_agent.modeling.predicted_image_family import (
    build_predicted_image_family,
    position_likelihood_from_family,
    validate_predicted_image_family,
)


MEDIANS = {
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

SOLVER_CONFIG = {
    "initial_range": 4.0,
    "n_x": 400,
    "n_y": 400,
    "k_keep": 30,
    "num_iters": 20,
    "tolerance": 5.0e-4,
    "cluster_tol": 0.08,
}


def test_predicted_image_family_is_the_reproducible_position_likelihood() -> None:
    family = build_predicted_image_family(
        [[1.2, 1.1], [-0.7, -1.0], [-0.8, 1.7], [1.7, -0.4]],
        medians=MEDIANS,
        image_shape=(300, 300),
        pixel_scale_arcsec=0.1,
        stage_attempt="attempts/a/0",
        solver="optimization",
        solver_config=SOLVER_CONFIG,
        threshold_arcsec=0.1,
        min_log_like=-1.0e10,
    )

    assert family == {
        "schema_version": "stage_a_predicted_image_family.v1",
        "stage_attempt": "attempts/a/0",
        "coordinate_system": {
            "name": "centered_image_plane_arcsec",
            "image_shape": [300, 300],
            "pixel_scale_arcsec": 0.1,
            "x_axis": "column",
            "y_axis": "row",
            "origin_pixel": [149.5, 149.5],
        },
        "image_count": 4,
        "position_likelihood": {
            "threshold_arcsec": 0.1,
            "min_log_like": -1.0e10,
        },
        "provenance": {
            "medians": MEDIANS,
            "solver": "optimization",
            "solver_config": SOLVER_CONFIG,
        },
        "images": [
            {"image_id": "image_1", "position_arcsec": [-0.8, 1.7]},
            {"image_id": "image_2", "position_arcsec": [-0.7, -1.0]},
            {"image_id": "image_3", "position_arcsec": [1.2, 1.1]},
            {"image_id": "image_4", "position_arcsec": [1.7, -0.4]},
        ],
    }
    assert position_likelihood_from_family(family) == {
        "positions": [[-0.8, 1.7], [-0.7, -1.0], [1.2, 1.1], [1.7, -0.4]],
        "threshold_arcsec": 0.1,
        "min_log_like": -1.0e10,
    }


@pytest.mark.parametrize(
    ("positions", "message"),
    [
        ([[0.0, 0.0]], "at least two"),
        ([[0.0, 0.0], [0.04, 0.04]], "cluster_tol"),
        ([[0.0, 0.0], [15.1, 0.0]], "outside the image"),
    ],
)
def test_predicted_image_family_rejects_invalid_topology(
    positions: list[list[float]], message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        build_predicted_image_family(
            positions,
            medians=MEDIANS,
            image_shape=(300, 300),
            pixel_scale_arcsec=0.1,
            stage_attempt="attempts/a/0",
            solver="optimization",
            solver_config=SOLVER_CONFIG,
            threshold_arcsec=0.1,
            min_log_like=-1.0e10,
        )


def test_predicted_image_family_rejects_unknown_solver_fields() -> None:
    with pytest.raises(ValueError, match="solver configuration fields"):
        build_predicted_image_family(
            [[-0.5, 0.5], [0.5, -0.5]], medians=MEDIANS,
            image_shape=(300, 300), pixel_scale_arcsec=0.1,
            stage_attempt="attempts/a/0", solver="optimization",
            solver_config={**SOLVER_CONFIG, "unexpected": 1},
            threshold_arcsec=0.1, min_log_like=-1.0e10,
        )


def test_predicted_image_family_boundary_matches_lower_index_tie_rule() -> None:
    family = build_predicted_image_family(
        [[0.0, 0.0], [15.0, 0.0]], medians=MEDIANS,
        image_shape=(300, 300), pixel_scale_arcsec=0.1,
        stage_attempt="attempts/a/0", solver="optimization",
        solver_config=SOLVER_CONFIG, threshold_arcsec=0.1,
        min_log_like=-1.0e10,
    )
    assert validate_predicted_image_family(family) == family

    with pytest.raises(ValueError, match="outside the image"):
        build_predicted_image_family(
            [[-15.0, 0.0], [0.0, 0.0]], medians=MEDIANS,
            image_shape=(300, 300), pixel_scale_arcsec=0.1,
            stage_attempt="attempts/a/0", solver="optimization",
            solver_config=SOLVER_CONFIG, threshold_arcsec=0.1,
            min_log_like=-1.0e10,
        )
