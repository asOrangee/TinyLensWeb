import { useEffect, useState } from 'react';
import { isImageScale, type ImageScale } from './image-scale';

export function useImageScale(mode: 'live' | 'demo', scope?: string | null) {
  const key = scope === null ? null : `tinylens-${mode}-image-scale-v2${scope ? ':' + scope : ''}`;
  const [scale, setScale] = useState<ImageScale>(() => {
    try {
      const saved = key && localStorage.getItem(key);
      if (isImageScale(saved)) return saved;
    } catch { /* The viewer can still use its default scale. */ }
    return 'linear';
  });
  useEffect(() => {
    if (!key) return;
    try { localStorage.setItem(key, scale); } catch { /* Display preferences are optional. */ }
  }, [key, scale]);
  return [scale, setScale] as const;
}
