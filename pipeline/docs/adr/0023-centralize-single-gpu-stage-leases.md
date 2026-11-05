---
status: accepted
date: 2026-09-04
---

# Centralize single-GPU leases at the physical-stage execution seam

Every orchestrated physical stage, including deterministic M0, runs through one GPU Stage Runner that acquires a cooperative GPU Lease, exposes exactly one device to JAX, owns Stage-A timeout process control, and releases the lease when the stage process ends. Stage Experts receive this fixed command and never implement GPU discovery or locking themselves; a conditional CLI guard enforces the lease in orchestrated batches while leaving direct research and test invocations available.

The local runner selects an idle whole GPU by numeric `nvidia-smi` index after setting `CUDA_DEVICE_ORDER=PCI_BUS_ID`, coordinates same-user jobs with `flock`, respects an existing single-device `CUDA_VISIBLE_DEVICES`, and waits rather than falling back to a busy device. This keeps resource policy out of scientific agents and avoids holding a GPU during review, while deliberately providing only cooperative same-host, same-user exclusion: cluster-wide or cross-user authority remains the responsibility of Slurm or another external scheduler. JAX's default memory preallocation policy is preserved.
