# TinyLensWeb development

- Use Chinese for user communication unless requested otherwise. Read `README.md` before changing deployment behavior.
- Web tasks and edits are ordinary user messages to the existing pipeline AI. Do not inject system/developer instructions or bypass its scientific workflow.
- Never automatically answer scientific questions or approve commands. Preserve one-time approval semantics, thread scope, delivery journals and task isolation.
- Show only explicitly reported, validated artifacts. Missing results stay empty; never infer scientific acceptance from an exited process or a generated plot.
- Keep synthetic demo assets separate from real observations and posteriors. Preserve weighted quantiles and the difference between q50 and best-fit estimates.
- Keep credentials, SSH configuration, user paths, runtime state, datasets and results out of Git. Deployment examples contain placeholders only.
- `pipeline/AGENTS.md` governs scientific implementation. The scientific workflow root is `pipeline/`, not the enclosing Git root.
- Current scope is desktop Web. Preserve existing scientific inputs, accepted results and immutable run geometry.
- Check existing services before starting local verification. Use mocks for bridge tests; builds and routine tests must not start real AI/GPU runs.
- Run `pnpm build` for frontend changes, relevant `pnpm test:frontend` / `pnpm test:agent` for behavior changes, and appropriate deterministic Python tests for input/pipeline changes. Report scientific execution separately from those checks.
