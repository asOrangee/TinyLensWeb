---
status: accepted
date: 2026-08-03
---

# Replace lens-local Python patches with typed attempt-local tuning

> The immutable configurations, Tunable Catalog, and attempt-local tuning remain in effect. The
> Persistent Stage Reviewer and orchestrator-owned execution responsibilities are superseded by
> [ADR 0018](0018-stage-experts-and-deterministic-adjudication.md).

Automatic Parameter Tuning will use a fixed Packaged Pipeline and a complete, strict
`effective-config.json` inside every stage attempt. A Persistent Stage Reviewer for each
`lens × stage` submits its scientific review and optional one-setting absolute-value proposal in
one response; a deterministic Python Attempt Preparation operation validates the proposal against
an explicit, default-deny Tunable Catalog and materializes the next candidate configuration. The
reviewer chooses the value directly within minimal type, physical, resource, ownership, and state
constraints; the workflow defines no tuning ladder or prescribed step size.

Every accepted or rejected attempt retains its configuration, stage artifacts, diagnostic PNGs,
review, decision, and path-based artifact manifest. Attempts form a stage-local candidate chain,
and only an Accepted Stage Head promotes the final accepted attempt. Stage B keeps its Persistent
Arc Mask Expert but uses the same attempt/configuration mechanism; component selection is a
catalog-bound artifact rather than a pipeline setting. The active `model_tuner`, unified diffs,
mutable lens-local `pipeline.py`, `--pipeline`, shared retry cache, hashes, artifact IDs and sizes,
automatic pruning, and additional write-once enforcement are not part of the new protocol.

This decision preserves deterministic Hard Gates, decisions, retry budgets, stage order, and the
rule that accepted upstream stages are not automatically rolled back. Model and Code Evolution is
future work through a new Pipeline Release, not an in-run escape hatch. Historical result roots
remain read-only and cannot resume under the new release; new runs require a new output root.

This ADR supersedes the mutable lens-local pipeline, no-config, and retry-diff decisions in
[ADR 0001](0001-skill-owned-workflow-and-lens-local-pipeline.md); the template-copy decision in
[ADR 0007](0007-packaged-pipeline-template.md); the one-shot reviewer, Model Tuner, and diff-based
retry portions of [ADR 0010](0010-stage-specific-progression-review.md); and the diff-rendering
mechanism in [ADR 0009](0009-persistent-stage-b-arc-mask-refinement.md). Their remaining scientific
review, deterministic-decision, and persistent Stage-B authority decisions continue to apply.

The detailed agreed contract is recorded in
[Typed Attempt-Local Automatic Tuning](../design/typed-attempt-local-automatic-tuning.md).
