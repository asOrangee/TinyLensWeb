"""Export the existing reproducible demo arrays, checking all original PNGs."""
import hashlib
import json
import sys
import types
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
palette = np.asarray(Image.open(root / 'public/demo/magma-colorbar.png').convert('RGB'))[0]

class Magma:
    def __call__(self, values, bytes=True):
        rgb = palette[np.minimum((np.clip(values, 0, 1)*256).astype(int), 255)]
        return np.concatenate([rgb, np.full((*rgb.shape[:-1], 1), 255, dtype=np.uint8)], axis=-1)

# The source generator only uses this known colormap; its original numeric
# recipe runs unchanged. No Matplotlib installation or PNG inversion is needed.
module = types.ModuleType('matplotlib')
module.colormaps = {'magma': Magma()}
sys.modules['matplotlib'] = module
generator = root / 'scripts/generate_demo.py'
source = generator.read_text().split('if not args.preflight_only and not args.display_metadata_only:')[0]
sys.argv = [str(generator)]
namespace = {'__file__': str(generator)}
exec(compile(source, str(generator), 'exec'), namespace)

manifest = json.loads((root / 'public/demo/science-display.json').read_text())
metadata = {'schema': 'tinylens.demo-scale-arrays.v1', 'planes': {}}
parts, offset = [], 0
for name in ('observation', 'model', 'source-lensed'):
    array = namespace['model_planes'][name]
    expected = np.asarray(Image.open(root / ('public/demo/'+name+'.png')).convert('RGB'))
    np.testing.assert_array_equal(namespace['intensity'](array), expected)
    raw = np.ascontiguousarray(array, dtype='<f8').tobytes()
    entry = manifest['planes'][name]
    metadata['planes'][name] = {'offset': offset, 'src': entry['src'], 'image_sha256': entry['sha256'],
                                'values_sha256': hashlib.sha256(raw).hexdigest()}
    parts.append(raw)
    offset += len(raw)
(root / 'public/demo/scale-arrays.bin').write_bytes(b''.join(parts))
(root / 'public/demo/scale-arrays.json').write_text(json.dumps(metadata, indent=2))
Image.fromarray(palette[::-1, None]).save(root / 'public/demo/magma-scale-colorbar.png')
print(json.dumps({'bytes': offset, 'original_images_verified': 3}))
