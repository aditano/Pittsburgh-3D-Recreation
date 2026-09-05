// Arc-length paths keep vehicles at a constant speed through uneven OSM vertices.
export function makePath(points) {
  const p = points.filter((v, i) => !i || Math.hypot(v[0]-points[i-1][0], v[1]-points[i-1][1]) > .05);
  const lengths = [0];
  for (let i=1;i<p.length;i++) lengths.push(lengths[i-1]+Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]));
  return {points:p,lengths,length:lengths.at(-1)||0};
}
export function samplePath(path, distance, offset=0) {
  if (path.points.length<2) return null;
  const d=Math.max(0,Math.min(path.length,distance));
  let lo=1,hi=path.lengths.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(path.lengths[mid]<d)lo=mid+1;else hi=mid;}
  const a=path.points[lo-1],b=path.points[lo],len=path.lengths[lo]-path.lengths[lo-1];
  const t=(d-path.lengths[lo-1])/len,dx=(b[0]-a[0])/len,dz=(b[1]-a[1])/len;
  return {x:a[0]+(b[0]-a[0])*t+dz*offset,z:a[1]+(b[1]-a[1])*t-dx*offset,heading:Math.atan2(dx,dz)};
}
export function nearestSegment(x,z,segments) {
  let best=null;
  for(const s of segments){const dx=s.b[0]-s.a[0],dz=s.b[1]-s.a[1],l2=dx*dx+dz*dz;
    const t=Math.max(0,Math.min(1,((x-s.a[0])*dx+(z-s.a[1])*dz)/(l2||1)));
    const px=s.a[0]+dx*t,pz=s.a[1]+dz*t,d=Math.hypot(px-x,pz-z);
    if(!best||d<best.distance)best={...s,x:px,z:pz,distance:d,t};
  }return best;
}
