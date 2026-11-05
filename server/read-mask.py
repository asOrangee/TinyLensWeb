"""Read an explicitly reported Stage-B mask and its frozen display inputs only."""
import base64
import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np
from astropy.io import fits
from matplotlib import colormaps
from PIL import Image

def read_mask(request):
    root, path = Path(request['root']), Path(request['path'])
    if request['stage'] != 'b' or request['kind'] != 'summary' or root.resolve(strict=True) != root:
        raise ValueError('A reported B summary is required')
    hashes = {}
    def read(p, base, limit=16*1024*1024):
        if p.resolve(strict=True) != p or not p.is_relative_to(base) or not p.is_file() or p.stat().st_size > limit:
            raise ValueError('Invalid declared mask dependency')
        raw = p.read_bytes()
        hashes[str(p)] = hashlib.sha256(raw).hexdigest()
        return raw
    def read_json(p, base):
        return json.loads(read(p, base, 1024*1024))
    if not path.is_relative_to(root/'output') or path.name != 'stage-result.json' or path.parent.name != str(request['attempt']) or path.parent.parent.name != 'b' or path.parents[2].name != 'attempts':
        raise ValueError('Mask attempt mismatch')
    summary = read_json(path, root/'output')
    if summary.get('stage') != 'b' or summary.get('attempt') != request['attempt']:
        raise ValueError('Mask summary mismatch')
    run = path.parents[3]
    config = read_json(path.parent/'effective-config.json', run)
    manifest = read_json(run/'run-manifest.json', run)
    if manifest.get('schema_version') != 'lens_run_manifest.v1' or Path(manifest.get('lens_dir', '')).name != summary.get('lens_id') or run.name != summary.get('lens_id'):
        raise ValueError('Mask run mismatch')
    lens = Path(manifest['lens_dir'])
    provenance = read_json(lens/'input-provenance.json', root/'output')
    frozen = Path(provenance['packaged_fits_path'])
    if frozen.parent != lens:
        raise ValueError('Input FITS manifest mismatch')
    fits_raw = read(frozen, root/'output')
    fits_sha = hashlib.sha256(fits_raw).hexdigest()
    g = provenance['input_geometry']
    pixel = float(g['pixel_scale_arcsec'])
    settings = config['settings']
    if fits_sha != provenance['packaged_fits_sha256'] or manifest['input_geometry'] != g or any(settings.get(k) != v for k, v in g.items()) or not np.isfinite(pixel) or pixel <= 0:
        raise ValueError('Mask input geometry mismatch')
    with fits.open(io.BytesIO(fits_raw), memmap=False) as hdus:
        image = np.asarray(hdus['VIS_FLUX'].data, dtype=float)
        header = hdus['VIS_FLUX'].header
        if image.ndim != 2 or image.shape[0] != image.shape[1] or not 1 <= image.shape[0] <= 512 or not np.isfinite(image).all():
            raise ValueError('Unsupported mask image')
        for axis, key in [(1, 'input_x_direction'), (2, 'input_y_direction')]:
            if g[key] not in ['increasing', 'decreasing']:
                raise ValueError('Invalid image axes')
            if 'CDELT'+str(axis) in header and (not np.isclose(header['CDELT'+str(axis)], pixel*(1 if g[key] == 'increasing' else -1)) or header.get('CUNIT'+str(axis), 'arcsec').lower() != 'arcsec'):
                raise ValueError('Input WCS mismatch')
            if 'CRPIX'+str(axis) in header and not np.isclose(header['CRPIX'+str(axis)], (image.shape[2-axis]+1)/2):
                raise ValueError('Unsupported image origin')
            if abs(float(header.get('CRVAL'+str(axis), 0))) > 1e-10:
                raise ValueError('Unsupported image origin')
    if g['input_y_direction'] == 'decreasing':
        image = np.flipud(image)
    if g['input_x_direction'] == 'decreasing':
        image = np.fliplr(image)
    reference = summary['artifacts']['feature_mask_fits']
    if Path(reference).is_absolute() or '..' in Path(reference).parts:
        raise ValueError('Invalid declared feature mask')
    mask_path = path.parent/reference
    mask_raw = read(mask_path, path.parent)
    domain_path = run/'preflight/modeling_mask.fits'
    domain_raw = read(domain_path, run)
    mask, domain = [np.asarray(fits.getdata(io.BytesIO(raw))) for raw in [mask_raw, domain_raw]]
    if any(a.shape != image.shape or not np.isin(a, [0, 1]).all() for a in [mask, domain]) or np.any((mask == 0) & (domain != 0)):
        raise ValueError('Mask alignment or domain mismatch')
    for raw in [mask_raw, domain_raw]:
        h = fits.getheader(io.BytesIO(raw))
        for axis in [1, 2]:
            if 'CDELT'+str(axis) in h and (not np.isclose(h['CDELT'+str(axis)], pixel) or h.get('CUNIT'+str(axis), 'arcsec').strip().lower() != 'arcsec'):
                raise ValueError('Mask is not in the canonical image frame')
            if not np.isclose(h.get('CRPIX'+str(axis), (image.shape[2-axis]+1)/2), (image.shape[2-axis]+1)/2) or abs(float(h.get('CRVAL'+str(axis), 0))) > 1e-10:
                raise ValueError('Mask origin mismatch')
    included, domain_pixels = int((mask == 0).sum()), int((domain == 0).sum())
    if included != summary['metrics']['included_arc_pixels'] or mask.size-included != summary['metrics']['masked_pixels'] or domain_pixels <= 0:
        raise ValueError('Mask counts mismatch')
    lo, hi = float(image.min()), float(image.max())
    norm = np.full_like(image, .5) if hi == lo else np.arcsinh(25*(image-lo))/np.arcsinh(25*(hi-lo))
    def png(array):
        output = io.BytesIO()
        Image.fromarray(array).save(output, format='PNG')
        return 'data:image/png;base64,'+base64.b64encode(output.getvalue()).decode()
    def encoded(array):
        return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode()
    raw_values = np.ascontiguousarray(image, dtype='<f8').tobytes()
    half = image.shape[0]*pixel/2
    radius = float(settings['modeling_radius']) if 'modeling_radius' in settings else None
    if radius is not None and (not np.isfinite(radius) or radius <= 0):
        raise ValueError('Invalid modeling radius')
    return {'schema': 'tinylens.mask-edit.v1', 'stage': 'b', 'attempt': request['attempt'], 'path': str(path), 'sha256': hashes[str(path)],
            'mask_path': str(mask_path), 'mask_sha256': hashlib.sha256(mask_raw).hexdigest(),
            'domain_path': str(domain_path), 'domain_sha256': hashlib.sha256(domain_raw).hexdigest(),
            'input_fits_sha256': fits_sha, 'pixel_scale_arcsec': pixel, 'modeling_radius_arcsec': radius,
            'shape': list(image.shape), 'included': included, 'domain_pixels': domain_pixels,
            'included_base64': encoded(np.flipud(mask == 0).astype(np.uint8)),
            'domain_base64': encoded(np.flipud(domain == 0).astype(np.uint8)), 'display_y_direction': 'decreasing',
            'plane': {'src': png(np.flipud(colormaps['magma'](norm, bytes=True)[..., :3])), 'shape': list(image.shape),
                      'bounds_arcsec': [-half, half, -half, half], 'half_extent_arcsec': half, 'vmin': lo, 'vmax': hi,
                      'data_min': lo, 'data_max': hi, 'stretch': 'asinh', 'asinh_a': 25, 'colormap': 'magma',
                      'colormap_src': png(colormaps['magma'](np.linspace(1, 0, 256)[:, None], bytes=True)[..., :3]),
                      'input_fits_sha256': fits_sha, 'values_base64': base64.b64encode(raw_values).decode(),
                      'values_sha256': hashlib.sha256(raw_values).hexdigest(), 'mask_base64': encoded(np.ones(image.shape, np.uint8)), 'array_y_direction': 'increasing'},
            'input_files_sha256': hashes}

if __name__ == '__main__':
    print(json.dumps(read_mask(json.loads(sys.stdin.readline())), allow_nan=False, separators=(',', ':')))
