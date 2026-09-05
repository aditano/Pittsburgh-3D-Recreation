# Pittsburgh 3D Recreation

Procedural Three.js recreation of Pittsburgh in the dark architectural-maquette style — extruded OSM building footprints, street network, three-rivers confluence, and stylized bridges.

Inspired by [Daniel Farinax’s San Francisco Three.js city loop](https://x.com/daniel_farinax/status/2088353519225237799).

## Features

- **OSM-derived city**: building footprints, streets, and parks for the Pittsburgh core
- **Three Rivers**: Allegheny, Monongahela, and Ohio at the Point
- **Landmark labels**: U.S. Steel Tower, PPG Place, Cathedral of Learning, stadiums, and more
- **City of Bridges**: Roberto Clemente, Andy Warhol, Rachel Carson, Fort Pitt, and others
- **Terrain**: soft hills for Mount Washington / North Side / Oakland
- **Camera presets**: Aerial · Downtown · The Point · Bridges · Oakland · Rotate

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`).

## Build

```bash
npm run build
npm run preview
```

## Data

City geometry lives in `public/data/pittsburgh.json` (generated from OpenStreetMap Overpass extract + hand-authored river/bridge/landmark overlays). Coordinates are local meters: **+X east, +Y up, +Z south**, origin near downtown / the Point.

## Living city

- **Transit explorer:** 98 PRT routes and their 2,149 in-frame stops, including Red,
  Blue and Silver T lines. Select a route to isolate it, show its stops, or fly
  to it. All in-frame GTFS shape variants are retained. Moving buses/trains are
  illustrative simulations, not live vehicle positions or arrival predictions.
  Rail geometry is a surface overlay, including underground sections. Service
  outside the model boundary is clipped, not replaced with straight shortcuts.
- **Time and weather:** a continuous 24-hour lighting cycle (12 real minutes),
  time scrubber, pause/resume, stars, sunset colors, illuminated facades and
  street lamps, headlights, and an optional 90-second sunny/rain/snow cycle.
- **Street life:** instanced cars travel connected OSM road segments with lane
  offsets, mapped one-way restrictions, car-following gaps and controlled
  intersections; pedestrians walk alongside roads. This remains an ambient
  simulation rather than a calibrated microscopic traffic model. Vehicles
  reverse only where a legal reverse segment exists, otherwise stop at dead ends. Bridge traffic is not
  synthesized across water where the road extract has no usable elevation.
- **Strip District:** nine OSM-located businesses, including Primanti Bros.,
  Penn Mac, Wholey's, Pamela's, DeLuca's, Stamoolis, Enrico Biscotti and
  Prestogeorge, with stylized signs, canopies and pavement furniture. These are
  interpretive facade treatments, not photographed replicas.
- **Third person:** choose **Walk the city**, or select a Strip business.
  WASD/arrows move, Shift runs, drag looks around, Escape exits. Touch controls
  appear on coarse-pointer devices. Terrain following, building/water collision
  and a shortened camera boom keep exploration grounded. Building interiors,
  bridge decks and underground stations are not walkable in this version.

### Data refresh and validation

The bundled transit snapshot comes from PRT's official GTFS download, feed
`Merged_Clever_2606_2`, valid June 28 through October 14, 2026. It is a static
snapshot; this application does not claim to show current service alerts.

```sh
curl -L https://www.rideprt.org/developerresources/GTFS.zip -o /tmp/GTFS.zip
python scripts/import-transit.py /tmp/GTFS.zip
node scripts/test-city-life.mjs
npm run build
```

Sources: [PRT developer resources](https://www.rideprt.org/business-center/developer-resources/),
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
Each business record includes its original OSM feature URL. Existing USGS 3DEP
terrain and detailed building geometry remain the geographic foundation.


## Higher-detail core and lighting

- USGS-derived elevation is now resampled from the original Terrarium tiles at
  **10 m** spacing (previously 40 m), with **1,823,173 samples** and no data gaps.
  This improves use of the existing elevation source, not its underlying survey
  accuracy. Downtown terrain meshes use 10 m spacing on desktop; outlying ground
  and constrained devices use a lighter mesh.
- Desktop facade atlases are **1024 × 1024** (previously 512 × 512), with mipmaps
  and anisotropic filtering. Phones retain 512-pixel atlases. Partitioned nearby
  detail adds projecting sills/lintels, doors, sidewalks, curbs and lane markings.
  These treatments follow the mapped footprints and remain procedural.
- A shared planar reflection captures the actual skyline and bridges in the
  water at 12 Hz in High/Ultra quality. Rain rings, fine wind ripples, Fresnel
  reflectance and sky colors respond to conditions. Low/Medium and mobile use
  the lighter dynamic sky reflection. The rivers are pool-stage water, not ocean
  waves; this is visual simulation rather than a hydrological model.
- Day and night now share a separate window-emission mask. Street lamps,
  illuminated business signs and vehicle headlights respond to darkness.
  Street-level shadows concentrate around the walking camera for finer detail.
- **3,804 mapped roads and 526 OSM signal nodes** underpin the core traffic
  network. Nearby heads share a controller. Two opposing phases alternate
  green/yellow with all-red clearance; cars brake for red signals and queue
  behind leaders. Signal timings and lane assignments are illustrative, not
  Pittsburgh's actual traffic-engineering plans. Crosswalks and stop bars are
  procedurally placed at those controlled approaches.

Reference photograph used for skyline, river reflectance and urban-fabric
comparison: [Terminal 21 downtown Pittsburgh aerial](https://www.liveterminal21.com/).
The photograph is reference-only and is not redistributed in this repository.
Additional geographic context: [City of Pittsburgh GIS](https://www.pittsburghpa.gov/Business-Development/Geographic-Information-Systems-Mapping-Open-Data/Geographic-Information-System-GIS-Mapping)
and [Allegheny County building-footprint documentation](https://data.wprdc.org/dataset/allegheny-county-building-footprint-locations).
Existing OSM building footprints remain the model geometry; county imagery was
not substituted or claimed as new photogrammetry.

Refresh road metadata/signals with `node scripts/import-street-detail.mjs --refresh`.
Rebuild terrain from the cached elevation source with `node scripts/build-terrain.mjs`.
