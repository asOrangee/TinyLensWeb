# ADR 0029: Freeze calibrated input geometry for each Lens Run

## Decision

Pipeline Release `input-geometry.v1` uses Configuration Schema `lens_pipeline_config.v5` and adds
three immutable input conventions to `PipelineConfig`: positive finite `pixel_scale_arcsec`
(default `0.1`), and `input_x_direction` / `input_y_direction` (each `increasing` or `decreasing`,
default `increasing`). They describe observational calibration, not free parameters of the lens
model. They have no prior, posterior, optimization step, or Tunable Catalog entry.

The agent may declare these values through the fresh-preflight CLI using reliable metadata or an
explicit user description, with optional `--geometry-evidence` provenance. Uncertainty is resolved
with the user before dependent modeling starts. There is no arbitrary configuration-file override
and no stage-local geometry option. Existing runs retain their recorded values when preflight is
invoked without explicit geometry options; conflicting explicit values are rejected.

## Coordinates and input handling

The internal image-plane convention remains
`x = (column - (nx - 1)/2) * pixel_scale_arcsec` and
`y = (row - (ny - 1)/2) * pixel_scale_arcsec`, in arcsec. A decreasing input x direction reflects
columns; a decreasing input y direction reflects rows. The loader applies exactly the same
reflection to image, RMS noise, PSF and every available aligned colour image. It returns contiguous
arrays without interpolation, rebinning, flux normalization, or writes to the input FITS. An odd
PSF's central pixel is preserved by reflection, and reflecting both image and PSF preserves the
corresponding convolution after the same reflection. An even PSF extent on an axis to be reflected
is rejected: the discrete `same` convolution crop can otherwise shift the reflected result by one
pixel. Resolving such a PSF requires a separate, explicit centring procedure.

The model requires a square image with square, aligned pixels and shared image/PSF sampling. The
declaration is not a general WCS transform or a PSF oversampling interface. A non-square image,
rotated or sheared WCS, different x/y scales, inconsistent band registration, or different PSF sampling needs a separately specified
preparation step. No automatic FITS-header inference is introduced. Canonical x/y do not by
themselves imply celestial east/north; external positions must be expressed in the recorded frame.

## Freezing and propagation

The run manifest stores `input_geometry`, and the preflight record records the same declaration.
Preflight rendering, segmentation, mask materialization, Stage-A preparation, all later accepted
configuration inheritance, and retries use that one geometry. Both normal execution and subhalo
preview pass it to the loader. The packaged model's image-plane `DPIX` is bound to the current
validated configuration; predicted-image positions, mask diagnostics, image extents and subhalo
displays therefore use the same scale. Internal segmentation and modeling masks are already
canonical and must not be reflected again.

The separate parametric-source and pixelized-source grids, angular modeling radius, angular
position-likelihood tolerance, and pixel-count mask settings retain their existing policies.
Supporting another observed pixel scale does not authorize changing those policies. In particular,
a fixed number of mask pixels spans a different angular area at a different observation sampling;
this remains scientific review evidence rather than an implicit adjustment of thresholds.

Configuration preparation and input checks reject inconsistent geometry before computation.
Reusing an accepted stage, returning a completed result, and promoting an attempt must not bypass
the run geometry. A correction starts a fresh Lens Run from preflight; the old masks, attempts,
reviews, decisions and Accepted Stage Heads remain historical evidence. Prior Pipeline Releases
are not silently resumed or upgraded. Release identities remain explicit versioned policy, not
automatically generated source fingerprints.

## Validation

Deterministic CPU tests check defaults and invalid calibration values; all four independent axis
reflection combinations; aligned image/noise/colour/PSF arrays and unchanged FITS bytes; odd-PSF
convolution equivalence; preflight geometry persistence and conflict rejection; Stage-A inheritance;
and refusal to resume another Pipeline Release. Existing stage, retry, source-grid, mask and
preparation tests remain required. These checks establish consistent numerical coordinates; they
do not establish a scientifically accepted lens fit or replace the normal stage review workflow.
