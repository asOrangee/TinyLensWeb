# Agentic Lens Model Repository

This repository implements a Codex-controlled, stage-gated strong-lens modeling workflow.

## Communication with the user

- Assume the user is a scientist, not a professional software engineer.
- Communicate in clear Chinese unless the user requests another language.
- During a Lens Run, use English only for all Lens Orchestrator, System Inspector,
  and Stage Expert user-facing and inter-agent natural-language output, including
  delegation, progress, correction, and terminal messages and all agent-generated
  natural-language fields. This Lens Run rule overrides the default language above,
  but users may still give instructions in any language. Preserve paths, identifiers,
  parameter names and values, mathematical notation, and uncontrolled exception text
  exactly.
- Lead with the practical result: what changed, whether it works, whether scientific results or data are affected, and what the user needs to do next.
- Avoid unexplained software-engineering jargon, abbreviations, fashionable terminology, and programming metaphors.
- When a software term is necessary, explain it immediately in plain language. When helpful, relate it to an analogous idea in scientific computing or data analysis.
- Prefer concrete descriptions, such as what a function receives and returns, over abstract labels such as “interface contract”, “dependency injection”, or “architectural pattern”.
- Do not assume familiarity with Git, continuous integration, APIs, containers, package managers, design patterns, frontend terminology, or cloud infrastructure.
- Give commands that can be copied directly. Briefly explain what each command does and whether it modifies files, data, environments, or external systems.
- When reporting an error, explain: what happened, the likely cause, whether data or scientific conclusions are affected, and the recommended next action.
- Keep scientific and mathematical explanations technically precise. Simplify the software language, not the science.
- If jargon cannot be avoided, follow it with a short “换句话说” explanation.
- Do not expose internal implementation details unless they affect a decision the user needs to make.
- Distinguish clearly among changes to the physical model, numerical computation, code organization, tests, and documentation.
- Never present a code-only reorganization as an improvement to the scientific model.
- When reporting tests, explain which scientific or computational behavior the tests actually checked.

## Safety and scientific integrity

- Treat input FITS files, review thresholds, schemas, the configured retry budgets, and the baseline classic pipeline as immutable during a modeling run.
- Before a fresh preflight, the agent may declare the calibrated input pixel scale and axis directions through the documented `preflight` options. These are input conventions, not sampled physical parameters or stage-retry tunables. Use trustworthy data metadata or an explicit user statement, record the evidence, and resolve uncertainty with the user before starting dependent work.
- Keep the declared input geometry fixed from preflight through every stage and retry. The loader reflects all aligned image planes and the PSF together into the internal increasing-column/increasing-row coordinates without resampling or changing the input FITS. A geometry correction requires a fresh Lens Run; never reuse the old masks or accepted results under new geometry.
- During an orchestrated Lens Run, run every physical stage through the supplied exact `GPU Stage Command`; direct development and research invocations may use `python -m lens_agent.cli stage ...` or the installed `lens-agent` command.
- Never promote an attempt whose hard gate failed.
- Keep code changes lens-local. Do not copy a tuner change into the baseline classic pipeline or another lens.
- A canonical `model` disposition permits the fixed single-deflector workflow even when the preflight morphology is not unique; downstream Stage Experts route unresolved structural failures to human review.

## Development

- Install with `python -m pip install -e .` in the intended TinyLensGpu environment.
- Run fast tests with `pytest -q`.
- Run syntax checks with `python -m py_compile src/lens_agent/*.py src/lens_agent/modeling/*.py`.
- Generated run artifacts belong under the user-selected output directory and must not be committed.
