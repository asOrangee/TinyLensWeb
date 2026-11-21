import { Layers3 } from 'lucide-react';
import { useMemo } from 'react';
import { useDemoI18n } from '../lib/demo-i18n';
import { maskOverlayPixels } from '../lib/image-scale';
import { maskLayerNames, type MaskLayerName, type MaskLayers } from '../lib/stage-artifacts';
import './image-display-menu.css';

const labels = { aperture: '圆形视场', contamination: '污染源', arc: '透镜弧' };

export function MaskLayerControl({ layers, selected, onChange }: {
  layers?: MaskLayers; selected: readonly MaskLayerName[]; onChange: (name: MaskLayerName, enabled: boolean) => void;
}) {
  const { t } = useDemoI18n();
  const label = t('Mask 图层');
  return <details name="image-display-controls" className="image-display-menu result-mask-layer-control">
    <summary title={label} aria-label={label} className="science-icon-button"
      data-active={selected.some(name => !!layers?.[name]) || undefined}><Layers3 size={17} aria-hidden="true"/></summary>
    <fieldset className="image-display-menu-panel" aria-label={label}>{maskLayerNames.map(name => <label key={name}>
      <input type="checkbox" checked={selected.includes(name) && !!layers?.[name]} disabled={!layers?.[name]}
        onChange={event => onChange(name, event.target.checked)}/>
      {t(labels[name])}
    </label>)}</fieldset>
  </details>;
}

export function useMaskOverlays(layers: MaskLayers | undefined, selected: readonly MaskLayerName[]) {
  return useMemo(() => {
    if (!layers) return [];
    const [height, width] = layers.shape;
    return selected.flatMap(name => {
      const encoded = layers[name];
      if (!encoded) return [];
      const pixels = maskOverlayPixels(encoded, layers.shape, name === 'contamination' ? 1 : 0);
      if (!pixels) return [];
      const canvas = document.createElement('canvas');
      canvas.height = height;
      canvas.width = width;
      const context = canvas.getContext('2d');
      if (!context) return [];
      const image = context.createImageData(width, height);
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
      return [{ name, src: canvas.toDataURL('image/png') }];
    });
  }, [layers, selected]);
}
