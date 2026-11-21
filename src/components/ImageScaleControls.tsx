import { ChartSpline, Check } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { imageScaleOptions, type ImageScale } from '../lib/image-scale';
import { useDemoI18n } from '../lib/demo-i18n';
import './image-display-menu.css';

export default function ImageScaleControls({ value, onChange, disabled = false }: {
  value: ImageScale;
  onChange: (value: ImageScale) => void;
  disabled?: boolean;
}) {
  const { t } = useDemoI18n();
  const trigger = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const label = t('显示尺度');
  const valueLabel = imageScaleOptions.find(([scale]) => scale === value)?.[1] ?? value;
  const triggerContent = <ChartSpline size={17} aria-hidden="true"/>;
  const triggerLabel = `${label} · ${valueLabel}`;

  useEffect(() => {
    const details = menu.current;
    if (!details) return;
    function dismissOutside(event: PointerEvent) {
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    }
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [disabled]);

  function closeMenu() {
    if (menu.current) menu.current.open = false;
    trigger.current?.focus();
  }

  if (disabled) return <button className="science-icon-button image-scale-trigger" type="button"
    title={triggerLabel} aria-label={triggerLabel} disabled>{triggerContent}</button>;

  return <details ref={menu} name="image-display-controls" className="image-display-menu"
    onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}
    onKeyDown={event => {
      if (event.key === 'Escape' && event.currentTarget.open) {
        event.preventDefault();
        closeMenu();
      }
    }}>
    <summary ref={trigger} className="science-icon-button image-scale-trigger" title={triggerLabel} aria-label={triggerLabel}>{triggerContent}</summary>
    <fieldset className="image-display-menu-panel" aria-label={label}>
      {imageScaleOptions.map(([scale, option]) => <button type="button" key={scale} aria-pressed={value === scale}
        onClick={() => { onChange(scale); closeMenu(); }}>
        {option}{value === scale && <Check size={13} aria-hidden="true"/>}
      </button>)}
    </fieldset>
  </details>;
}
