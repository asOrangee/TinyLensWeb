"""Export existing synthetic numerical fixtures; never infer pixels from PNGs."""
import base64
import hashlib
import json
import sys
import types
from pathlib import Path

import numpy as np
from PIL import Image

root=Path(__file__).resolve().parents[1]
palette=np.asarray(Image.open(root/'public/demo/magma-colorbar.png').convert('RGB'))[0]
class Magma:
    def __call__(self, values, bytes=True):
        rgb=palette[np.minimum((np.clip(values,0,1)*256).astype(int),255)]
        return np.concatenate([rgb,np.full((*rgb.shape[:-1],1),255,dtype=np.uint8)],axis=-1)
module=types.ModuleType('matplotlib');module.colormaps={'magma':Magma()};sys.modules['matplotlib']=module
generator=root/'scripts/generate_demo.py'
code=generator.read_text().split('if not args.preflight_only and not args.display_metadata_only:')[0]
sys.argv=[str(generator)];namespace={'__file__':str(generator)};exec(compile(code,str(generator),'exec'),namespace)
manifest=json.loads((root/'src/data/science-demo.json').read_text())
input_manifest=json.loads((root/'src/data/preflight-demo.json').read_text())
inputs=np.load(root/'public/demo/preflight/inputs.npz')
luts=json.loads((root/'src/data/color-luts.json').read_text())
result={'schema':'tinylens.demo-numeric.v1','synthetic':True,'models':{},'input':input_manifest}
parts=[];offset=0
def entry(values,plane):
    global offset
    raw=np.ascontiguousarray(values,dtype='<f8').tobytes()
    out={'offset':offset,'byte_length':len(raw),'values_sha256':hashlib.sha256(raw).hexdigest(),'plane':plane}
    parts.append(raw);offset+=len(raw)
    return out
for name,base in manifest['planes'].items():
    if name=='lens-light':continue
    values=namespace['model_planes'][name]
    expected=namespace['residual_colour'](values) if name=='residual' else namespace['chi_square_colour'](values) if name=='chi-square' else namespace['intensity'](values)
    np.testing.assert_array_equal(expected,np.asarray(Image.open(root/f'public/demo/{name}.png')))
    half=base['half_extent_arcsec'];p={**base,'src':'','colormap_src':'','bounds_arcsec':[-half,half,-half,half],'asinh_a':base['asinh_a'] or 1}
    if name in ('residual','chi-square'):p['color_stops']=namespace['RESIDUAL_STOPS']
    result['models'][name]=entry(values,p)
for plane in result['input']['planes']:
    values=inputs[plane['id']];np.testing.assert_array_equal(values,namespace['model_planes']['observation'] if plane['id']=='data' else values)
    half=plane['half_extent_arcsec'];limits=plane['variants']['linear']
    numeric={'src':'','colormap_src':'','shape':list(values.shape),'bounds_arcsec':[-half,half,-half,half],'half_extent_arcsec':half,'vmin':limits['vmin'],'vmax':limits['vmax'],'data_min':float(values.min()),'data_max':float(values.max()),'stretch':'linear','asinh_a':1,'colormap':'magma'}
    plane['numeric_entry']={**result['models']['observation'],'plane':numeric} if plane['id']=='data' else entry(values,numeric)
    for v in plane['variants'].values():v['src']=''
result['byte_length']=offset
(root/'public/demo/numeric-display.bin').write_bytes(b''.join(parts))
(root/'public/demo/numeric-display.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'verified_model_pngs':len(result['models']),'numeric_input_planes':len(result['input']['planes']),'bytes':offset}))
