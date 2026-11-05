from __future__ import annotations

from enum import StrEnum


class StageName(StrEnum):
    A = "a"
    B = "b"
    M0 = "m0"
    M1 = "m1"
    M2 = "m2"
    M3 = "m3"
    SUBHALO = "subhalo"


STAGE_ORDER = (
    StageName.A,
    StageName.B,
    StageName.M0,
    StageName.M1,
    StageName.M2,
    StageName.M3,
)

# Optional extensions participate in dependencies, not the default run sequence.
STAGE_DEPENDENCY_ORDER = (*STAGE_ORDER, StageName.SUBHALO)
