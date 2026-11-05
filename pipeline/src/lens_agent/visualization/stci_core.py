"""Vendored STCI 0.1.3 array-only renderer.

Derived from Tian Li's MIT-licensed Tian_color.py. This copy intentionally
excludes image loading, download, and raster export APIs; it accepts only
aligned NumPy arrays and exposes make_color_array/make_mono_array.

Core processing functions for a PixInsight-like RGB composition pipeline.

These functions were written against PixInsight documentation and local PCL
source files available on this machine. The key references used are:

- C:\\Program Files\\PixInsight\\doc\\tools\\BackgroundNeutralization\\BackgroundNeutralization.html
- C:\\Program Files\\PixInsight\\doc\\tools\\ColorCalibration\\ColorCalibration.html
- C:\\Program Files\\PixInsight\\doc\\tools\\HistogramTransformation\\HistogramTransformation.html
- C:\\Program Files\\PixInsight\\doc\\tools\\ScreenTransferFunction\\ScreenTransferFunction.html
- C:\\Program Files\\PixInsight\\doc\\tools\\ChannelCombination\\ChannelCombination.html
- C:\\Program Files\\PixInsight\\doc\\tools\\ChannelExtraction\\ChannelExtraction.html
- C:\\Program Files\\PixInsight\\doc\\scripts\\CorrectMagentaStars\\CorrectMagentaStars.html
- C:\\Program Files\\PixInsight\\src\\pcl\\RGBColorSystem.cpp
- C:\\Program Files\\PixInsight\\include\\pcl\\RGBColorSystem.h

Design note:
- The supported interface is:
  aligned NumPy arrays -> shared linear normalization -> PI-like color pipeline -> display-ready array.
- Pipeline summary:

  1. Shared linear input normalization

         s = 1 / max( max(R_raw), max(G_raw), max(B_raw) )
         R0 = clip(s * R_raw, 0, 1)
         G0 = clip(s * G_raw, 0, 1)
         B0 = clip(s * B_raw, 0, 1)

  2. ChannelCombination

         RGB0(x, y) = [ R0(x, y), G0(x, y), B0(x, y) ]

  3. BackgroundNeutralization

         b_ref = max(b_R, b_G, b_B)
         I'_c = I_c + (b_ref - b_c)
         I_BN = clip(s_BN * I', 0, 1)

  4. ColorCalibration

         s_c = w_c - b0
         g_c = min(s_R, s_G, s_B) / s_c
         I_CC,c = q * ( g_c * (I_BN,c - b0) + b0 )

  5. linked STF + HT transfer

         madn_c = 1.4826 * median(|I_c - median(I_c)|)
         c0 = clip(mean(med_c + shadows_clipping * madn_c), 0, 1)
         m  = x_bg * (1 - target_background) / (x_bg + target_background - 2*x_bg*target_background)
         I_STF = HT(I_CC; shadows=c0, highlights=1, midtones=m)

  6. Optionally replace CIELab lightness with stretched blue

         (L, a, b) = RGB_to_Lab(I_STF)
         I_LB = Lab_to_RGB(B_stretched, a, b)

  7. Post-HT dimming

         I_DIM = MTF(0.75, I_LB)

  8. Invert + SCNR + Invert + SCNR

         I_1 = 1 - I_DIM
         G_neutral = min(G, (R + B)/2)
         G' = (1 - amount) * G + amount * G_neutral
         I_2 = 1 - SCNR(I_1)
         I_SCNR = SCNR(I_2)

  9. Final saturation boost

         (H, S, V, L) = RGB_to_HSVL(I_SCNR)
         S' = clip(S * (1 + saturation_amount), 0, 1)
         I_final = HSVL_to_RGB(H, S', V, L)

  In short:

      aligned arrays
      -> shared linear scale
      -> BN
      -> CC
      -> linked STF/HT
      -> optionally replace L* with B
      -> HT darken
      -> SCNR cleanup
      -> saturation
      -> display-ready array
- The background ROI search is custom glue code, not a PixInsight built-in.
- Classic ColorCalibration and BN are implemented in the empirical way we
  derived while matching PI outputs, not SPCC.
- SCNR follows the AverageNeutral interpretation plus preserved CIE L*,
  which is the behavior that matched the PI reference best in our tests.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

__all__ = ["make_color_array", "make_mono_array"]


@dataclass(frozen=True)
class ComposeConfig:
    """
    Tunable parameters for the RGB pipeline.

    PI mapping:
    - `shadows_clipping` and `target_background` correspond to ScreenTransferFunction
      auto-stretch settings.
    - `bn_target_background` is the background pedestal applied after
      BackgroundNeutralization. A small positive pedestal is important for raw
      FITS images, because driving the neutralized background all the way to
      zero makes the subsequent linked STF far too aggressive.
    - `ht_dim_midtones` corresponds to a second HistogramTransformation where the
      midtones slider is moved to the right, here to 0.625.
    - `scnr1_amount` and `scnr2_amount` control the two SCNR passes.
    - `saturation_amount` is the final saturation boost.
    - `replace_luminance` controls whether the CIELab L* channel is replaced
      with the stretched blue channel before the final darkening and cleanup.
    """

    shadows_clipping: float = -2.8
    target_background: float = 0.25
    bn_target_background: float = 0.03
    ht_dim_midtones: float = 0.625
    scnr1_amount: float = 0.50
    scnr2_amount: float = 0.80
    saturation_amount: float = 0.80
    replace_luminance: bool = True


@dataclass(frozen=True)
class BackgroundReference:
    """
    Background ROI and per-channel medians used by BN/CC.

    PI mapping:
    - BackgroundNeutralization and ColorCalibration both require a background
      reference. PixInsight lets the user define this by view or ROI.
    - Here we store the ROI rectangle plus the per-channel medians derived from
      the selected background block.
    """

    rect: tuple[int, int, int, int]
    medians: np.ndarray


SRGB_X = np.array([0.648431, 0.321152, 0.155886], dtype=np.float64)
SRGB_Y = np.array([0.330856, 0.597871, 0.066044], dtype=np.float64)
SRGB_LUMA = np.array([0.222491, 0.716888, 0.060621], dtype=np.float64)

CIE_EPSILON = 216.0 / 24389.0
CIE_KAPPA_116 = 24389.0 / 3132.0


def normalize_raw_channels_common(
    red: np.ndarray,
    green: np.ndarray,
    blue: np.ndarray,
    reference_channels: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """
    Apply one shared linear scale factor to three raw FITS channels.

    PI mapping:
    - This is preprocessing glue, not a PixInsight process.
    - The goal is to accept original mono FITS inputs without doing an
      independent stretch on each channel.
    - We use one common multiplicative scale for R/G/B, so relative channel
      amplitudes are preserved before BN/CC.

    Formula:

        s = 1 / max( max(R_ref), max(G_ref), max(B_ref) )

        R_lin = min( s * R_raw, 1 )
        G_lin = min( s * G_raw, 1 )
        B_lin = min( s * B_raw, 1 )

    Notes:
    - This is a linear normalization, not a nonlinear stretch like STF/HT.
    - Negative values are preserved after the shared scaling. This matters for
      raw FITS backgrounds: clipping negative sky fluctuations to 0 would distort
      the background distribution and can make linked STF far too aggressive.
    - Only the upper end is clipped to 1 to keep obviously saturated highlights
      bounded before the later PI-like processing steps.
    - We deliberately do not normalize each channel independently, because one
      common scale preserves the raw inter-channel amplitude ratios before
      BackgroundNeutralization and ColorCalibration rebalance colors later.
    """

    if red.shape != green.shape or red.shape != blue.shape:
        raise ValueError(f"Input image shapes do not match: {red.shape}, {green.shape}, {blue.shape}")

    ref_red, ref_green, ref_blue = reference_channels or (red, green, blue)
    if ref_red.shape != ref_green.shape or ref_red.shape != ref_blue.shape:
        raise ValueError(
            f"Reference channel shapes do not match: red={ref_red.shape}, "
            f"green={ref_green.shape}, blue={ref_blue.shape}"
        )

    peak = max(float(np.nanmax(ref_red)), float(np.nanmax(ref_green)), float(np.nanmax(ref_blue)))
    if not np.isfinite(peak) or peak <= 0:
        zeros = np.zeros_like(red, dtype=np.float32)
        return zeros, zeros.copy(), zeros.copy(), 1.0

    scale = 1.0 / peak
    red_lin = np.minimum(red.astype(np.float32) * scale, 1.0)
    green_lin = np.minimum(green.astype(np.float32) * scale, 1.0)
    blue_lin = np.minimum(blue.astype(np.float32) * scale, 1.0)
    return red_lin, green_lin, blue_lin, float(scale)


def normalize_raw_channel(channel: np.ndarray) -> tuple[np.ndarray, float]:
    """
    Apply the RGB workflow's raw linear normalization to one mono band.

    Negative sky fluctuations are preserved and only the high end is clipped.
    The nonlinear display stretch is handled later by the STF/HT step.
    """

    peak = float(np.nanmax(channel))
    if not np.isfinite(peak) or peak <= 0:
        return np.zeros_like(channel, dtype=np.float32), 1.0

    scale = 1.0 / peak
    channel_lin = np.minimum(channel.astype(np.float32) * scale, 1.0)
    return channel_lin, float(scale)


def channel_avg_dev(values: np.ndarray) -> float:
    """
    Compute the average absolute deviation from the median.

    PI mapping:
    - PixInsight exposes `avgDev()` as a robust dispersion statistic.
    - We use it only in our custom ROI-selection heuristic; this is not a direct
      reimplementation of a PI module.
    """

    median = np.median(values)
    return float(np.mean(np.abs(values - median)))


def mean_channel_stats(image: np.ndarray, rect: tuple[int, int, int, int]) -> tuple[float, float]:
    """
    Average per-channel median and average deviation over an ROI.

    PI mapping:
    - Custom helper used to score candidate background blocks.
    - This mirrors the same robust statistics we queried from PI while building
      the reference workflow.
    """

    sub = roi_slice(image, rect)
    if sub.ndim == 2:
        sub = sub[..., None]
    medians = []
    avg_devs = []
    for c in range(sub.shape[2]):
        medians.append(float(np.median(sub[..., c])))
        avg_devs.append(channel_avg_dev(sub[..., c]))
    return float(np.mean(medians)), float(np.mean(avg_devs))


def roi_slice(image: np.ndarray, rect: tuple[int, int, int, int]) -> np.ndarray:
    """
    Slice an image by `(x0, y0, x1, y1)`.

    PI mapping:
    - Utility glue for ROI-based operations. PI tools often use ROI rectangles in
      this same style.
    """

    x0, y0, x1, y1 = rect
    return image[y0:y1, x0:x1]


def find_background_reference(image: np.ndarray) -> BackgroundReference:
    """
    Select a dark, flat ROI to act as the background reference.

    PI mapping:
    - This is custom logic, not a built-in PI module.
    - The goal is to automate the ROI that would normally be supplied to
      BackgroundNeutralization and ColorCalibration.
    - We scan a 6x6 grid, avoid the center, and prefer blocks with low median and
      low average deviation.
    """

    height, width = image.shape[:2]
    roi_w = min(width, max(8, int(round(width * 0.22))))
    roi_h = min(height, max(8, int(round(height * 0.22))))
    best_rect = None
    best_score = None

    for iy in range(6):
        for ix in range(6):
            x0 = int(round(ix * max(0, width - roi_w) / 5))
            y0 = int(round(iy * max(0, height - roi_h) / 5))
            rect = (x0, y0, x0 + roi_w, y0 + roi_h)
            cx = x0 + 0.5 * roi_w
            cy = y0 + 0.5 * roi_h
            dx = (cx - 0.5 * width) / max(1, width)
            dy = (cy - 0.5 * height) / max(1, height)
            if float(np.hypot(dx, dy)) < 0.12:
                continue
            median, avg_dev = mean_channel_stats(image, rect)
            score = median + 2.0 * avg_dev
            if best_score is None or score < best_score:
                best_score = score
                best_rect = rect

    if best_rect is None:
        best_rect = (0, 0, roi_w, roi_h)

    background_pixels = roi_slice(image, best_rect)
    # Keep the background reference in float64.  Downcasting this to float32
    # subtly changes BN/CC and the nonlinear STF stretch, which can erase the
    # visible J/Y/VIS colour separation between a lens and its arcs.
    medians = np.asarray(
        np.median(background_pixels.reshape(-1, 3), axis=0), dtype=np.float64
    )
    return BackgroundReference(rect=best_rect, medians=medians)


def background_neutralization(
    rgb: np.ndarray,
    background: BackgroundReference,
    target_background: float = 0.03,
    scale_reference_rgb: np.ndarray | None = None,
) -> tuple[np.ndarray, float]:
    """
    Equalize the RGB background components with a shared rescale if needed.

    PI mapping:
    - Corresponds to BackgroundNeutralization in `RescaleAsNeeded` mode.
    - PI documentation describes this process as equalizing the average red,
      green, and blue background components through per-channel linear transforms.
    - Our current empirical match uses a small positive neutral target
      background pedestal, then applies a shared scale if any channel would
      exceed 1.

    Working formula used here:

    Let b_c be the per-channel background median on the selected ROI and let
    b_ref be a small positive target pedestal, by default 0.03.

    First shift each channel toward the same background level:

        I'_c(x, y) = I_c(x, y) + (b_ref - b_c)

    Then, in the spirit of PI's `RescaleAsNeeded`, apply a common scale if the
    shifted image would overflow:

        s = 1 / max(I')   if max(I') > 1
        s = 1             otherwise

        I''_c(x, y) = s * I'_c(x, y)

    So the final output is:

        I_out = min(I'', 1)

    We intentionally do not clip the lower end here. Preserving negative or
    slightly sub-pedestal fluctuations produces a much more PI-like linked STF
    response on raw astronomical images.
    """

    shifted = rgb + (float(target_background) - background.medians.reshape(1, 1, 3))
    scale_rgb = rgb if scale_reference_rgb is None else scale_reference_rgb
    shifted_scale = scale_rgb + (float(target_background) - background.medians.reshape(1, 1, 3))
    peak = float(np.max(shifted_scale))
    scale = 1.0 / peak if peak > 1.0 else 1.0
    out = shifted * scale
    return np.minimum(out, 1.0), float(scale)


def color_calibration(
    rgb: np.ndarray,
    background: BackgroundReference,
    bn_scale: float,
    stats_rgb: np.ndarray | None = None,
) -> np.ndarray:
    """
    Apply classic ColorCalibration using the whole image as white reference.

    PI mapping:
    - Corresponds to ColorCalibration with a whole-image white reference and the
      selected ROI as background reference.
    - PI documentation states that channel factors are computed from the white
      reference and applied by multiplication.
    - Our empirical match keeps the background level fixed, scales each channel
      by the minimum white-reference signal, and uses the inverse BN scale as the
      global normalization factor.

    Working formula used here:

    Let b0 be the median background level on the background ROI after BN.
    Let w_c be the mean of channel c on the white-reference mask.
    Define the signal above background:

        s_c = w_c - b0

    Choose gains relative to the smallest channel signal so we only scale down:

        g_c = min(s_R, s_G, s_B) / s_c

    Then apply the channel calibration around the background pedestal:

        I'_c(x, y) = g_c * ( I_c(x, y) - b0 ) + b0

    Finally apply the global scale we empirically found to match PI:

        q = 1 / s_BN

        I_out,c(x, y) = q * I'_c(x, y)
    """

    stats = rgb if stats_rgb is None else stats_rgb
    bg_roi = roi_slice(stats, background.rect)
    bg_level = float(np.median(bg_roi.reshape(-1, 3), axis=0)[0])
    white_mask = (stats > 0.0).all(axis=2) & (stats < 0.98).all(axis=2)
    white_mean = stats[white_mask].mean(axis=0)
    signal = white_mean - bg_level
    gains = np.min(signal) / signal
    global_scale = 1.0 / bn_scale
    out = global_scale * (gains.reshape(1, 1, 3) * (rgb - bg_level) + bg_level)
    return np.clip(out, 0.0, 1.0)


def madn(channel: np.ndarray) -> float:
    """
    Robust sigma estimate from the median absolute deviation.

    PI mapping:
    - STF auto-stretch in PI is driven by median plus/minus a multiple of the
      robust deviation. In scripts this is commonly expressed as `MAD * 1.4826`.

    Formula:

        MAD = median( |x - median(x)| )
        MADN = 1.4826 * MAD

    The factor 1.4826 converts MAD to a Gaussian-equivalent sigma estimate.
    """

    med = np.median(channel)
    return float(np.median(np.abs(channel - med)) * 1.4826)


def mtf(m: float, x: np.ndarray) -> np.ndarray:
    """
    Evaluate PixInsight's midtones transfer function.

    PI mapping:
    - HistogramTransformation documentation defines the MTF as a rational
      function through (0,0), (m,1/2), and (1,1).
    - This is the core nonlinearity used by both STF display stretches and HT.

    Main formula for 0 < x < 1 and 0 < m < 1:

        MTF(m, x) = ((m - 1) * x) / (((2m - 1) * x) - m)

    Boundary behavior:

        x <= 0  -> 0
        x >= 1  -> 1

    Special cases:

        m = 0.5 -> identity, so MTF(0.5, x) = x
        m <= 0  -> 1 on the open interval (0, 1)
        m >= 1  -> 0 on the open interval (0, 1)

    Interpretation:

        m < 0.5  brightens midtones
        m > 0.5  darkens midtones
    """

    x = np.asarray(x, dtype=np.float64)
    out = np.empty_like(x)
    out[x <= 0] = 0.0
    out[x >= 1] = 1.0
    mid = (x > 0) & (x < 1)
    xm = x[mid]
    if abs(m - 0.5) < 1.0e-15:
        out[mid] = xm
    elif m <= 0:
        out[mid] = 1.0
    elif m >= 1:
        out[mid] = 0.0
    else:
        out[mid] = ((m - 1.0) * xm) / (((2.0 * m) - 1.0) * xm - m)
    return out


def inverse_mtf(y: float, x: float) -> float:
    """
    Solve for the midtones parameter that maps `x` to `y`.

    PI mapping:
    - STF auto-stretch chooses a target background and solves the MTF parameter
      needed to send the estimated background there.

    Inverting the MTF relation gives:

        m = x * (1 - y) / (x + y - 2xy)

    where:

        x = the current background estimate after shadows clipping
        y = the desired target background

    In our STF-style usage:

        x = mean(median_c) - c0
        y = target_background
    """

    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    denom = x + y - (2.0 * x * y)
    if abs(denom) < 1.0e-15:
        return 0.5
    return float((x * (1.0 - y)) / denom)


def histogram_transform(
    image: np.ndarray,
    shadows: float,
    highlights: float,
    midtones: float,
    range_low: float = 0.0,
    range_high: float = 1.0,
) -> np.ndarray:
    """
    Apply a PI-style histogram transformation.

    PI mapping:
    - HistogramTransformation first remaps the selected input interval into
      [0, 1], clips shadows/highlights, and then applies the MTF.
    - We keep the same parameter order used by PI's scripting interface:
      shadows, highlights, midtones, range low, range high.

    Working formula:

    1. Dynamic-range normalization:

        u = (I - range_low) / (range_high - range_low)

    2. Shadows/highlights remap:

        v = (u - shadows) / (highlights - shadows)

    3. Clamp to the unit interval:

        v_clamped = clip(v, 0, 1)

    4. Apply the midtones transfer function:

        I_out = MTF(midtones, v_clamped)

    So, compactly:

        I_out = MTF(midtones, clip(( (I - range_low)/(range_high-range_low) - shadows )
                                   /(highlights-shadows), 0, 1))
    """

    x = (image - range_low) / (range_high - range_low)
    x = np.clip(x, 0.0, 1.0)
    x = (x - shadows) / (highlights - shadows)
    x = np.clip(x, 0.0, 1.0)
    return np.clip(mtf(midtones, x), 0.0, 1.0)


def linked_auto_stf_and_ht(
    rgb: np.ndarray,
    config: ComposeConfig,
    stats_rgb: np.ndarray | None = None,
) -> np.ndarray:
    """
    Apply linked STF-style auto stretch and transfer it permanently.

    PI mapping:
    - ScreenTransferFunction documentation describes auto stretch in terms of a
      shadows clipping value in sigma units and a target background.
    - With RGB linked, all three channels share the same STF, preserving the
      color ratios established by color calibration.
    - We then transfer the resulting parameters into HistogramTransformation,
      which is how PI makes the screen stretch permanent.

    Working formula used here:

    For each channel c:

        med_c  = median(channel_c)
        madn_c = 1.4826 * median(|channel_c - med_c|)

    Linked shadows clipping point:

        c0 = clip( mean( med_c + shadows_clipping * madn_c ), 0, 1 )

    Let the clipped-background estimate be:

        x_bg = mean(med_c) - c0

    Solve the MTF parameter that maps x_bg to the desired target background:

        m = x_bg * (1 - target_background) /
            (x_bg + target_background - 2*x_bg*target_background)

    Then apply one shared HT to all three channels:

        I_out = HT(I_in; shadows=c0, highlights=1, midtones=m)
    """

    stats = rgb if stats_rgb is None else stats_rgb
    med = np.median(stats.reshape(-1, 3), axis=0)
    mad = np.array([madn(stats[..., c]) for c in range(3)], dtype=np.float64)
    c0 = float(np.clip(np.mean(med + config.shadows_clipping * mad), 0.0, 1.0))
    m = inverse_mtf(config.target_background, float(np.mean(med) - c0))
    return histogram_transform(rgb, shadows=c0, highlights=1.0, midtones=m)


def mono_auto_stf_and_ht(channel: np.ndarray, config: ComposeConfig) -> np.ndarray:
    """
    Apply the same STF-to-HT display stretch to one mono channel.

    This is the single-band version of `linked_auto_stf_and_ht`: it keeps the
    existing MTF stretch behavior but omits RGB-only color balancing.
    """

    med = float(np.median(channel))
    mad = madn(channel)
    c0 = float(np.clip(med + config.shadows_clipping * mad, 0.0, 1.0))
    m = inverse_mtf(config.target_background, med - c0)
    return histogram_transform(channel, shadows=c0, highlights=1.0, midtones=m)


def apply_post_auto_ht_darkening(rgb: np.ndarray, config: ComposeConfig) -> np.ndarray:
    """
    Apply the second HT dimming pass after the main auto stretch.

    PI mapping:
    - This is the extra HistogramTransformation pass you described as moving the
      central HT slider to the 75% position on the right.
    - In PI terms this means `midtones = 0.75`, with shadows/highlights kept at
      their identity values.

    Formula:

        I_out = MTF(0.75, I_in)

    because:

        shadows = 0
        highlights = 1
        range_low = 0
        range_high = 1

    so the surrounding histogram remap becomes the identity and only the MTF
    remains.
    """

    return histogram_transform(rgb, shadows=0.0, highlights=1.0, midtones=config.ht_dim_midtones)


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    """
    Convert sRGB-encoded values to linear RGB.

    PI mapping:
    - RGBColorSystem in PCL uses the sRGB transfer function when the working
      space is the default sRGB(D50) working space.

    Formula:

        x_linear = x / 12.92                          if x <= 0.04045
        x_linear = ((x + 0.055) / 1.055) ^ 2.4       otherwise
    """

    return np.where(x <= 0.04045, x / 12.92, np.power((x + 0.055) / 1.055, 2.4))


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    """
    Convert linear RGB values back to the sRGB transfer curve.

    PI mapping:
    - Reverse of `srgb_to_linear`, again matching PCL's RGBColorSystem behavior
      for the default sRGB working space.

    Formula:

        x_srgb = 12.92 * x                           if x <= 0.0031308
        x_srgb = 1.055 * x^(1/2.4) - 0.055          otherwise
    """

    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1.0 / 2.4) - 0.055)


def setup_rgb_to_xyz_matrix(x: np.ndarray, y: np.ndarray, y_luma: np.ndarray) -> np.ndarray:
    """
    Build the RGB -> XYZ matrix from working-space chromaticities and luma.

    PI mapping:
    - This follows the same matrix construction used in `RGBColorSystem.cpp`
      when a working space is initialized from D50 chromaticities and luminance
      coefficients.
    """

    return np.array(
        [
            [y_luma[0] * x[0] / y[0], y_luma[1] * x[1] / y[1], y_luma[2] * x[2] / y[2]],
            [y_luma[0], y_luma[1], y_luma[2]],
            [
                y_luma[0] * (1.0 - x[0] - y[0]) / y[0],
                y_luma[1] * (1.0 - x[1] - y[1]) / y[1],
                y_luma[2] * (1.0 - x[2] - y[2]) / y[2],
            ],
        ],
        dtype=np.float64,
    )


RGB_TO_XYZ = setup_rgb_to_xyz_matrix(SRGB_X, SRGB_Y, SRGB_LUMA)
XYZ_TO_RGB = np.linalg.inv(RGB_TO_XYZ)
MX = float(np.sum(RGB_TO_XYZ[0]))
MZ = float(np.sum(RGB_TO_XYZ[2]))

_X = 0.0
_Y = 1.0
_a_min = 5.0 * (
    (np.cbrt(_X) if _X > CIE_EPSILON else CIE_KAPPA_116 * _X + 16.0 / 116.0)
    - (np.cbrt(_Y) if _Y > CIE_EPSILON else CIE_KAPPA_116 * _Y + 16.0 / 116.0)
)
_X = 1.0
_Y = 0.0
_a_max = 5.0 * (
    (np.cbrt(_X) if _X > CIE_EPSILON else CIE_KAPPA_116 * _X + 16.0 / 116.0)
    - (np.cbrt(_Y) if _Y > CIE_EPSILON else CIE_KAPPA_116 * _Y + 16.0 / 116.0)
)
_Y = 0.0
_Z = 1.0
_b_min = 2.0 * (
    (np.cbrt(_Y) if _Y > CIE_EPSILON else CIE_KAPPA_116 * _Y + 16.0 / 116.0)
    - (np.cbrt(_Z) if _Z > CIE_EPSILON else CIE_KAPPA_116 * _Z + 16.0 / 116.0)
)
_Y = 1.0
_Z = 0.0
_b_max = 2.0 * (
    (np.cbrt(_Y) if _Y > CIE_EPSILON else CIE_KAPPA_116 * _Y + 16.0 / 116.0)
    - (np.cbrt(_Z) if _Z > CIE_EPSILON else CIE_KAPPA_116 * _Z + 16.0 / 116.0)
)
ZA = -_a_min
ZB = -_b_min
MA = _a_max - _a_min
MB = _b_max - _b_min


def xyz_lab_component(x: np.ndarray) -> np.ndarray:
    """
    Forward XYZ -> Lab component nonlinearity.

    PI mapping:
    - Matches `RGBColorSystem::XYZLab()` in PCL.
    """

    return np.where(x > CIE_EPSILON, np.cbrt(x), CIE_KAPPA_116 * x + 16.0 / 116.0)


def lab_xyz_component(x: np.ndarray) -> np.ndarray:
    """
    Inverse Lab -> XYZ component nonlinearity.

    PI mapping:
    - Matches `RGBColorSystem::LabXYZ()` in PCL.
    """

    x3 = x * x * x
    return np.where(x3 > CIE_EPSILON, x3, (x - 16.0 / 116.0) / CIE_KAPPA_116)


def rgb_to_xyz(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Convert RGB values to normalized CIE XYZ in the default sRGB(D50) working space.

    PI mapping:
    - Matches `RGBColorSystem::RGBToCIEXYZ()` with the default working space.

    Formula:

    1. Convert RGB to linear RGB with the sRGB transfer function.
    2. Apply the RGB->XYZ matrix M built from the sRGB(D50) primaries:

        X = clip((R*M00 + G*M01 + B*M02) / MX, 0, 1)
        Y = clip( R*M10 + G*M11 + B*M12,      0, 1)
        Z = clip((R*M20 + G*M21 + B*M22) / MZ, 0, 1)

    where MX and MZ are the same normalization factors used in PCL.
    """

    linear = srgb_to_linear(np.clip(rgb, 0.0, 1.0))
    r = linear[..., 0]
    g = linear[..., 1]
    b = linear[..., 2]
    x = np.clip((r * RGB_TO_XYZ[0, 0] + g * RGB_TO_XYZ[0, 1] + b * RGB_TO_XYZ[0, 2]) / MX, 0.0, 1.0)
    y = np.clip(r * RGB_TO_XYZ[1, 0] + g * RGB_TO_XYZ[1, 1] + b * RGB_TO_XYZ[1, 2], 0.0, 1.0)
    z = np.clip((r * RGB_TO_XYZ[2, 0] + g * RGB_TO_XYZ[2, 1] + b * RGB_TO_XYZ[2, 2]) / MZ, 0.0, 1.0)
    return x, y, z


def xyz_to_rgb(x: np.ndarray, y: np.ndarray, z: np.ndarray) -> np.ndarray:
    """
    Convert normalized CIE XYZ values back to RGB in sRGB(D50).

    PI mapping:
    - Matches `RGBColorSystem::CIEXYZToRGB()` in PCL.

    Formula:

    1. Undo the PCL X/Z normalization:

        X' = MX * X
        Z' = MZ * Z

    2. Apply the inverse matrix M^(-1):

        R_lin = clip(X'*M'00 + Y*M'01 + Z'*M'02, 0, 1)
        G_lin = clip(X'*M'10 + Y*M'11 + Z'*M'12, 0, 1)
        B_lin = clip(X'*M'20 + Y*M'21 + Z'*M'22, 0, 1)

    3. Reapply the sRGB transfer curve.
    """

    x = x * MX
    z = z * MZ
    r = np.clip(x * XYZ_TO_RGB[0, 0] + y * XYZ_TO_RGB[0, 1] + z * XYZ_TO_RGB[0, 2], 0.0, 1.0)
    g = np.clip(x * XYZ_TO_RGB[1, 0] + y * XYZ_TO_RGB[1, 1] + z * XYZ_TO_RGB[1, 2], 0.0, 1.0)
    b = np.clip(x * XYZ_TO_RGB[2, 0] + y * XYZ_TO_RGB[2, 1] + z * XYZ_TO_RGB[2, 2], 0.0, 1.0)
    return np.stack([linear_to_srgb(r), linear_to_srgb(g), linear_to_srgb(b)], axis=-1)


def rgb_to_lab(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Convert RGB to normalized CIE L*, a*, b*.

    PI mapping:
    - Matches ChannelExtraction in CIELab mode and the underlying
      `RGBColorSystem::RGBToCIELab()` path.
    - L* is perceptual lightness; a* and b* carry chrominance.

    Formula:

    First compute normalized XYZ, then apply the Lab component nonlinearity:

        f(t) = t^(1/3)                    if t > epsilon
        f(t) = kappa116 * t + 16/116      otherwise

    Denoting:

        Xf = f(X), Yf = f(Y), Zf = f(Z)

    PCL normalizes Lab into [0, 1] as:

        L = clip(1.16 * Yf - 0.16, 0, 1)
        a = clip((5 * (Xf - Yf) + ZA) / MA, 0, 1)
        b = clip((2 * (Yf - Zf) + ZB) / MB, 0, 1)
    """

    x, y, z = rgb_to_xyz(rgb)
    x = xyz_lab_component(x)
    y = xyz_lab_component(y)
    z = xyz_lab_component(z)
    lightness = np.clip((1.16 * y) - 0.16, 0.0, 1.0)
    a = np.clip((5.0 * (x - y) + ZA) / MA, 0.0, 1.0)
    b = np.clip((2.0 * (y - z) + ZB) / MB, 0.0, 1.0)
    return lightness, a, b


def lab_to_rgb(lightness: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """
    Convert normalized CIE L*, a*, b* back to RGB.

    PI mapping:
    - Matches ChannelCombination in CIELab mode and the underlying
      `RGBColorSystem::CIELabToRGB()` path.

    Inverse formula:

        Yf = (L + 0.16) / 1.16
        Xf = (MA * a - ZA) / 5 + Yf
        Zf = Yf - (MB * b - ZB) / 2

    Then invert the Lab component function:

        t = f^(-1)(tf)

    and convert XYZ back to RGB through the inverse working-space transform.
    """

    y = (lightness + 0.16) / 1.16
    x = (MA * a - ZA) / 5.0 + y
    z = y - (MB * b - ZB) / 2.0
    x = lab_xyz_component(x)
    y = lab_xyz_component(y)
    z = lab_xyz_component(z)
    return np.clip(xyz_to_rgb(x, y, z), 0.0, 1.0)


def replace_lab_l_with_blue(rgb: np.ndarray, blue: np.ndarray) -> np.ndarray:
    """
    Replace the CIELab L* channel with the stretched blue channel.

    PI mapping:
    - Equivalent to extracting CIELab, swapping L with B, and recombining.
    - This preserves the original chrominance (a*, b*) while forcing the image
      lightness structure to follow the blue channel.

    Formula:

        (L, a, b) = RGB_to_Lab(RGB)
        L' = B_stretched
        RGB_out = Lab_to_RGB(L', a, b)
    """

    _, a, b = rgb_to_lab(rgb)
    return lab_to_rgb(blue, a, b)


def rgb_to_hsv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Convert RGB to HSV.

    PI mapping:
    - Matches the helper routines in `RGBColorSystem.h`.
    - Used here because the final saturation boost behaves like an HSV/HSVL
      operation rather than a straight RGB scale.
    """

    r = rgb[..., 0]
    g = rgb[..., 1]
    b = rgb[..., 2]
    v = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    delta = v - mn
    h = np.zeros_like(v)
    s = np.zeros_like(v)
    nz = delta != 0
    s[nz] = delta[nz] / v[nz]
    red = nz & (r == v)
    green = nz & (g == v)
    blue = nz & (b == v)
    h[red] = (g[red] - b[red]) / delta[red]
    h[green] = 2.0 + (b[green] - r[green]) / delta[green]
    h[blue] = 4.0 + (r[blue] - g[blue]) / delta[blue]
    h /= 6.0
    h[h < 0] += 1.0
    return h, s, v


def hsv_to_rgb(h: np.ndarray, s: np.ndarray, v: np.ndarray) -> np.ndarray:
    """
    Convert HSV back to RGB.

    PI mapping:
    - Matches the sector-based `HSVToRGB()` implementation in `RGBColorSystem.h`.
    """

    r = np.empty_like(v)
    g = np.empty_like(v)
    b = np.empty_like(v)
    achromatic = s == 0
    r[achromatic] = v[achromatic]
    g[achromatic] = v[achromatic]
    b[achromatic] = v[achromatic]
    chromatic = ~achromatic
    h6 = h[chromatic] * 6.0
    i = np.floor(h6).astype(np.int32)
    f = h6 - i
    p = v[chromatic] * (1.0 - s[chromatic])
    q = v[chromatic] * (1.0 - s[chromatic] * f)
    t = v[chromatic] * (1.0 - s[chromatic] * (1.0 - f))
    rc = np.empty_like(h6)
    gc = np.empty_like(h6)
    bc = np.empty_like(h6)
    for sector in range(6):
        mask = i == sector
        if sector == 0:
            rc[mask], gc[mask], bc[mask] = v[chromatic][mask], t[mask], p[mask]
        elif sector == 1:
            rc[mask], gc[mask], bc[mask] = q[mask], v[chromatic][mask], p[mask]
        elif sector == 2:
            rc[mask], gc[mask], bc[mask] = p[mask], v[chromatic][mask], t[mask]
        elif sector == 3:
            rc[mask], gc[mask], bc[mask] = p[mask], q[mask], v[chromatic][mask]
        elif sector == 4:
            rc[mask], gc[mask], bc[mask] = t[mask], p[mask], v[chromatic][mask]
        else:
            rc[mask], gc[mask], bc[mask] = v[chromatic][mask], p[mask], q[mask]
    r[chromatic] = rc
    g[chromatic] = gc
    b[chromatic] = bc
    return np.stack([r, g, b], axis=-1)


def rgb_to_hsvl(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Convert RGB to HSV plus preserved CIE L*.

    PI mapping:
    - Matches the idea of PCL's `RGBToHSVL()`: HSV channels plus the CIE L*
      component from the current RGB working space.
    """

    h, s, v = rgb_to_hsv(rgb)
    lightness, _, _ = rgb_to_lab(rgb)
    return h, s, v, lightness


def hsvl_to_rgb(
    h: np.ndarray, s: np.ndarray, v: np.ndarray, lightness: np.ndarray
) -> np.ndarray:
    """
    Convert HSVL back to RGB.

    PI mapping:
    - Matches the logic of `HSVLToRGB()` in `RGBColorSystem.h`: rebuild RGB from
      HSV, then restore the desired CIE L* component.
    """

    rgb = hsv_to_rgb(h, s, v)
    _, a, b = rgb_to_lab(rgb)
    return lab_to_rgb(lightness, a, b)


def invert(rgb: np.ndarray) -> np.ndarray:
    """
    Apply an invert transform, `1 - x`.

    PI mapping:
    - Corresponds directly to PixInsight's Invert process.
    - Used here to turn magenta excess into green excess before SCNR.
    """

    return 1.0 - rgb


def scnr_average_neutral(rgb: np.ndarray, amount: float) -> np.ndarray:
    """
    Remove green using AverageNeutral SCNR semantics, then preserve CIE L*.

    PI mapping:
    - Corresponds to SCNR with `colorToRemove = Green` and
      `protectionMethod = AverageNeutral`.
    - The core neutral estimate is `(R + B) / 2`, so excess green is pushed back
      toward that neutral value.
    - CorrectMagentaStars uses the pattern `Invert -> SCNR Green -> Invert`.
    - Our best PI match is: partial AverageNeutral reduction plus restoration of
      the original CIE L* component.

    Core AverageNeutral formula:

        G_neutral = min(G, (R + B)/2)

    With partial strength `amount`:

        G' = G + amount * (G_neutral - G)

    or equivalently:

        G' = (1 - amount) * G + amount * G_neutral

    Then we preserve the original CIE lightness:

        (L0, _, _) = RGB_to_Lab(RGB_in)
        (_, a1, b1) = RGB_to_Lab(R, G', B)
        RGB_out = Lab_to_RGB(L0, a1, b1)
    """

    r = rgb[..., 0]
    g = rgb[..., 1]
    b = rgb[..., 2]
    neutral_g = np.minimum(g, 0.5 * (r + b))
    g_out = g + amount * (neutral_g - g)
    out = np.stack([r, g_out, b], axis=-1)
    l0, _, _ = rgb_to_lab(rgb)
    _, a1, b1 = rgb_to_lab(out)
    return lab_to_rgb(l0, a1, b1)


def color_saturation_hsvl(rgb: np.ndarray, amount: float) -> np.ndarray:
    """
    Apply a global saturation boost while preserving CIE L*.

    PI mapping:
    - This is our Python analogue of the final ColorSaturation step.
    - The implementation is closest to an HSVL interpretation: scale the
      saturation channel, then restore the original CIE L* on reconstruction.

    Formula:

        (H, S, V, L) = RGB_to_HSVL(RGB)
        S' = clip(S * (1 + amount), 0, 1)
        RGB_out = HSVL_to_RGB(H, S', V, L)

    So for `amount = 0.40`:

        S' = clip(1.4 * S, 0, 1)
    """

    h, s, v, lightness = rgb_to_hsvl(rgb)
    s_out = np.clip(s * (1.0 + amount), 0.0, 1.0)
    return np.clip(hsvl_to_rgb(h, s_out, v, lightness), 0.0, 1.0)


def compose_pipeline(
    red: np.ndarray,
    green: np.ndarray,
    blue: np.ndarray,
    config: ComposeConfig | None = None,
    reference_rgb: np.ndarray | None = None,
) -> dict[str, np.ndarray]:
    """
    Run the full RGB processing pipeline and return all named outputs.

    PI mapping:
    - ChannelCombination: stack `red`, `green`, `blue` into RGB.
    - BackgroundNeutralization
    - ColorCalibration
    - linked STF + HT transfer
    - optionally replace Lab L* with stretched blue
    - post-HT dimming (`midtones = 0.75`)
    - invert / SCNR / invert / SCNR
    - final ColorSaturation boost
    """

    if config is None:
        config = ComposeConfig()

    if red.shape != green.shape or red.shape != blue.shape:
        raise ValueError(f"Input image shapes do not match: {red.shape}, {green.shape}, {blue.shape}")

    rgb = np.stack([red, green, blue], axis=-1)
    stats_rgb = rgb if reference_rgb is None else np.asarray(reference_rgb, dtype=np.float32)
    if stats_rgb.ndim != 3 or stats_rgb.shape[-1] != 3:
        raise ValueError(f"reference_rgb must have shape (H, W, 3), got {stats_rgb.shape}")

    background = find_background_reference(stats_rgb)
    bn, bn_scale = background_neutralization(
        rgb,
        background,
        target_background=config.bn_target_background,
        scale_reference_rgb=stats_rgb,
    )
    if reference_rgb is None:
        bn_stats = bn
    else:
        bn_stats, _ = background_neutralization(
            stats_rgb,
            background,
            target_background=config.bn_target_background,
        )
    cc = color_calibration(bn, background, bn_scale, stats_rgb=bn_stats)
    cc_stats = cc if reference_rgb is None else color_calibration(
        bn_stats,
        background,
        bn_scale,
        stats_rgb=bn_stats,
    )
    stfht = linked_auto_stf_and_ht(cc, config, stats_rgb=cc_stats)
    blue_channel = stfht[..., 2]
    lab_l, lab_a, lab_b = rgb_to_lab(stfht)
    if config.replace_luminance:
        lfromb = replace_lab_l_with_blue(stfht, blue_channel)
    else:
        lfromb = stfht
    htdim = apply_post_auto_ht_darkening(lfromb, config)
    invert1 = invert(htdim)
    scnr1 = scnr_average_neutral(invert1, config.scnr1_amount)
    invert2 = invert(scnr1)
    scnr2 = scnr_average_neutral(invert2, config.scnr2_amount)
    final = color_saturation_hsvl(scnr2, config.saturation_amount)
    return {
        "01_rgb.tif": rgb,
        "02_bn.tif": bn,
        "03_cc.tif": cc,
        "04_stfht.tif": stfht,
        "05_blue.tif": blue_channel,
        "06_lab_L.tif": lab_l,
        "06_lab_a.tif": lab_a,
        "06_lab_b.tif": lab_b,
        "07_lfromb.tif": lfromb,
        "08_htdim.tif": htdim,
        "09_invert1.tif": invert1,
        "10_scnr1.tif": scnr1,
        "11_invert2.tif": invert2,
        "12_scnr2.tif": scnr2,
        "13_final.tif": final,
    }


def compose_mono_pipeline(channel: np.ndarray, config: ComposeConfig | None = None) -> dict[str, np.ndarray]:
    """
    Run the mono MTF processing path and return named outputs.

    This mirrors the non-color part of `compose_pipeline`:
    one normalized channel -> STF/HT stretch -> post-HT dimming -> final mono
    image. RGB-only steps such as BN/CC, Lab luminance replacement, SCNR, and
    saturation are intentionally omitted.
    """

    if config is None:
        config = ComposeConfig()

    mono = np.asarray(channel, dtype=np.float32)
    if mono.ndim != 2:
        raise ValueError(f"Expected a 2D mono image, got shape {mono.shape}")

    stfht = mono_auto_stf_and_ht(mono, config)
    htdim = apply_post_auto_ht_darkening(stfht, config)
    final = np.clip(htdim, 0.0, 1.0)
    return {
        "01_mono.tif": mono,
        "02_stfht.tif": stfht,
        "03_htdim.tif": htdim,
        "13_final.tif": final,
    }


def _center_reference_channels(
    red: np.ndarray,
    green: np.ndarray,
    blue: np.ndarray,
    reference_ROI: int | None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """
    Return a centered square reference ROI for estimating display parameters.
    """

    if reference_ROI is None:
        return None
    if isinstance(reference_ROI, bool) or not isinstance(reference_ROI, int):
        raise TypeError("reference_ROI must be an integer pixel size or None.")
    if reference_ROI <= 0:
        raise ValueError("reference_ROI must be a positive integer.")

    height, width = red.shape
    if reference_ROI > height or reference_ROI > width:
        raise ValueError(f"reference_ROI={reference_ROI} is larger than the image shape {red.shape}.")

    y0 = (height - reference_ROI) // 2
    x0 = (width - reference_ROI) // 2
    y1 = y0 + reference_ROI
    x1 = x0 + reference_ROI
    return (
        np.ascontiguousarray(red[y0:y1, x0:x1], dtype=np.float32),
        np.ascontiguousarray(green[y0:y1, x0:x1], dtype=np.float32),
        np.ascontiguousarray(blue[y0:y1, x0:x1], dtype=np.float32),
    )


class TianColorMaker:
    """
    Small convenience wrapper around the local MTF workflow.

    It accepts one RGB NumPy array with shape `(H, W, 3)`, or three aligned
    mono NumPy arrays in `(R, G, B)` order, and returns a display-ready array.
    """

    def __init__(self, config: ComposeConfig | None = None):
        self.config = config or ComposeConfig()

    def render_array(
        self,
        rgb_image: np.ndarray | list[np.ndarray] | tuple[np.ndarray, ...],
        *,
        input_mode: str = "auto",
        reference_ROI: int | None = None,
    ) -> np.ndarray:
        """Render RGB inputs to a display-ready float32 array."""

        red, green, blue = _split_input_rgb_channels(rgb_image)
        if not all(np.all(np.isfinite(channel)) for channel in (red, green, blue)):
            raise ValueError("RGB inputs must contain only finite pixel values.")
        mode = _resolve_input_mode(red, green, blue, input_mode)
        reference_channels = _center_reference_channels(red, green, blue, reference_ROI)

        if mode == "raw":
            red_work, green_work, blue_work, _ = normalize_raw_channels_common(
                red,
                green,
                blue,
                reference_channels=reference_channels,
            )
            if reference_channels is None:
                reference_rgb = None
            else:
                ref_red_work, ref_green_work, ref_blue_work, _ = normalize_raw_channels_common(*reference_channels)
                reference_rgb = np.stack([ref_red_work, ref_green_work, ref_blue_work], axis=-1)
        else:
            red_work = np.clip(np.asarray(red, dtype=np.float32), 0.0, 1.0)
            green_work = np.clip(np.asarray(green, dtype=np.float32), 0.0, 1.0)
            blue_work = np.clip(np.asarray(blue, dtype=np.float32), 0.0, 1.0)
            if reference_channels is None:
                reference_rgb = None
            else:
                ref_red, ref_green, ref_blue = reference_channels
                reference_rgb = np.stack(
                    [
                        np.clip(np.asarray(ref_red, dtype=np.float32), 0.0, 1.0),
                        np.clip(np.asarray(ref_green, dtype=np.float32), 0.0, 1.0),
                        np.clip(np.asarray(ref_blue, dtype=np.float32), 0.0, 1.0),
                    ],
                    axis=-1,
                )

        outputs = compose_pipeline(red_work, green_work, blue_work, config=self.config, reference_rgb=reference_rgb)
        return np.asarray(outputs["13_final.tif"], dtype=np.float32)

class TianMonoMaker:
    """
    Convenience wrapper for one-band MTF display images.

    It accepts one 2D NumPy array and returns a display-ready grayscale array.
    """

    def __init__(self, config: ComposeConfig | None = None):
        self.config = config or ComposeConfig()

    def render_array(
        self,
        mono_image: np.ndarray,
        *,
        input_mode: str = "auto",
    ) -> np.ndarray:
        """Render one mono input to a display-ready float32 array."""

        mono = _load_single_channel(mono_image)
        if not np.all(np.isfinite(mono)):
            raise ValueError("Mono input must contain only finite pixel values.")
        mode = _resolve_mono_input_mode(mono, input_mode)

        if mode == "raw":
            mono_work, _ = normalize_raw_channel(mono)
        else:
            mono_work = np.clip(np.asarray(mono, dtype=np.float32), 0.0, 1.0)

        outputs = compose_mono_pipeline(mono_work, config=self.config)
        return np.asarray(outputs["13_final.tif"], dtype=np.float32)

def _split_input_rgb_channels(
    rgb_image: np.ndarray | list[np.ndarray] | tuple[np.ndarray, ...]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Normalize the supported user inputs into three 2D channel arrays.
    """

    if isinstance(rgb_image, np.ndarray):
        return _split_rgb_array(rgb_image)

    if not isinstance(rgb_image, (list, tuple)) or len(rgb_image) != 3:
        raise ValueError("rgb_image sequence must contain exactly three channels in R/G/B order.")

    red = _load_single_channel(rgb_image[0])
    green = _load_single_channel(rgb_image[1])
    blue = _load_single_channel(rgb_image[2])
    _validate_matching_shapes(red, green, blue)
    return red, green, blue


def _split_rgb_array(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Split one RGB array into three float32 channels.
    """

    array = np.asarray(rgb)
    if array.ndim != 3 or array.shape[-1] < 3:
        raise ValueError(f"Expected an RGB image with shape (H, W, 3), got {array.shape}")

    array = array[..., :3]
    if np.issubdtype(array.dtype, np.integer):
        max_value = float(np.iinfo(array.dtype).max)
        array = array.astype(np.float32) / max_value
    else:
        array = array.astype(np.float32)

    red = array[..., 0]
    green = array[..., 1]
    blue = array[..., 2]
    _validate_matching_shapes(red, green, blue)
    return red, green, blue


def _load_single_channel(source: np.ndarray) -> np.ndarray:
    if not isinstance(source, np.ndarray):
        raise TypeError("vendored STCI array API accepts NumPy arrays only")
    image = np.asarray(source, dtype=np.float32)
    if image.ndim != 2:
        raise ValueError(f"Expected a 2D array, got shape {image.shape}")
    return np.ascontiguousarray(image)


def _validate_matching_shapes(red: np.ndarray, green: np.ndarray, blue: np.ndarray) -> None:
    """
    Ensure all three channels have the same image shape.
    """

    if red.shape != green.shape or red.shape != blue.shape:
        raise ValueError(
            f"Input channel shapes do not match: red={red.shape}, green={green.shape}, blue={blue.shape}"
        )


def _resolve_input_mode(red: np.ndarray, green: np.ndarray, blue: np.ndarray, input_mode: str) -> str:
    """
    Decide whether the input should be treated as raw science data or as
    already-normalized display RGB.
    """

    if input_mode not in {"auto", "raw", "normalized"}:
        raise ValueError("input_mode must be one of: 'auto', 'raw', 'normalized'")

    if input_mode != "auto":
        return input_mode

    peak = max(float(np.nanmax(red)), float(np.nanmax(green)), float(np.nanmax(blue)))
    floor = min(float(np.nanmin(red)), float(np.nanmin(green)), float(np.nanmin(blue)))
    if floor < 0.0 or peak > 1.0:
        return "raw"
    return "normalized"


def _resolve_mono_input_mode(channel: np.ndarray, input_mode: str) -> str:
    """
    Decide whether one mono channel is raw science data or already normalized.
    """

    if input_mode not in {"auto", "raw", "normalized"}:
        raise ValueError("input_mode must be one of: 'auto', 'raw', 'normalized'")

    if input_mode != "auto":
        return input_mode

    peak = float(np.nanmax(channel))
    floor = float(np.nanmin(channel))
    if floor < 0.0 or peak > 1.0:
        return "raw"
    return "normalized"


def make_color_array(
    rgb_image: np.ndarray | list[np.ndarray] | tuple[np.ndarray, ...],
    *,
    input_mode: str = "auto",
    ReplaceL: bool | None = None,
    reference_ROI: int | None = None,
    config: ComposeConfig | None = None,
) -> np.ndarray:
    """Build one MTF color image and return it as a float32 RGB array."""

    if ReplaceL is not None:
        config = replace(config or ComposeConfig(), replace_luminance=bool(ReplaceL))

    maker = TianColorMaker(config=config)
    return maker.render_array(
        rgb_image,
        input_mode=input_mode,
        reference_ROI=reference_ROI,
    )


def make_mono_array(
    mono_image: np.ndarray,
    *,
    input_mode: str = "auto",
    config: ComposeConfig | None = None,
) -> np.ndarray:
    """Build one MTF grayscale image and return it as a float32 array."""

    maker = TianMonoMaker(config=config)
    return maker.render_array(mono_image, input_mode=input_mode)
