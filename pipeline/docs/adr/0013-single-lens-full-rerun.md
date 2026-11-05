---
status: accepted
date: 2026-08-06
---

# Archive and rerun one lens without restarting its batch

An explicit Full Lens Rerun archives only the target's current Lens Result Directory under
`_archive/<lens_id>_old_<N>`, where `N` is one greater than the largest existing archive number
for that lens and is never chosen by filling a gap among existing archives, then starts a fresh
Lens Run at the canonical `<lens_id>` path. The workflow never deletes an archive. The new run
begins at preflight and inherits no mask, attempt, review, accepted head, or retry budget from the
archive; it remains current even if it ends in Human Review or an operational failure. Other lenses
in the Batch Output Directory are untouched, and the Batch Summary ignores `_archive/`.

An `<lens_id>_old_<N>` name identifies an archived version only in that lens's Archive Directory.
The same suffix is allowed in a canonical current Lens Result Directory, whose identity comes from
its location directly below the Batch Output Directory.

Other entries already in an Archive Directory are left untouched and ignored. Only entries named
exactly `<lens_id>_old_<integer>` contribute to choosing the next archive number.

The Lens Orchestrator invokes the deterministic `lens-agent rerun prepare --output-dir
<lens-result>` operation only for explicit “重新分析”, “重跑”, or “从头开始” language. Explicit
“继续” or “恢复” language resumes the current run. If a current result exists but the request does
not make this choice, the Lens Orchestrator asks before changing any directory.
That operation requires an existing, recognizable result with a valid Lens Run Manifest: its
`schema_version` must be supported and its `pipeline_release_id` must be non-empty. The recorded
Pipeline Release need not match the current one; a missing, malformed, or historical-layout
directory is rejected. Archiving a different release does not migrate or reuse it: the fresh run
records the current Pipeline Release in its own manifest.
Every workflow command that writes lens results rejects `_archive/` and all of its descendants.
A Lens Result Directory containing a symbolic link is rejected so that renaming it always
produces a self-contained archive. `_archive/` must be a real directory within the Batch Output
Directory, never a symbolic link. The workflow processes one lens serially:
rerun preparation waits for that lens's active run to end, and concurrent analysis must use a
different Batch Output Directory. No same-lens lock is implemented.
