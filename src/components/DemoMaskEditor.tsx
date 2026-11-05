import {createPortal} from 'react-dom';
import type {ImageScale} from '../lib/image-scale';
import {useScaledPlanes} from '../lib/use-scaled-planes';
import ImageScaleControls from './ImageScaleControls';
import MaskEditor from './MaskEditor';
export default function DemoMaskEditor({value,onChange,disabled,toolbarTarget,scale,onScaleChange}:{value:number[];onChange:(value:number[])=>void;disabled:boolean;toolbarTarget:HTMLDivElement|null;scale:ImageScale;onScaleChange:(scale:ImageScale)=>void}){
 const scaled=useScaledPlanes(undefined,scale,false,['observation']);
 return <>{toolbarTarget&&createPortal(<div className="science-toolbar" role="toolbar" aria-label="图像显示工具"><ImageScaleControls value={scale} onChange={onScaleChange}/></div>,toolbarTarget)}<MaskEditor value={value} onChange={onChange} disabled={disabled} backgroundSrc={scaled.planes?.observation?.src} toolbarTarget={toolbarTarget}/></>;
}
