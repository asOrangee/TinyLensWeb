---
status: accepted
date: 2026-09-07
---

# Extend the Stage-A timeout and idle-GPU memory allowance

Pipeline Release `stage-a-1800s-timeout.v1` gives each orchestrated Stage-A physical process an
1800-second wall-clock limit because successful Stage-A workloads can require more than the prior
480 seconds. The timer still starts only after GPU acquisition, covers the complete stage process,
and preserves the existing TERM signal, ten-second kill grace, sealed attempt, terminal operational
Human Review, and no-automatic-retry behavior. This supersedes ADR 0018 only for the Stage-A
process-timeout duration and timeout reason text; ADR 0023's runner ownership and process-group
control remain unchanged.

The same release raises the GPU Stage Runner's default automatic-selection allowance from
`memory.used <= 500 MiB` to `memory.used <= 2000 MiB` for A, B, M0, M1, M2, and M3 while retaining
the `utilization.gpu <= 10%` limit, selection order, polling, cooperative locks, and JAX behavior.
Operator environment overrides remain available and affect resource allocation rather than the
physical model; a preassigned numeric `CUDA_VISIBLE_DEVICES` remains under the external scheduler's
authority and bypasses automatic selection.

Existing Lens Runs remain read-only under their recorded Pipeline Release. They may be summarized
or archived, but obtaining results under these policies requires a Full Lens Rerun.
