# Four stateless CLI operations

> Superseded by [ADR 0018](0018-stage-experts-and-deterministic-adjudication.md), which adds
> stateless Stage Adjudication while continuing to reject a Python workflow state machine.

The Python interface consists only of `preflight`, `mask`, `stage`, and `summary`. Preflight creates diagnostic inputs, mask translates an accepted inspector decision, stage executes exactly one requested modeling stage, and summary aggregates terminal lens results. Review, routing, retry, and batch progression belong to the Lens Orchestrator and filesystem artifacts, not a Python command hierarchy.
