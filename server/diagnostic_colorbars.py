"""Reformat a verified linear colorbar's printed ticks, never its image values."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import numpy as np
from PIL import Image, ImageOps

spec = importlib.util.spec_from_file_location('diagnostic_panels', Path(__file__).with_name('extract-diagnostic-panels.py'))
panels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(panels)


def tick_rows(image, frame):
    left, top, right, bottom = frame
    black = np.asarray(image.convert('RGB'))[top:bottom+1, right+1:right+8].max(axis=2) < 100
    found = np.flatnonzero(black.sum(axis=1) >= 4)
    return [float(group.mean()+top) for group in np.split(found, np.flatnonzero(np.diff(found)>1)+1) if len(group)]


def calibrate(rows, recognized, image_height, padding=20, factor=3):
    if not 3 <= len(rows) <= 16:
        raise ValueError('Unsupported printed tick layout')
    matched = {}
    for item in recognized:
        text = item['text'].replace('−', '-').replace('–', '-').replace(' ', '')
        if not re.fullmatch(r'-?\d+(?:\.\d+)?', text) or item['confidence'] < .29:
            raise ValueError('Ambiguous printed label')
        _, y, _, height = item['box']
        center = ((1-y-height/2)*(image_height*factor+2*padding)-padding)/factor
        index = int(np.argmin(np.abs(np.array(rows)-center)))
        if abs(rows[index]-center)>max(8,image_height*.02) or index in matched:
            raise ValueError('Printed text does not match a tick mark')
        matched[index] = (float(text), text)
    if len(matched)<4 or len(matched)<len(rows)*.65:
        raise ValueError('Insufficient printed axis calibration')
    positions = np.array([rows[i] for i in sorted(matched)])
    values = np.array([matched[i][0] for i in sorted(matched)])
    if not np.all(np.diff(values)<0) or positions[-1]-positions[0]<.6*(rows[-1]-rows[0]):
        raise ValueError('Printed tick order is inconsistent')
    slope, offset = np.polyfit(positions, values, 1)
    decimals = max(len(text.split('.')[1]) if '.' in text else 0 for _, text in matched.values())
    quantum = 10.**-decimals
    if np.max(np.abs(positions*slope+offset-values))>max(quantum*.025,1e-9):
        raise ValueError('The original colorbar is not a verified linear axis')
    result=[]
    for i, y in enumerate(rows):
        predicted=y*slope+offset
        value,text=matched[i] if i in matched else (round(predicted/quantum)*quantum,None)
        if abs(value-predicted)>max(quantum*.025,1e-9):
            raise ValueError('Tick cannot be determined from the printed axis')
        result.append({'y':y,'value':value,'source_text':text,'interpolated':i not in matched})
    return result


def extract(request):
    inputs=[];prepared=[]
    for name,panel in request['panels'].items():
        image=Image.open(io.BytesIO(base64.b64decode(panel['colorbar_src'].split(',')[1],validate=True)))
        frame=panels.axes_box(np.asarray(image.convert('RGB')),(0,0,*image.size),.04,.45)
        left,top,right,bottom=frame
        # An offset multiplier would need its own explicit calibration.
        rgb=np.asarray(image.convert('RGB'))
        if (rgb[:max(0,top-2),left:right+1].max(axis=2)<100).any():
            raise ValueError('Scientific offset label requires original presentation')
        labels=image.crop((right+9,0,image.width,image.height))
        labels=ImageOps.expand(labels.resize((labels.width*3,labels.height*3)),border=20,fill='white')
        stream=io.BytesIO();labels.save(stream,format='PNG')
        inputs.append(base64.b64encode(stream.getvalue()).decode())
        prepared.append((name,panel,image,frame))
    cache=Path(request['module_cache']).resolve();cache.mkdir(parents=True,exist_ok=True)
    env={**os.environ,'SWIFT_MODULECACHE_PATH':str(cache),'CLANG_MODULE_CACHE_PATH':str(cache)}
    read=subprocess.run(['/usr/bin/swift','-module-cache-path',str(cache),str(Path(__file__).with_name('read-diagnostic-labels.swift'))],input=json.dumps(inputs),capture_output=True,text=True,env=env,timeout=18)
    if read.returncode:raise ValueError('Printed labels could not be read')
    recognized=json.loads(read.stdout);out={}
    if len(recognized)!=len(prepared):raise ValueError('Label identity mismatch')
    for (name,panel,image,frame),items in zip(prepared,recognized):
        ticks=calibrate(tick_rows(image,frame),items,image.height)
        left,top,right,bottom=frame;box=[left+2,top+2,right-1,bottom-1]
        original_y=panel['colorbar_box_px'][1];data_y=panel['image_box_px'][1];height=panel['pixel_shape'][0]
        out[name]={'gradient_src':panels.png(image.crop(box)),
          'gradient_box_px':box,'top':(original_y+box[1]-data_y)/height,'height':(box[3]-box[1])/height,
          'ticks':[{**tick,'position':(original_y+tick['y']-data_y)/height} for tick in ticks]}
    return out


if __name__=='__main__':
    print(json.dumps(extract(json.loads(sys.stdin.readline())),separators=(',',':')))
