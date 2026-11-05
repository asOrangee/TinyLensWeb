# Optional Stage-subhalo

Run only when the user requests a subhalo search, after accepted M3, directly in the existing
Lens Result Directory. Preserve all accepted A–M3 evidence. The current Pipeline Release supports
this additive stage without importing or rewriting existing runs. A subhalo Human Review does not
revoke M3 acceptance. Use the supplied exact Lens Agent Command and GPU Stage Command.

## Candidate and preview

Read accepted M3's result, complete model diagnostic and review, including inherited warnings.
Choose a single spatially coherent local signed residual near a modeled arc. Consider lens-light,
PSF, source structure, and global image correspondence; a peak pixel alone is insufficient.
Infer positions using image-axis coordinates in arcsec, not sky directions guessed from the image.

If `attempts/subhalo/candidate.json` exists, reuse it; the position and priors are locked. If its
status is `no_candidate`, report that terminal outcome without sampling. Otherwise write a temporary
candidate response in the assigned Agent Temporary Directory:

```json
{"status":"candidate","center_x":-0.8,"center_y":-0.4,"reason":"Evidence-based explanation."}
```

Coordinates here are illustrative, not defaults. If there is no credible local candidate, use
`status: "no_candidate"`, null coordinates, and explain why. Register with:

```text
<Lens Agent Command> subhalo candidate --output-dir <lens-result> --response <temporary-json>
```

This is an additional permitted mutation beyond the shared loop. Delete the temporary response
only after canonical registration succeeds. A no-candidate record completes the requested search
without an evidence value; it is not a fitted non-detection and has no Accepted Stage Head.

For a candidate, invoke:

```text
<GPU Stage Command> -- --lens-dir <input-lens> --output-dir <lens-result> --stage subhalo --attempt 0 --preview-only
```

This reconstructs M3 at its saved posterior medians and writes
`attempts/subhalo/0/preview/subhalo_candidate.png` without starting sampling. Inspect both panels:
the left is lens-subtracted arc data, the right normalized M3 residual; markers and 1-sigma outlines
show the locked SIS position prior. Verify the intended residual is identified and the coordinates
are correctly oriented. If the preview is wrong, stop and report the issue rather than silently
changing the candidate. After visual verification, register:

```text
<Lens Agent Command> subhalo confirm --output-dir <lens-result>
```

This additional permitted command records the inspected preview. It is an expert action, not a
request for user approval. Then run the usual GPU command without `--preview-only`. Subsequent
sampling retries reuse the initial confirmed candidate and do not require another preview.

## Physical configuration and review

The physical code uses existing StagePosterior transfer tools: M3 posterior-derived Gaussian
priors for six macro parameters, the unchanged A-fixed macro center, one same-plane SIS with
uniform theta_E in [0, 0.2] arcsec and independent position Gaussian standard deviations 0.2 arcsec
for newly registered candidates. Existing searches retain their recorded priors. Data, masks,
PSF, noise, lens light, source grid, regularization template and hyperparameters are inherited;
source brightness is re-solved. Initial sampling uses 600 live points and 1000 effective samples.

Follow the shared loop for execution, review context, adjudication and promotion. Inspect the
five-panel model plot, candidate plot, full and local residual comparison, posterior summaries,
source diagnostics, and original M3 evidence. Review all unresolved upstream warnings. Apply M3's
physical credibility criteria to the combined model and source. Explicitly report
`scientific_uncertainty` and `residual_improved` in the strict review. Set residual_improved true
only for visible coherent improvement near the candidate with no compensating degradation that
undermines interpretation elsewhere. Numerical residual metrics support but do not replace vision.

Adjudication determines `significant` only for an accepted physical fit with visible improvement
and delta ln Z >= 10. An accepted fit failing either detection condition is `not_significant`;
promote that valid result too. A nonphysical model, material prior truncation, or uncertainty routes
to Human Review, not non-detection. A posterior near zero SIS strength alone does not establish
material truncation. Report limitations of attributing local residuals to SIS mass.

The only repairs increase `stage_subhalo_n_live` or `stage_subhalo_n_eff`, one setting per retry,
for `sampling_pathology`. The independent budget is two retries; shared A–M3 budgets are unchanged.
Do not move candidates, change priors, or retry solely to increase evidence.

Report both evidence values, their difference, residual judgment and SIS parameter intervals.
State that the comparison uses M3 posterior-derived macro priors and a residual-selected local
position prior: it includes the macro-prior change and is not blind full-field significance.
