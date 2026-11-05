# Agentic Lens Model

This repository provides deterministic Python operations for a Codex-orchestrated,
stage-by-stage strong-lens workflow. The `lens-model-orchestrator` skill owns batch order,
stage order, delegation, terminal-evidence checks, and summary generation. Independent Stage
Experts own each subjective stage loop, while stateless Python adjudication enforces mechanical
review, retry, and decision rules without persisting a workflow state machine.

## User-facing workflow

Ask the `lens-model-orchestrator` skill to analyze explicit lens IDs below an input directory and
write results to an output directory. It creates:

```text
output/
  lens_a/
  lens_b/
  summary.csv
```

Each lens directory contains a central two-panel System Inspector prompt, a retained six-panel
human audit, segmentation FITS, three independent inspector votes, their text-only synthesis, the
canonical inspector decision, exact modeling mask, attempt-local configurations and scientific
artifacts, and atomic Accepted Stage Heads. The run executes one immutable Packaged Pipeline;
reviewers propose typed parameter values and never edit Python.

## Input pixel scale and coordinates

Declare the observation's calibrated geometry when starting a fresh preflight. The defaults remain
`pixel_scale_arcsec=0.1`, `input_x_direction=increasing`, and
`input_y_direction=increasing`. For example, an image calibrated at `0.05 arcsec/pixel` whose
physical y coordinate decreases as the input row index increases can use:

```bash
lens-agent preflight --lens-dir INPUT/lens_a --output-dir OUTPUT/lens_a \
  --pixel-scale-arcsec 0.05 --input-x-direction increasing --input-y-direction decreasing \
  --geometry-evidence 'Calibrated input metadata: 0.05 arcsec per pixel; x increases with columns and y decreases with rows.'
```

The agent chooses these declarations from reliable input metadata or the user's explicit data
description. Ambiguous metadata requires clarification before modeling. FITS headers do not silently
override the declarations. The modeling interface requires a square image with aligned, square
pixels and supports independent axis reflections. A non-square image, rotated or sheared WCS,
unequal x/y scales, a differently sampled PSF, or unregistered bands needs a separately agreed data
preparation procedure. A reflected PSF axis must have odd length to preserve its convolution centre.

The loader reflects `VIS_FLUX`, `VIS_RMS`, `VIS_PSF`, and available aligned `NIR_Y_FLUX` /
`NIR_J_FLUX` together. It preserves sampling, pixel values, the RMS interpretation, and the input
file bytes. Internal model coordinates are
`x = (column - (nx - 1)/2) * pixel_scale_arcsec` and
`y = (row - (ny - 1)/2) * pixel_scale_arcsec`. Increasing x/y therefore follow increasing
canonical columns/rows; these labels alone do not establish celestial east or north.

The run manifest and preflight record retain the declared geometry; all attempt configurations
inherit it. Repeating preflight without geometry options uses the frozen values. An explicit
conflict is rejected. Geometry is excluded from the Tunable Catalog and cannot change during a
stage retry. Correcting it requires a fresh run from preflight, preserving earlier results through
`rerun prepare` when reusing the same result location. This does not change the separate fixed
source-plane pixel scales or the physical position-likelihood tolerance. See
[the input-geometry decision](docs/adr/0029-freeze-calibrated-input-geometry.md).

## Python operations

The skill uses only these stateless commands:

```bash
lens-agent preflight --lens-dir INPUT/lens_a --output-dir OUTPUT/lens_a
lens-agent inspector votes --output-dir OUTPUT/lens_a --response VOTE_0.json --response VOTE_1.json --response VOTE_2.json
lens-agent inspector synthesis --output-dir OUTPUT/lens_a --response SYNTHESIS.json
lens-agent mask --output-dir OUTPUT/lens_a --inspection OUTPUT/lens_a/preflight/synthesis.json
lens-agent stage --lens-dir INPUT/lens_a --output-dir OUTPUT/lens_a --stage a --attempt 0
lens-agent review context --output-dir OUTPUT/lens_a --stage a --attempt 0
lens-agent review adjudicate --output-dir OUTPUT/lens_a --stage a --attempt 0 --response RESPONSE.json
lens-agent attempt promote --output-dir OUTPUT/lens_a --stage a --attempt 0
lens-agent rerun prepare --output-dir OUTPUT/lens_a
lens-agent summary --output-dir OUTPUT
```

`stage` prepares and validates its configuration automatically. `stage --prepare-only` performs
the same preparation without a GPU or scientific execution; it replaces `--check-input` and may
write preparation files. The GPU runner uses it before allocating a GPU and rechecks at execution.
`busy` (exit 75) means another process owns the attempt. `preparation_blocked` (exit 2) means a
prerequisite needs correction; resume the same attempt afterward without scientific adjudication.
Operational logs live in `.operations/`, outside scientific attempts. Interrupted temporary
preparation bundles remain as evidence; existing formal attempts are never repaired by overwriting.
The standalone `attempt prepare` remains available for development and refuses existing attempts.

`preflight` writes `preflight_2panel.png` for three isolated System Inspectors,
`preflight_6panel.png` for human audit, and `segmentation.fits`. The inspection packet identifies
the two image roles explicitly; the inspectors never receive the human audit. The two-panel view keeps
one image pixel beyond the 4″ circle so boundary crossings are visible even along the horizontal or
vertical axis. The single authoritative segmentation consists of deblended positive VIS detections
with at least five connected pixels at or above 3σ. Both figures draw exactly those 3σ segments.
The Inspector view uses neutral white contours and yellow IDs with black contrast outlines so
segmentation colours cannot be mistaken for physical image colours. Once all three strict responses
are valid, `inspector votes` retains them together under `preflight/inspector-votes/`. A dedicated
text-only synthesis expert reads those reports but no image. Its `disposition` and each contaminant
ID must follow a two-of-three majority; a `model` hint must be copied intact from one majority model
vote, while `human_review` uses a null hint. `inspector synthesis` verifies these rules without
calculating or rewriting the expert response and registers `preflight/synthesis.json`.

Synthesis-selected contaminants mask exactly their segment pixels, without dilation or recovery of
lower-significance outskirts. `mask` converts a validated `disposition: model` synthesis into
`modeling_mask.fits` and the canonical `preflight/inspector.json`; a `human_review` synthesis stops
the lens before modeling. Attempt Preparation materializes a complete typed configuration;
`stage` runs exactly A, B, M0, M1, M2, or M3 into `attempts/<stage>/<N>/`; review-context
generation gives its Stage Expert a bounded resumable view; adjudication validates the Hard Gate,
expert response, warning lineage, local repair, and retry budgets before saving canonical review
and decision evidence. The decision records SHA-256 fingerprints of the attempt evidence so a
later conflicting change cannot masquerade as an idempotent repeat. Promotion validates an accepted candidate and atomically advances
`accepted/<stage>.json`. An attempt is sealed against re-execution as soon as its stage command
writes `stage-execution.json`. `summary` writes one
CSV row per lens.

During an orchestrated run, every physical stage—including M0—uses
`scripts/run_lens_stage_on_idle_gpu.sh`. The GPU Stage Runner waits for one idle whole GPU, holds a
same-user file lock for the lifetime of the stage process, and sets `CUDA_VISIBLE_DEVICES` so JAX
sees exactly one device. Stage Experts receive the fixed runner command and do not implement GPU
selection. Direct `lens-agent stage` remains available for development and manually managed
environments.

An explicit full rerun first moves only the target's current result directory to
`_archive/<lens_id>_old_<N>` through `rerun prepare`, then starts that lens again at preflight
under its canonical `<lens_id>` path. Existing results for other lenses are untouched, archived
runs are never reused, and `summary` ignores `_archive/` completely. Resume requests do not archive
and continue from the current Accepted Stage Heads. Automatic rerun preparation accepts a valid
Lens Run Manifest from any Pipeline Release; the fresh run records the current release. Lens result
directories containing symbolic links are rejected so an archived run cannot later point into a
new run.

M0–M3 subtract the lens-light model saved by Stage A. Stage B's `feature_mask.fits` describes
lensed-source support only. Output directories created by the former Stage-L workflow are
historical evidence and are not resumable with this workflow; use a new output directory.

A, B, M0, M1, M2, and M3 each use one persistent, write-capable Stage Expert per lens and stage. The
expert runs only its assigned immutable Packaged Pipeline stage, reviews eligible evidence, submits
one stage-specific strict response, and follows the canonical adjudicated decision through retry or
promotion. Stage B may request one parameter change or removal of unrelated whole components; its
decision is derived from that structured refinement evidence. The M0 expert reviews only whether
coherent source emission is clipped by the current grid; Python alone selects the next fixed
`±0.8 → ±1.0 → ±1.2 arcsec` footprint while preserving `0.02 arcsec` pixels. An accepted M0 attempt
seals `source_grid_spec.json` for M1–M3; later stages can route newly visible clipping to Human
Review but cannot resize or roll back the grid. Stage B has ten retries after its initial attempt;
each other reviewed stage has five and
the physical stages share fifteen per lens. Every accepted and rejected JSON, PNG, FITS, and PKL
remains in its sealed attempt directory.

## Development

```bash
python -m pip install -e .
python -m py_compile src/lens_agent/*.py src/lens_agent/modeling/*.py
pytest -q
```

Generated modeling outputs belong below the selected output directory and must not be committed.
Choose an output directory outside this repository, or use its ignored `output/` directory.
