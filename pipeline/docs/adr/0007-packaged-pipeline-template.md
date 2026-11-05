# Packaged pipeline template

> Copying the template into a mutable lens-local pipeline is superseded by
> [ADR 0012](0012-typed-attempt-local-automatic-tuning.md). The packaged implementation remains
> the sole runtime pipeline.

The packaged `src/lens_agent/modeling/pipeline_template.py` is the sole immutable source copied into each Lens Work Copy. The external `classic_pipe` implementation remains a scientific-development reference but is not loaded or copied at runtime, because it has a different integration surface while the packaged template already stores and reloads the stage posterior cache required for stage-by-stage recovery.
