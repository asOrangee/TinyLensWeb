"""Deterministic preflight artifacts consumed by the system-inspector agent."""

from .diagnostics import build_inspection_packet, materialize_modeling_mask

__all__ = ["build_inspection_packet", "materialize_modeling_mask"]
