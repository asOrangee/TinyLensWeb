"""Losslessly expose existing diagnostic pixels; never fit or recover values."""
import base64
import hashlib
import io
import json
import sys
import numpy as np
from PIL import Image


def longest_run(column):
    edges = np.diff(np.r_[False, column, False].astype(np.int8))
    starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
    if not len(starts):
        return 0, 0
    index = np.argmax(ends - starts)
    return int(starts[index]), int(ends[index])


def axes_box(rgb, tile, min_width=.35, max_width=.96):
    x0, y0, x1, y1 = tile
    black = (rgb[y0:y1, x0:x1, :3].max(axis=2) < 65)
    height, width = black.shape
    columns = []
    for x in range(width):
        top, bottom = longest_run(black[:, x])
        if bottom - top >= height * .35:
            columns.append((x, top, bottom))
    prefix = np.pad(black.cumsum(axis=1), ((0, 0), (1, 0)))
    best, best_area = None, 0
    for i, (left, t0, b0) in enumerate(columns):
        for right, t1, b1 in columns[i + 1:]:
            if not width * min_width <= right - left <= width * max_width:
                continue
            top, bottom = max(t0, t1), min(b0, b1) - 1
            if (right-left)*(bottom-top) <= best_area:
                continue
            top_rows = [y for y in range(top, min(top + 12, bottom))
                        if prefix[y, right + 1] - prefix[y, left] >= (right - left + 1) * .985]
            bottom_rows = [y for y in range(max(top + 1, bottom - 12), bottom + 1)
                           if prefix[y, right + 1] - prefix[y, left] >= (right - left + 1) * .985]
            if not top_rows or not bottom_rows:
                continue
            top, bottom = min(top_rows), max(bottom_rows)
            area = (right - left) * (bottom - top)
            if area <= best_area or bottom - top < height * .35:
                continue
            # Both horizontal spines and both vertical spines must be present.
            if min((prefix[top, right + 1] - prefix[top, left]),
                   (prefix[bottom, right + 1] - prefix[bottom, left])) < (right - left + 1) * .985:
                continue
            if min(black[top:bottom + 1, left].mean(), black[top:bottom + 1, right].mean()) < .985:
                continue
            best, best_area = (left + x0, top + y0, right + x0, bottom + y0), area
    if best is None:
        raise ValueError('The reported diagnostic has no verified plot frame')
    return best


def png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()


def extract(raw, stage):
    image = Image.open(io.BytesIO(raw))
    if image.format != 'PNG' or image.width * image.height > 16000000:
        raise ValueError('Unsupported diagnostic image')
    image.load()
    rgb = np.asarray(image.convert('RGB'))
    width, height = image.size
    if not (1.35 < width/height < 1.7 if stage == 'a' else 4.5 < width/height < 5.5):
        raise ValueError('Unsupported diagnostic layout')
    rows, cols = (2, 3) if stage == 'a' else (1, 5)
    mapping = {'source-lensed': 3, 'residual': 4, 'source': 5} if stage == 'a' else {'source-lensed': 1, 'residual': 2, 'source': 3}
    result = {}
    for name, index in mapping.items():
        col, row = index % cols, index // cols
        tile = (round(width * col / cols), round(height * row / rows),
                round(width * (col + 1) / cols), round(height * (row + 1) / rows))
        left, top, right, bottom = axes_box(rgb, tile)
        data_box = [left + 2, top + 2, right - 1, bottom - 1]
        if data_box[2] <= data_box[0] or data_box[3] <= data_box[1]:
            raise ValueError('Empty diagnostic panel')
        # Preserve the original gradient and printed scale, including offset text.
        bar_left, bar_top, bar_right, bar_bottom = axes_box(rgb, (right + 1, tile[1], tile[2], tile[3]), .04, .45)
        projection = rgb[bar_top:bar_bottom + 1, bar_right + 2:tile[2], :3].max(axis=2).min(axis=0) < 120
        gap = max(8, (bar_right-bar_left)//2)
        label_right = tile[2] - 2
        seen = False
        for start in range(max(0, len(projection)-gap)):
            seen = seen or bool(projection[start])
            if seen and not projection[start:start+gap].any() and start > (bar_right-bar_left)/2:
                label_right = bar_right + 2 + start + 3
                break
        bar_box = [bar_left - 2, max(tile[1], bar_top - round(height / rows * .065)),
                   min(tile[2]-2, label_right), min(tile[3], bar_bottom + round(height / rows * .025))]
        if bar_box[2] <= bar_box[0]:
            raise ValueError('The original colorbar is not available')
        bar_rgb = rgb[bar_box[1]:bar_box[3], bar_box[0]:bar_box[2]]
        if not np.any(bar_rgb.max(axis=2) - bar_rgb.min(axis=2) > 60):
            raise ValueError('Missing original diagnostic colorbar')
        result[name] = {
            'kind': 'reported-raster', 'src': png(image.crop(data_box)),
            'colorbar_src': png(image.crop(bar_box)),
            'pixel_shape': [data_box[3] - data_box[1], data_box[2] - data_box[0]],
            'image_box_px': data_box, 'colorbar_box_px': bar_box,
            'colorbar_top': (bar_box[1] - data_box[1]) / (data_box[3] - data_box[1]),
            'colorbar_height': (bar_box[3] - bar_box[1]) / (data_box[3] - data_box[1]),
            'intrinsic_curves': name != 'residual',
        }
    return {'source_sha256': hashlib.sha256(raw).hexdigest(),
            'source_pixel_shape': [height, width], 'panels': result}


if __name__ == '__main__':
    request = json.loads(sys.stdin.readline())
    if request['stage'] not in ['a', 'm0', 'm1', 'm2', 'm3']:
        raise ValueError('Unsupported diagnostic stage')
    print(json.dumps(extract(base64.b64decode(request['png_base64'], validate=True), request['stage']), separators=(',', ':')))
