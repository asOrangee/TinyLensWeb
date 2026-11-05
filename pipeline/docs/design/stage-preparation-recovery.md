# Stage preparation and recovery

The GPU Stage Command owns preparation and physical execution through one invocation.
`stage --prepare-only` replaces `--check-input`, validates input and upstream evidence, and
materializes the authorized complete configuration bundle without GPU use. The physical stage
rechecks these prerequisites under an attempt-specific process lock before writing its execution
marker. Scientific configuration derivation, Pipeline Release, artifact schemas, adjudication,
and scientific retry budgets are unchanged.

Preparation derives the same configuration bundle both when publishing a new attempt and when
validating an existing one. A new bundle is written in a unique sibling `.prepare-<attempt>-*`
directory and published by directory rename only after all files have been written. Interrupted
temporary bundles remain diagnostic evidence, while the next request builds a new bundle.
Formal partial or modified bundles require explicit correction outside automatic recovery.

`.operations/` holds process locks and append-only preparation error logs, separate from scientific
attempt evidence. Locks exclude concurrent preparation and execution of the same attempt and are
released by the operating system when a process exits. They are not persistent workflow state.
Busy requests exit 75. Correctable preparation errors exit 2 with `preparation_blocked`, a reason,
and a next action. They do not seal execution, create stage failures, consume scientific retries,
or enter adjudication. Invalid input addressing is rejected without writes and reported on stderr.

Completed results are reused. Started attempts lacking results remain sealed and use the existing
incomplete-execution adjudication. Post-start failures still exit 1 and follow existing hard gates.
The Stage-A timeout still starts after GPU allocation. The orchestrator preserves blocked lenses
for resume and reports the batch as unfinished until each lens has terminal scientific evidence.

This refines the execution/preparation separation in typed-attempt-local-automatic-tuning.md.
The standalone preparation command remains supported, but experts invoke only the GPU Stage
Command for initial attempts and authorized retries. Historical sealed failures are not migrated.
