---
status: superseded by ADR-0025
---

# Anchor the pixelized-source grid at Stage A and defer EPL to M3

Use one square source grid for M0–M3, centred on the Stage-A posterior-median MGE source and extending to 2.5 times its major-axis half-light radius. M1 samples SIE+shear, M2 fixes that SIE+shear result, and only M3 releases the EPL radial slope. This favors a stable, comparable source basis through regularization calibration over early radial-slope freedom; confirmed source-grid truncation has no stage-local repair and routes to human review. The physical recipe requires a new Pipeline Release and cannot be introduced while resuming an earlier Lens Run.
