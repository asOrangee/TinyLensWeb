"""Generate explicitly synthetic, reproducible lens-viewer fixtures.

These assets are illustrative SIS-like ray-traced simulations, never TinyLens
results. Data and model share one intensity stretch with the magma colormap;
residuals retain a fixed [-3, 3] blue-white-red noise-unit colour scale.
Per-pixel chi-square uses the same blue-white-red palette over [0, 9].
No external image or user data is used.
"""
from pathlib import Path
import argparse
import hashlib
import json
import numpy as np
from PIL import Image
from matplotlib import colormaps

ROOT = Path(__file__).resolve().parents[1] / "public" / "demo"
ROOT.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--preflight-only', action='store_true', help='Generate input diagnostics without replacing existing model-viewer PNGs.')
parser.add_argument('--include-preflight', action='store_true', help='Also generate input diagnostics; requires Astropy.')
parser.add_argument('--display-metadata-only', action='store_true', help='Update display range metadata without replacing any PNG.')
args = parser.parse_args()
if args.display_metadata_only and (args.preflight_only or args.include_preflight):
    parser.error('--display-metadata-only cannot be combined with image-generation options')
MAGMA = colormaps['magma']
INTENSITY_VMIN, INTENSITY_VMAX, ASINH_A = 0.0, 0.93, 25.0
RESIDUAL_VMIN, RESIDUAL_VMAX = -3.0, 3.0
CHI2_VMIN, CHI2_VMAX = 0.0, max(abs(RESIDUAL_VMIN), abs(RESIDUAL_VMAX)) ** 2
RESIDUAL_STOPS = [[27, 76, 112], [87, 145, 172], [179, 207, 217], [243, 242, 237], [226, 190, 174], [188, 111, 91], [123, 38, 39]]
N = 512
axis = np.linspace(-4, 4, N)
x, y = np.meshgrid(axis, axis[::-1])
rng = np.random.default_rng(107)


def gaussian_weights(sigma):
    n = int(np.ceil(sigma * 4))
    p = np.arange(-n, n + 1)
    w = np.exp(-p * p / (2 * sigma * sigma))
    w /= w.sum()
    return w


def blur(a, sigma=1.1):
    # Deterministic separable convolution; the same kernel is shown as the PSF.
    w = gaussian_weights(sigma)
    b = np.apply_along_axis(lambda row: np.convolve(row, w, mode="same"), 0, a)
    return np.apply_along_axis(lambda row: np.convolve(row, w, mode="same"), 1, b)


def source(u, v):
    a = (u - .09) * .9 + (v - .045) * .43
    b = -(u - .09) * .43 + (v - .045) * .9
    broad = .29 * np.exp(-.5 * ((a / .19) ** 2 + (b / .085) ** 2))
    clump1 = .25 * np.exp(-.5 * (((u + .055) / .05) ** 2 + ((v + .015) / .04) ** 2))
    clump2 = .20 * np.exp(-.5 * (((u - .20) / .058) ** 2 + ((v - .10) / .035) ** 2))
    return broad + clump1 + clump2


# Shared with the frontend hover mapping. This is an illustrative potential,
# not the SIE mass-density profile or a fitted pipeline result.
mapping_path = ROOT.parents[1] / 'src' / 'data' / 'lens-mapping-demo.json'
mapping = json.loads(mapping_path.read_text())
mass = mapping['model']
phi = mass['position_angle_rad']
q = mass['potential_axis_ratio']
b = mass['normalization_arcsec']
g1, g2 = mass['shear_gamma1'], mass['shear_gamma2']
xp = x * np.cos(phi) + y * np.sin(phi)
yp = -x * np.sin(phi) + y * np.cos(phi)
ell = np.sqrt(q * xp * xp + yp * yp / q + mass['softening_squared_arcsec2'])
axp = b * q * xp / ell
ayp = b * yp / q / ell
ax = axp * np.cos(phi) - ayp * np.sin(phi) + g1 * x + g2 * y
ay = axp * np.sin(phi) + ayp * np.cos(phi) + g2 * x - g1 * y
arc = source(x - ax, y - ay)
galaxy_r = np.sqrt((xp / .70) ** 2 + (yp / .49) ** 2 + .03 ** 2)
galaxy = .65 * np.exp(-galaxy_r * 1.3) + .5 * np.exp(-.5 * ((xp / .14) ** 2 + (yp / .11) ** 2))
model = blur(arc + galaxy, 1.05)
sigma = .0065
# Small structured discrepancy is included only to demonstrate residual tools.
defect = .007 * np.exp(-.5 * (((x - 1.22) / .18) ** 2 + ((y - 1.12) / .14) ** 2))
noise = rng.normal(0, sigma, model.shape)
observation = model + noise + defect
residual = (observation - model) / sigma
# Per-pixel contribution to chi-square, before any display clipping. This is
# neither a reduced chi-square statistic nor a square of the rendered PNG.
chi_square = residual ** 2


def colour(a, stops):
    stops = np.array(stops, dtype=float)
    xp = np.linspace(0, 1, len(stops))
    return np.uint8(np.stack([np.interp(a, xp, stops[:, i]) for i in range(3)], -1).clip(0, 255))


def intensity(a):
    normalized = np.arcsinh(np.clip(a - INTENSITY_VMIN, 0, None) * ASINH_A) / np.arcsinh(ASINH_A * (INTENSITY_VMAX - INTENSITY_VMIN))
    return MAGMA(np.clip(normalized, 0, 1), bytes=True)[..., :3]


def residual_colour(a):
    normalized = np.clip((a - RESIDUAL_VMIN) / (RESIDUAL_VMAX - RESIDUAL_VMIN), 0, 1)
    return colour(normalized, RESIDUAL_STOPS)


def chi_square_colour(a):
    normalized = np.clip((a - CHI2_VMIN) / (CHI2_VMAX - CHI2_VMIN), 0, 1)
    return colour(normalized, RESIDUAL_STOPS)

u, v = np.meshgrid(np.linspace(-.8, .8, N), np.linspace(.8, -.8, N))
model_planes = {
    'observation': observation, 'model': model, 'residual': residual,
    'lens-light': galaxy, 'source-lensed': blur(arc, 1.05), 'source': source(u, v),
    'chi-square': chi_square,
}
if not args.preflight_only and not args.display_metadata_only:
    Image.fromarray(intensity(observation)).save(ROOT / "observation.png")
    Image.fromarray(intensity(model)).save(ROOT / "model.png")
    Image.fromarray(residual_colour(residual)).save(ROOT / "residual.png")
    Image.fromarray(intensity(model_planes['source'])).save(ROOT / "source.png")
    Image.fromarray(intensity(model_planes['source-lensed'])).save(ROOT / "source-lensed.png")
    Image.fromarray(intensity(galaxy)).save(ROOT / "lens-light.png")
    Image.fromarray(chi_square_colour(chi_square)).save(ROOT / 'chi-square.png')
if not args.display_metadata_only:
    Image.fromarray(MAGMA(np.linspace(0, 1, 256)[None, :], bytes=True)[..., :3]).save(ROOT / 'magma-colorbar.png')

display_manifest = {
    'schema': 'tinylens-science-display-demo.v1', 'synthetic': True,
    'generator': 'scripts/generate_demo.py', 'planes': {},
    'chi_square_definition': '((data - model) / noise_rms) ** 2; per-pixel contribution, not reduced chi-square',
}
for name, values in model_planes.items():
    is_residual = name == 'residual'
    is_chi_square = name == 'chi-square'
    if args.display_metadata_only:
        expected_pixels = residual_colour(values) if is_residual else chi_square_colour(values) if is_chi_square else intensity(values)
        if not np.array_equal(np.asarray(Image.open(ROOT / f'{name}.png')), expected_pixels):
            raise RuntimeError(f'{name}.png does not match these display limits. Regenerate the previews before updating metadata.')
    center_half_extent = 0.8 if name == 'source' else 4.0
    pixel_scale = 2 * center_half_extent / (N - 1)
    display_manifest['planes'][name] = {
        'src': f'/demo/{name}.png', 'shape': list(values.shape),
        'vmin': RESIDUAL_VMIN if is_residual else CHI2_VMIN if is_chi_square else INTENSITY_VMIN,
        'vmax': RESIDUAL_VMAX if is_residual else CHI2_VMAX if is_chi_square else INTENSITY_VMAX,
        'data_min': float(values.min()), 'data_max': float(values.max()),
        'stretch': 'linear' if is_residual or is_chi_square else 'asinh',
        'asinh_a': None if is_residual or is_chi_square else ASINH_A,
        'colormap': 'blue-white-red' if is_residual or is_chi_square else 'magma',
        'unit': 'ΔI / σ' if is_residual else 'χ² per pixel' if is_chi_square else 'a.u.',
        'half_extent_arcsec': center_half_extent + pixel_scale / 2,
        'pixel_scale_arcsec': pixel_scale,
        'sha256': hashlib.sha256((ROOT / f'{name}.png').read_bytes()).hexdigest(),
    }
(ROOT / 'science-display.json').write_text(json.dumps(display_manifest, indent=2) + '\n')
(ROOT.parents[1] / 'src' / 'data' / 'science-demo.json').write_text(json.dumps(display_manifest, indent=2) + '\n')
mapping['frames'] = {space: {'shape': display_manifest['planes'][plane]['shape'], 'half_extent_arcsec': display_manifest['planes'][plane]['half_extent_arcsec']} for space, plane in [('image', 'model'), ('source', 'source')]}
mapping['images'] = {name: {'src': plane['src'], 'sha256': plane['sha256']} for name, plane in display_manifest['planes'].items()}
mapping_path.write_text(json.dumps(mapping, indent=2) + '\n')
(ROOT / 'lens-mapping.json').write_text(json.dumps(mapping, indent=2) + '\n')

provenance = {
    "kind": "synthetic-demo", "seed": 107, "generator": "scripts/generate_demo.py",
    "description": "Illustrative isothermal-potential ray tracing, not an inference result or real observation.",
    "image_extent_arcsec": [-4, 4, -4, 4], "source_extent_arcsec": [-.8, .8, -.8, .8],
    "image_shape": [N, N], "display_units": "arbitrary", "residual_range_sigma": [-3, 3],
    "noise_sigma_arbitrary_units": sigma, "same_data_model_stretch": True,
    "intensity_colormap": "magma", "residual_colormap": "blue-white-red",
    "chi_square_colormap": "blue-white-red", "chi_square_display_range": [CHI2_VMIN, CHI2_VMAX],
    "science_display_manifest": "science-display.json",
}


def generate_preflight():
    import astropy
    from astropy.visualization import LogStretch, ZScaleInterval

    output = ROOT / 'preflight'
    output.mkdir(exist_ok=True)
    pixel_scale = float(axis[1] - axis[0])
    weights = gaussian_weights(1.05)
    psf = np.outer(weights, weights)
    arrays = {'data': observation, 'noise': np.full_like(observation, sigma), 'snr': observation / sigma, 'psf': psf}
    # Retain numerical inputs for auditing the rendered demo fixtures. This is
    # the RMS map, not the random noise realization added to the synthetic data.
    np.savez_compressed(output / 'inputs.npz', data=observation, noise=arrays['noise'], snr=arrays['snr'], psf=psf)
    manifest = {
        'schema': 'tinylens-preflight-demo.v1', 'synthetic': True,
        'generator': 'scripts/generate_demo.py --preflight-only',
        'astropy_version': astropy.__version__, 'log_a': 1000.0, 'colormap': 'magma',
        'zscale': {'n_samples': 1000, 'contrast': 0.25},
        'snr_definition': 'data / noise_rms', 'noise_definition': 'constant 1-sigma RMS',
        'psf_definition': 'Normalized separable Gaussian kernel used by blur(..., 1.05).',
        'pixel_scale_arcsec': pixel_scale, 'x_direction': 'increasing', 'y_direction': 'decreasing',
        'coordinates': 'Local x/y; pixel-edge bounds, not celestial RA/Dec.',
        'planes': [],
    }
    for key, values in arrays.items():
        lo, hi = float(values.min()), float(values.max())
        constant = lo == hi
        zlo, zhi = map(float, ZScaleInterval(n_samples=1000, contrast=0.25).get_limits(values))
        plane = {
            'id': key, 'shape': list(values.shape), 'constant': constant,
            'half_extent_arcsec': values.shape[0] * pixel_scale / 2,
            'scale_bar_arcsec': 0.02 if key == 'psf' else 1.0,
            'variants': {},
        }
        for scale in ['linear', 'log', 'zscale']:
            vmin, vmax = (zlo, zhi) if scale == 'zscale' else (lo, hi)
            if constant:
                normalized = np.full_like(values, 0.5)
            else:
                normalized = np.clip((values - vmin) / (vmax - vmin), 0, 1)
                if scale == 'log':
                    normalized = LogStretch(a=1000)(normalized)
            filename = f'{key}-{scale}.png'
            Image.fromarray(MAGMA(normalized, bytes=True)[..., :3]).save(output / filename)
            plane['variants'][scale] = {
                'src': f'/demo/preflight/{filename}', 'vmin': vmin, 'vmax': vmax,
                'sha256': hashlib.sha256((output / filename).read_bytes()).hexdigest(),
            }
        manifest['planes'].append(plane)
    (ROOT.parents[1] / 'src' / 'data' / 'preflight-demo.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return {'manifest': 'preflight/manifest.json', 'numerical_inputs': 'preflight/inputs.npz', 'noise_kind': '1-sigma RMS', 'snr': 'data / noise_rms', 'psf_sum': float(psf.sum())}


if args.preflight_only or args.include_preflight:
    provenance['preflight'] = generate_preflight()
elif (ROOT / 'provenance.json').exists():
    previous = json.loads((ROOT / 'provenance.json').read_text())
    if 'preflight' in previous:
        provenance['preflight'] = previous['preflight']
(ROOT / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
print(f"Created synthetic fixtures in {ROOT}")
