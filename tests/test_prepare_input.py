import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

spec = importlib.util.spec_from_file_location('prepare_input', Path(__file__).parents[1] / 'scripts' / 'prepare_input.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_packaging_preserves_arrays_originals_and_refuses_overwrite(tmp_path):
    image = np.arange(49, dtype=np.float32).reshape(7, 7)
    arrays = {'image': image, 'noise': np.ones_like(image), 'psf': np.arange(1, 10, dtype=np.float32).reshape(3, 3)}
    inputs = {}
    for name, values in arrays.items():
        path = tmp_path / f'{name}.fits'
        fits.writeto(path, values)
        inputs[name] = (path, 0)
    hashes = {name: module.sha(value[0]) for name, value in inputs.items()}
    options = dict(workspace=tmp_path, lens_id='lens-001', inputs=inputs, pixel_scale=.05,
                   x_direction='increasing', y_direction='decreasing', evidence='Synthetic test calibration')
    path = module.prepare(**options)
    manifest = json.loads(path.read_text())
    target = Path(manifest['packaged_fits_path'])
    assert manifest['packaged_fits_sha256'] == module.sha(target)
    with fits.open(target) as hdus:
        for name, extension in [('image', 'VIS_FLUX'), ('noise', 'VIS_RMS'), ('psf', 'VIS_PSF')]:
            np.testing.assert_array_equal(hdus[extension].data, arrays[name])
            assert module.sha(inputs[name][0]) == hashes[name]
        assert hdus['VIS_FLUX'].header['CDELT2'] == -.05
    with pytest.raises(FileExistsError):
        module.prepare(**options)
    assert module.sha(target) == manifest['packaged_fits_sha256']


def test_rejects_invalid_ids_before_creating_output(tmp_path):
    with pytest.raises(ValueError, match='lens ID'):
        module.prepare(workspace=tmp_path, lens_id='../escape', inputs={}, pixel_scale=.05,
                       x_direction='increasing', y_direction='increasing', evidence='test')
    assert not (tmp_path / 'output').exists()
