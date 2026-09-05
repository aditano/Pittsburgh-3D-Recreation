import {overpass,project,ROOT} from './osm.mjs';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const d=await overpass('street-detail-core','[out:json][timeout:60];(way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street)$"](40.426,-80.025,40.474,-79.94);node["highway"="traffic_signals"](40.426,-80.025,40.474,-79.94););out geom;', {refresh:process.argv.includes('--refresh')});
const roads=d.elements.filter(e=>e.type==='way').map(e=>({id:e.id,name:e.tags.name||'',highway:e.tags.highway,oneway:e.tags.oneway||'no',lanes:Number(e.tags.lanes)||2,bridge:e.tags.bridge==='yes',tunnel:e.tags.tunnel==='yes',c:e.geometry.map(p=>project(p.lat,p.lon))}));
const signals=d.elements.filter(e=>e.type==='node').map(e=>({id:e.id,p:project(e.lat,e.lon)}));
writeFileSync(join(ROOT,'public/data/street-detail.json'),JSON.stringify({source:'OpenStreetMap contributors, Overpass; signal positions and road tags. Signal timing is simulated.',roads,signals}));
console.log(`${roads.length} roads, ${signals.length} traffic signal nodes`);
