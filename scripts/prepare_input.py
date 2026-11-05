"""Create an immutable Web-readable FITS copy and input provenance, without modeling."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import numpy as np
from astropy.io import fits


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(*, workspace, lens_id, inputs, pixel_scale, x_direction, y_direction, evidence):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,119}', lens_id) or lens_id in ['.', '..']:
        raise ValueError('Use a simple lens ID without path separators')
    if not math.isfinite(pixel_scale) or pixel_scale <= 0 or not evidence.strip():
        raise ValueError('A positive pixel scale and its calibration evidence are required')
    if x_direction not in ['increasing', 'decreasing'] or y_direction not in ['increasing', 'decreasing']:
        raise ValueError('Axis directions must be increasing or decreasing')
    workspace = Path(workspace).resolve(strict=True)
    arrays, units, origins = {}, {}, {}
    for key, (filename, extension) in inputs.items():
        path = Path(filename).resolve(strict=True)
        before = sha(path)
        with fits.open(path, memmap=False) as hdus:
            array = np.asarray(hdus[extension].data).copy()
            units[key] = str(hdus[extension].header.get('BUNIT', ''))
        if before != sha(path):
            raise ValueError('An input changed while being read')
        if array.ndim != 2 or min(array.shape) < 1 or max(array.shape) > 512 or not np.isfinite(array).all():
            raise ValueError('Inputs must be finite 2D arrays with each axis at most 512 pixels')
        arrays[key] = array
        origins[key] = {'path': str(path), 'hdu': extension, 'sha256': before}
    image, noise, psf = [arrays[key] for key in ['image', 'noise', 'psf']]
    if image.shape != noise.shape or image.shape[0] != image.shape[1] or np.any(noise <= 0) or psf.sum() <= 0:
        raise ValueError('Require a square image, aligned strictly positive 1-sigma RMS and positive-sum PSF')
    for axis, direction in [(1, x_direction), (0, y_direction)]:
        if direction == 'decreasing' and psf.shape[axis] % 2 == 0:
            raise ValueError('A reflected PSF axis must have odd length')
    output_root = workspace / 'output'
    destination = output_root / 'inputs' / lens_id
    if destination.resolve() != destination or output_root.resolve() != output_root:
        raise ValueError('Output directories may not redirect through symlinks')
    # This creates a new package; it never replaces an existing input or result.
    destination.mkdir(parents=True, exist_ok=False)
    target = destination / f'{lens_id}.fits'
    geometry = {'pixel_scale_arcsec': pixel_scale, 'input_x_direction': x_direction, 'input_y_direction': y_direction}
    hdus = [fits.PrimaryHDU()]
    headers = {}
    for key, extension in [('image', 'VIS_FLUX'), ('noise', 'VIS_RMS'), ('psf', 'VIS_PSF')]:
        array = arrays[key]
        header = fits.Header()
        for axis, direction in [(1, x_direction), (2, y_direction)]:
            header[f'CDELT{axis}'] = pixel_scale * (1 if direction == 'increasing' else -1)
            header[f'CUNIT{axis}'] = 'arcsec'
            header[f'CRPIX{axis}'] = (array.shape[2-axis] + 1) / 2
            header[f'CRVAL{axis}'] = 0.0
        if units[key]:
            header['BUNIT'] = units[key]
        headers[key] = dict(header)
        hdus.append(fits.ImageHDU(data=array, header=header, name=extension))
    fits.HDUList(hdus).writeto(target)
    with fits.open(target, memmap=False) as saved:
        for key, extension in [('image', 'VIS_FLUX'), ('noise', 'VIS_RMS'), ('psf', 'VIS_PSF')]:
            if not np.array_equal(arrays[key], saved[extension].data):
                raise ValueError('Packaged array verification failed')
    manifest = {
        # Legacy protocol name; this helper is equally usable for real observations.
        'schema_version': 'mock_input_provenance.v1',
        'packaged_fits_path': str(target), 'packaged_fits_sha256': sha(target),
        'input_geometry': geometry, 'geometry_headers': headers,
        'geometry_evidence': evidence, 'source_files': origins,
        'noise_definition': '1-sigma RMS',
        'operation': 'Array-preserving copy into centered local coordinates; no resampling, axis flip or PSF normalization.',
    }
    for source in origins.values():
        if sha(Path(source['path'])) != source['sha256']:
            raise ValueError('An original input changed before packaging finished')
    manifest_path = destination / 'input-provenance.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    return manifest_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path(__file__).resolve().parents[1] / 'pipeline')
    parser.add_argument('--lens-id', required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--fits', type=Path, help='Existing multi-extension VIS_FLUX/VIS_RMS/VIS_PSF FITS')
    group.add_argument('--image', type=Path, help='Separate flux FITS')
    parser.add_argument('--noise', type=Path, help='Separate 1-sigma RMS FITS; not inverse variance')
    parser.add_argument('--psf', type=Path)
    parser.add_argument('--image-hdu', type=int, default=0)
    parser.add_argument('--noise-hdu', type=int, default=0)
    parser.add_argument('--psf-hdu', type=int, default=0)
    parser.add_argument('--pixel-scale-arcsec', required=True, type=float)
    parser.add_argument('--input-x-direction', required=True, choices=['increasing', 'decreasing'])
    parser.add_argument('--input-y-direction', required=True, choices=['increasing', 'decreasing'])
    parser.add_argument('--geometry-evidence', required=True)
    args = parser.parse_args()
    if args.fits:
        if args.noise or args.psf:
            parser.error('--noise/--psf apply only with --image')
        inputs = {key: (args.fits, ext) for key, ext in [('image', 'VIS_FLUX'), ('noise', 'VIS_RMS'), ('psf', 'VIS_PSF')]}
    else:
        if not args.noise or not args.psf:
            parser.error('--image requires --noise and --psf')
        inputs = {'image': (args.image, args.image_hdu), 'noise': (args.noise, args.noise_hdu), 'psf': (args.psf, args.psf_hdu)}
    path = prepare(workspace=args.workspace, lens_id=args.lens_id, inputs=inputs, pixel_scale=args.pixel_scale_arcsec,
                   x_direction=args.input_x_direction, y_direction=args.input_y_direction, evidence=args.geometry_evidence)
    print(path)
    print('Input copy verified. No AI turn, preflight, mask, sampling or scientific acceptance was started.')


if __name__ == '__main__':
    main()
