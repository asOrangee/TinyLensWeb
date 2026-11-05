from __future__ import annotations

import math
from typing import Any


def finite_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def nonnegative_int(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, int) and value >= 0


def positive_int(value: Any) -> bool:
    return nonnegative_int(value) and value > 0
