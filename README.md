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
