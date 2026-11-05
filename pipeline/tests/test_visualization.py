from __future__ import annotations

import numpy as np

from lens_agent.visualization import stci_core


def test_array_only_visualization_api_returns_display_arrays() -> None:
    generator = np.random.default_rng(20260723)
    red, green, blue = generator.normal(20.0, 3.0, size=(24, 24, 3)).transpose(2, 0, 1)

    color = stci_core.make_color_array([red, green, blue], input_mode="raw")
    mono = stci_core.make_mono_array(red, input_mode="raw")

    assert stci_core.__all__ == ["make_color_array", "make_mono_array"]
    assert color.shape == (24, 24, 3)
    assert mono.shape == (24, 24)
    assert color.dtype == np.float32
    assert mono.dtype == np.float32
    assert np.isfinite(color).all()
    assert np.isfinite(mono).all()


def test_background_reference_medians_preserve_float64_precision() -> None:
    image = np.linspace(0.0, 1.0, num=32 * 32 * 3, dtype=np.float32).reshape(32, 32, 3)

    background = stci_core.find_background_reference(image)

    assert background.medians.dtype == np.float64
