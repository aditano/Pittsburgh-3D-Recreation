"""Import official PRT GTFS. Usage: python scripts/import-transit.py /path/to/GTFS.zip
Download: https://www.rideprt.org/developerresources/GTFS.zip
Preserves all in-frame shape variants, breaks paths at the model boundary.
"""
import csv,io,json,math,sys,zipfile,collections,datetime,pathlib
z=zipfile.ZipFile(sys.argv[1])
def rows(name):return csv.DictReader(io.TextIOWrapper(z.open(name+'.txt'),encoding='utf-8-sig'))
def project(lat,lon):return [round((float(lon)+80.002)*111320*math.cos(math.radians(40.441)),2),round(-(float(lat)-40.441)*111320,2)]
def inside(p):return -4600<p[0]<8600 and -4000<p[1]<4600
routes={r['route_id']:r for r in rows('routes') if r['route_id'] not in ('TEST','MISC')}
trips=list(rows('trips'));shape_routes=collections.defaultdict(set);trip_routes={}
for t in trips:
 if t['route_id'] in routes:shape_routes[t['shape_id']].add(t['route_id']);trip_routes[t['trip_id']]=t['route_id']
shapes=collections.defaultdict(list)
for p in rows('shapes'):
 if p['shape_id'] in shape_routes:shapes[p['shape_id']].append((int(p['shape_pt_sequence']),project(p['shape_pt_lat'],p['shape_pt_lon'])))
by_route=collections.defaultdict(list)
for sid,points in shapes.items():
 chunks=[];chunk=[]
 for _,p in sorted(points):
  if inside(p):
   if not chunk or math.dist(p,chunk[-1])>=3:chunk.append(p)
  else:
   if len(chunk)>1:chunks.append(chunk)
   chunk=[]
 if len(chunk)>1:chunks.append(chunk)
 for rid in shape_routes[sid]:by_route[rid].extend(chunks)
stop_routes=collections.defaultdict(set)
for s in rows('stop_times'):
 if s['trip_id'] in trip_routes:stop_routes[s['stop_id']].add(trip_routes[s['trip_id']])
stops=[]
for s in rows('stops'):
 p=project(s['stop_lat'],s['stop_lon'])
 if inside(p) and s['stop_id'] in stop_routes:stops.append({'id':s['stop_id'],'name':s['stop_name'],'p':p,'routes':sorted(stop_routes[s['stop_id']])})
out=[]
for rid,chunks in by_route.items():
 r=routes[rid];unique=list({json.dumps(p):p for p in chunks}.values())
 out.append({'id':rid,'name':r['route_long_name'] or r['route_short_name']+' LINE','color':'#'+(r['route_color'] or 'e4b63f'),'type':'rail' if r['route_type'] in ('0','1','2') else 'incline' if r['route_type']=='7' else 'bus','paths':unique})
represented={r['id'] for r in out}
for s in stops:s['routes']=[r for r in s['routes'] if r in represented]
stops=[s for s in stops if s['routes']]
feed=list(rows('feed_info'))
result={'source':'https://www.rideprt.org/developerresources/GTFS.zip','attribution':'Pittsburgh Regional Transit','imported':datetime.date.today().isoformat(),'feed':feed,'note':'Static route geometry, clipped to city extent. Vehicles are illustrative, not live arrivals. Rail displayed as a surface overlay, including tunnels.','routes':sorted(out,key=lambda r:r['id']),'stops':stops}
path=pathlib.Path(__file__).resolve().parents[1]/'public/data/transit.json';path.write_text(json.dumps(result,separators=(',',':')))
print(f'{len(out)} routes, {len(stops)} stops, {path.stat().st_size:,} bytes');print(feed)
