import type { useReportedInput } from '../lib/use-reported-input';
import PreflightViewer from './PreflightViewer';
import type { ImageScale } from '../lib/image-scale';

export default function LivePreflightViewer({ input, toolbarTarget, scale, onScaleChange }: { input: ReturnType<typeof useReportedInput>; toolbarTarget: HTMLDivElement | null; scale:ImageScale; onScaleChange:(scale:ImageScale)=>void }) {
  return <PreflightViewer key={input.id} toolbarTarget={toolbarTarget} display={input.display} missingLayers={input.missing} scale={scale} onScaleChange={onScaleChange}/>;
}
