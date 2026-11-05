# Use one persistent expert session for Stage-B arc-mask refinement

> The persistent expert authority remains in effect, but its Python-diff rendering mechanism is
> superseded by [ADR 0012](0012-typed-attempt-local-automatic-tuning.md). Its read-only expert and
> orchestrator-execution split is superseded by
> [ADR 0018](0018-stage-experts-and-deterministic-adjudication.md).

Each lens uses one persistent Arc Mask Expert session across the entire Stage-B refinement loop so that visual findings, attempted parameters, and scientific reasoning remain in its context without lossy history summaries. After the initial attempt, Stage B has its own ten-retry budget, independent of the fifteen retries shared by the physical-modeling stages; every expert proposal that is applied and rerun consumes this budget, while invalid expert responses do not. An expert gets two opportunities to correct an invalid response before the lens is routed to human review with a contract-failure reason.

The expert reviews `stage_b_mask.png`, `stage_b_components.png`, and `stage_b_components.json`, then either accepts, requests one parameter change, requests a complete set of unrelated component IDs to drop, or routes uncertainty to human review. All four `arc_mask_from` parameters are available without prescribed numerical step sizes, but only one may change per retry; parameter changes and component selection never occur together. The Lens Orchestrator mechanically applies the structured proposal to a lens-local candidate, saves the diff, reruns Stage B through the CLI, and always returns the regenerated evidence to the same expert before acceptance.

A credible lensed feature joined to a contaminant may only be retried by undoing the immediately responsible expansion or closing change; otherwise the lens goes to human review rather than splitting a component by pixels. Stage-B Hard Gate failure is reported as an operational failure without creating the expert session or invoking a tuner.
