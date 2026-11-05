# Skill-owned workflow and lens-local pipeline

> Mutable lens-local pipelines, the no-config decision, and retry diffs are superseded by
> [ADR 0012](0012-typed-attempt-local-automatic-tuning.md). Its orchestrator-owned stage-loop
> responsibility is superseded by
> [ADR 0018](0018-stage-experts-and-deterministic-adjudication.md).

The Lens Orchestrator owns batch progression, review, retry, and terminal decisions; Python provides deterministic preflight and per-stage operations without a persistent workflow state machine. Each Lens Result Directory contains one mutable `pipeline.py` copied from the template, with no `config.yaml`; a retry applies its unified diff to a Candidate Work Copy derived from the accepted lens work copy, and only an accepted candidate replaces `pipeline.py`. Each retry invalidates the failed stage and its downstream Lens Cache. This uses the classic pipeline cache for recovery while avoiding duplicated workflow and configuration machinery without accumulating failed edits.
