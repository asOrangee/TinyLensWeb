/** Display geometry for the declared synthetic potential; never a stage runner. */
export type Point = {x:number;y:number};
export type PlaneFrame = {half_extent_arcsec:number;shape:number[];bounds_arcsec?:number[]};
export type PlaneView = {zoom:number;pan:Point};
export type LensCurvePair = {critical:Point[];caustic:Point[];closed:boolean};
export const weakImageMagnification=1e-3;
export type DisplayImage=Point&{magnification:number;weak:boolean};
/** Overlay filtering only: keep every mathematical solution in imagesFor(). */
export function displayImageFamily(images:Point[],magnificationFor:(point:Point)=>number,includeWeak=false){
  const all=images.map(point=>{const magnification=magnificationFor(point);return {...point,magnification,weak:Math.abs(magnification)<weakImageMagnification};});
  return {points:includeWeak?all:all.filter(point=>!point.weak),hiddenWeakCount:includeWeak?0:all.filter(point=>point.weak).length};
}
export type Potential = {kind:string;normalization_arcsec:number;potential_axis_ratio:number;position_angle_rad:number;softening_squared_arcsec2:number;shear_gamma1:number;shear_gamma2:number};
type Mapping = {schema:string;synthetic:boolean;coordinates:{unit:string;origin:string;x:string;y:string};model:Potential;frames:{image:PlaneFrame;source:PlaneFrame};images:Record<string,{src:string;sha256:string}>};
type Display = {planes:Record<string,{src:string;sha256:string;half_extent_arcsec:number;shape:number[]}>};
const finite=(p:Point)=>Number.isFinite(p.x)&&Number.isFinite(p.y);
const frameBounds=(frame:PlaneFrame)=>frame.bounds_arcsec??[-frame.half_extent_arcsec,frame.half_extent_arcsec,-frame.half_extent_arcsec,frame.half_extent_arcsec];

/** Fractions are measured from the upper-left pixel edge, before CSS transforms. */
export function screenToPlane(position:Point,frame:PlaneFrame,view:PlaneView):Point{
  const b=frameBounds(frame);
  return {x:(b[0]+b[1])/2+(position.x-.5-view.pan.x/100)*(b[1]-b[0])/view.zoom,y:(b[2]+b[3])/2-(position.y-.5-view.pan.y/100)*(b[3]-b[2])/view.zoom};
}
export function planeToScreen(position:Point,frame:PlaneFrame,view:PlaneView):Point{
  const b=frameBounds(frame);
  return {x:.5+(position.x-(b[0]+b[1])/2)*view.zoom/(b[1]-b[0])+view.pan.x/100,y:.5-(position.y-(b[2]+b[3])/2)*view.zoom/(b[3]-b[2])+view.pan.y/100};
}
export const isInside=(point:Point,frame:PlaneFrame)=>{const p=planeToScreen(point,frame,{zoom:1,pan:{x:0,y:0}});return finite(p)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1;};
export function isInPlaneView(point:Point,frame:PlaneFrame,view:PlaneView){const screen=planeToScreen(point,frame,view);return finite(screen)&&screen.x>=0&&screen.x<=1&&screen.y>=0&&screen.y<=1;}

/** beta = theta - grad(psi) - Gamma theta, using the exact fixture potential. */
export function potentialMapper(model:Potential,frame:PlaneFrame){
  const {normalization_arcsec:b,potential_axis_ratio:q,position_angle_rad:phi,softening_squared_arcsec2:core2,shear_gamma1:g1,shear_gamma2:g2}=model;
  if(model.kind!=='elliptical-isothermal-potential-with-shear'||![b,q,phi,core2,g1,g2,frame.half_extent_arcsec].every(Number.isFinite)||b<=0||q<=0||q>1||core2<=0||frame.half_extent_arcsec<=0)throw new Error('Unsupported lens mapping');
  const c=Math.cos(phi),s=Math.sin(phi),a=q*c*c+s*s/q,d=q*s*s+c*c/q,h=c*s*(q-1/q);
  function evaluate(p:Point){
    const u=a*p.x+h*p.y,v=h*p.x+d*p.y,r=Math.sqrt(p.x*u+p.y*v+core2),r3=r*r*r;
    return {x:(1-g1)*p.x-g2*p.y-b*u/r,y:-g2*p.x+(1+g1)*p.y-b*v/r,
      xx:1-g1-b*(a/r-u*u/r3),xy:-g2-b*(h/r-u*v/r3),yy:1+g1-b*(d/r-v*v/r3)};
  }
  return mapperFromEvaluator(evaluate,frame,Math.min(frame.half_extent_arcsec,Math.max(4*Math.sqrt(core2),2*Math.cbrt(b*core2))));
}

type Evaluation=Point&{xx:number;xy:number;yx?:number;yy:number};
const jacobianDeterminant=(value:Evaluation)=>value.xx*value.yy-value.xy*(value.yx??value.xy);

function gridAxis(low:number,high:number,steps:number,center:number,coreExtent:number,coreSteps:number){
  const span=high-low,coordinates=Array.from({length:steps+1},(_,i)=>low+span*i/steps);
  if(coreExtent>0)for(let i=0;i<=coreSteps;i++){
    const coordinate=center-coreExtent+2*coreExtent*i/coreSteps;
    if(coordinate>low&&coordinate<high)coordinates.push(coordinate);
  }
  return coordinates.sort((a,b)=>a-b).filter((value,i,sorted)=>i===0||value-sorted[i-1]>span*5e-13);
}

export function mapperFromEvaluator(evaluate:(point:Point)=>Evaluation,frame:PlaneFrame,coreExtent=0,coreCenter?:Point){
  const sourceFor=(p:Point):Point=>{const value=evaluate(p);return{x:value.x,y:value.y};};
  const determinantFor=(p:Point)=>jacobianDeterminant(evaluate(p));
  const magnificationFor=(p:Point)=>1/determinantFor(p);
  const [left,right,bottom,top]=frameBounds(frame);
  const center=coreCenter??{x:(left+right)/2,y:(bottom+top)/2};
  let curves:LensCurvePair[]|undefined;
  const criticalCurves=()=>curves??=criticalContours(frame,center,coreExtent,determinantFor,sourceFor);
  type Vertex={image:Point;source:Point};
  type Triangle={p:Vertex;q:Vertex;r:Vertex;minX:number;maxX:number;minY:number;maxY:number};
  let mesh:{vertices:Vertex[];triangles:Triangle[]}|undefined;
  function makeMesh(){
    const refineExtent=coreCenter?coreExtent:0;
    const xs=gridAxis(left,right,128,center.x,refineExtent,32),ys=gridAxis(bottom,top,128,center.y,refineExtent,32);
    const width=xs.length,vertices:Vertex[]=[],triangles:Triangle[]=[];
    for(const y of ys)for(const x of xs){const image={x,y};vertices.push({image,source:sourceFor(image)});}
    function triangle(i:number,j:number,k:number){const p=vertices[i],q=vertices[j],r=vertices[k];triangles.push({p,q,r,minX:Math.min(p.source.x,q.source.x,r.source.x),maxX:Math.max(p.source.x,q.source.x,r.source.x),minY:Math.min(p.source.y,q.source.y,r.source.y),maxY:Math.max(p.source.y,q.source.y,r.source.y)});}
    for(let row=0;row<ys.length-1;row++)for(let col=0;col<width-1;col++){const i=row*width+col;triangle(i,i+1,i+width+1);triangle(i,i+width+1,i+width);}
    return {vertices,triangles};
  }
  function refine(seed:Point,target:Point):Point|null{
    let point={...seed};
    for(let iteration=0;iteration<55;iteration++){
      const f=evaluate(point),rx=f.x-target.x,ry=f.y-target.y,error=rx*rx+ry*ry;
      if(error<1e-18)return isInside(point,frame)?point:null;
      const determinant=jacobianDeterminant(f);if(Math.abs(determinant)<1e-13)break;
      let dx=(f.yy*rx-f.xy*ry)/determinant,dy=(-(f.yx??f.xy)*rx+f.xx*ry)/determinant;
      const length=Math.hypot(dx,dy);if(length>1){dx/=length;dy/=length;}
      let improved=false;
      for(let damping=1;damping>=1/1024;damping/=2){const next={x:point.x-damping*dx,y:point.y-damping*dy},g=evaluate(next);if((g.x-target.x)**2+(g.y-target.y)**2<error){point=next;improved=true;break;}}
      if(!improved)break;
    }
    const f=sourceFor(point);return isInside(point,frame)&&Math.hypot(f.x-target.x,f.y-target.y)<1e-7?point:null;
  }
  function imagesFor(target:Point):Point[]{
    if(!finite(target))return [];
    mesh??=makeMesh();const seeds:Point[]=[center],nearest:{distance:number;point:Point}[]=[];
    // Seed every mapped triangle containing beta; this retains distinct image branches.
    for(const triangle of mesh.triangles){
      if(target.x<triangle.minX-1e-8||target.x>triangle.maxX+1e-8||target.y<triangle.minY-1e-8||target.y>triangle.maxY+1e-8)continue;
      const {p,q,r}=triangle,ax=q.source.x-p.source.x,ay=q.source.y-p.source.y,bx=r.source.x-p.source.x,by=r.source.y-p.source.y,det=ax*by-ay*bx;
      if(Math.abs(det)<1e-16)continue;
      const tx=target.x-p.source.x,ty=target.y-p.source.y,u=(tx*by-ty*bx)/det,v=(ax*ty-ay*tx)/det;
      if(u>=-1e-6&&v>=-1e-6&&u+v<=1+1e-6)seeds.push({x:p.image.x+u*(q.image.x-p.image.x)+v*(r.image.x-p.image.x),y:p.image.y+u*(q.image.y-p.image.y)+v*(r.image.y-p.image.y)});
    }
    // Near a fold, a curved branch may fall between mesh triangles. Refine nearby
    // forward rays as well, and include the softened central image explicitly.
    for(const vertex of mesh.vertices){const distance=(vertex.source.x-target.x)**2+(vertex.source.y-target.y)**2;if(nearest.length===12&&distance>=nearest[11].distance)continue;nearest.push({distance,point:vertex.image});nearest.sort((a,b)=>a.distance-b.distance);if(nearest.length>12)nearest.pop();}
    seeds.push(...nearest.map(item=>item.point));
    const images:Point[]=[];
    for(const seed of seeds){const image=refine(seed,target);if(image&&!images.some(other=>Math.hypot(image.x-other.x,image.y-other.y)<1e-4))images.push(image);}
    return images.sort((a,b)=>Math.atan2(a.y,a.x)-Math.atan2(b.y,b.x));
  }
  return {sourceFor,imagesFor,magnificationFor,determinantFor,criticalCurves};
}

/** Trace det(d beta / d theta)=0, then ray-shoot each curve to its caustic.
 * A refined mesh around the lens center resolves small radial curves.
 * Shared edge roots retain connected branches; field-edge paths remain open.
 */
function criticalContours(frame:PlaneFrame,center:Point,coreExtent:number,determinantFor:(point:Point)=>number,sourceFor:(point:Point)=>Point):LensCurvePair[]{
  const [left,right,bottom,top]=frameBounds(frame);
  const xs=gridAxis(left,right,256,center.x,coreExtent,128),ys=gridAxis(bottom,top,256,center.y,coreExtent,128);
  const width=xs.length,values=new Float64Array(width*ys.length),nodes=new Map<string,Point>(),segments:{a:string;b:string}[]=[],adjacency=new Map<string,number[]>();
  const vertex=(id:number):Point=>({x:xs[id%width],y:ys[Math.floor(id/width)]});
  for(let row=0;row<ys.length;row++)for(let col=0;col<width;col++)values[row*width+col]=determinantFor({x:xs[col],y:ys[row]});
  function crossing(i:number,j:number):string{
    const id=values[i]===0?`v${i}`:values[j]===0?`v${j}`:i<j?`${i}:${j}`:`${j}:${i}`;
    if(nodes.has(id))return id;
    let low=vertex(i),high=vertex(j),lowValue=values[i];
    if(values[i]===0)high=low;
    else if(values[j]===0)low=high;
    else for(let iteration=0;iteration<42;iteration++){
      const middle={x:(low.x+high.x)/2,y:(low.y+high.y)/2},value=determinantFor(middle);
      if(value===0){low=high=middle;break;}
      if((value<0)===(lowValue<0)){low=middle;lowValue=value;}else high=middle;
    }
    nodes.set(id,{x:(low.x+high.x)/2,y:(low.y+high.y)/2});return id;
  }
  function triangle(a:number,b:number,c:number){
    const edges:string[]=[];
    for(const [i,j] of [[a,b],[b,c],[c,a]])if((values[i]<0)!==(values[j]<0))edges.push(crossing(i,j));
    if(edges.length!==2||edges[0]===edges[1])return;
    const index=segments.length;segments.push({a:edges[0],b:edges[1]});
    for(const node of edges){const incident=adjacency.get(node);if(incident)incident.push(index);else adjacency.set(node,[index]);}
  }
  for(let row=0;row<ys.length-1;row++)for(let col=0;col<width-1;col++){
    const a=row*width+col,b=a+1,c=a+width+1,d=a+width;
    const signs=[values[a]<0,values[b]<0,values[c]<0,values[d]<0];
    if(signs.every(sign=>sign===signs[0]))continue;
    triangle(a,b,c);triangle(a,c,d);
  }
  const used=new Uint8Array(segments.length),result:LensCurvePair[]=[];
  function follow(start:string){
    const critical:Point[]=[];let current=start,closed=false;
    while(true){
      critical.push(nodes.get(current)!);
      const next=adjacency.get(current)!.find(index=>!used[index]);if(next===undefined)break;
      used[next]=1;const edge=segments[next];current=edge.a===current?edge.b:edge.a;
      if(current===start){closed=true;break;}
    }
    if(critical.length>=2)result.push({critical,caustic:critical.map(sourceFor),closed});
  }
  // Start at field boundaries first, so clipped curves are never falsely closed.
  for(const [node,edges] of adjacency)if(edges.length===1&&!used[edges[0]])follow(node);
  for(let i=0;i<segments.length;i++)if(!used[i])follow(segments[i].a);
  return result.sort((a,b)=>Math.max(...b.critical.map(p=>Math.hypot(p.x,p.y)))-Math.max(...a.critical.map(p=>Math.hypot(p.x,p.y))));
}

/** Require the same image assets and calibrated frames; missing data disables mapping. */
export function verifiedDemoMapping(input:unknown,display:Display){
  try{
    const data=input as Mapping;
    if(data.schema!=='tinylens-lens-mapping-demo.v1'||data.synthetic!==true||data.coordinates.unit!=='arcsec'||data.coordinates.origin!=='geometric-center'||data.coordinates.x!=='right'||data.coordinates.y!=='up')return null;
    for(const [name,plane] of Object.entries(display.planes))if(data.images[name]?.src!==plane.src||data.images[name]?.sha256!==plane.sha256)return null;
    for(const [space,name] of [['image','model'],['source','source']] as const){const frame=data.frames[space],plane=display.planes[name];if(frame.half_extent_arcsec!==plane.half_extent_arcsec||JSON.stringify(frame.shape)!==JSON.stringify(plane.shape))return null;}
    return {...potentialMapper(data.model,data.frames.image),frames:data.frames};
  }catch{return null;}
}
