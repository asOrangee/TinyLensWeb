"""Evaluate EPL and shear reference rays using the installed TinyLensGpu model."""
import json
import sys

import jax

jax.config.update("jax_enable_x64", True)
jax.config.update("jax_disable_jit", True)

import jax.numpy as jnp
import numpy as np
from TinyLensGpu.PhysicalModel import Shear
from TinyLensGpu.PhysicalModel.LensImage.Parametric.Mass import EPL


def reference_rays(model, points):
    if jax.default_backend() != "cpu":
        raise ValueError("Lens mapping references must use CPU")
    mass = EPL(
        theta_E=model["theta_E"], gamma=model["gamma"],
        e1=model["e1_mass"], e2=model["e2_mass"],
        center_x=model["center_x_mass"], center_y=model["center_y_mass"],
    )
    shear = Shear(gamma1=model["gamma1"], gamma2=model["gamma2"])

    positions = np.asarray(points, dtype=np.float64)
    center = [model["center_x_mass"], model["center_y_mass"]]
    ellipticity = min(.9999, np.hypot(model["e1_mass"], model["e2_mass"]))
    axis_ratio = (1 - ellipticity) / (1 + ellipticity)
    step = np.maximum(1e-5 * axis_ratio * np.linalg.norm(positions - center, axis=1),
                      32 * np.spacing(np.maximum(1., np.abs(positions).max(axis=1))))
    dx = step[:, None] * np.array([1., 0.])
    dy = step[:, None] * np.array([0., 1.])
    # Sample the library lens equation in one batch for an independent Jacobian check.
    x, y = jnp.asarray(np.concatenate((positions, positions + dx, positions - dx,
                                      positions + dy, positions - dy))).T
    mx, my = mass.deriv(x, y)
    sx, sy = shear.deriv(x, y)
    sources, xp, xm, yp, ym = np.split(np.asarray(jnp.stack((x - mx - sx, y - my - sy), axis=1)), 5)
    derivative_x = (xp - xm) / ((positions + dx)[:, 0] - (positions - dx)[:, 0])[:, None]
    derivative_y = (yp - ym) / ((positions + dy)[:, 1] - (positions - dy)[:, 1])[:, None]
    determinants = derivative_x[:, 0] * derivative_y[:, 1] - derivative_y[:, 0] * derivative_x[:, 1]
    return [
        {"image": {"x": x, "y": y}, "source": {"x": bx, "y": by}, "determinant": det}
        for (x, y), (bx, by), det in zip(positions.tolist(), sources.tolist(), determinants.tolist())
    ]


if __name__ == "__main__":
    model = json.loads(sys.stdin.readline())
    offsets = [(-1.3, -.8), (-.65, .95), (.4, -.6), (1.15, .2), (1.4, -1.1), (.2, 1.55),
               (-.05, .07), (.035, .018), (.07, -.11)]
    points = [(model["center_x_mass"] + model["theta_E"] * x,
               model["center_y_mass"] + model["theta_E"] * y) for x, y in offsets]
    print(json.dumps(reference_rays(model, points), allow_nan=False, separators=(",", ":")))
