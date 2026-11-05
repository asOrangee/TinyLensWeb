import {useEffect} from 'react';
import {observeImageLabelContrast} from '../lib/adaptive-image-labels';
import './image-label-contrast.css';

export default function ImageLabelContrast(){
 useEffect(()=>{const scope=document.querySelector<HTMLElement>('.stage-workspace');if(scope)return observeImageLabelContrast(scope);},[]);
 return null;
}
