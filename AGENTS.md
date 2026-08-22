# Pittsburgh 3D Recreation

Procedural Three.js recreation of Pittsburgh. See `README.md` for a feature overview and the standard `npm install` / `npm run dev` / `npm run build` / `npm run preview` commands.

## Cursor Cloud specific instructions

- This is a **static, client-only** Vite + Three.js app. There is **no backend, no database, and no test or lint script** (only `dev`, `build`, and `preview` in `package.json`). "Building" and "running" the app means the Vite dev server (`npm run dev`) and/or the production build (`npm run build`).
- The dev server is configured with `host: true` on port `5173` (see `vite.config.js`), so it listens on all interfaces. Open `http://localhost:5173/`.
- City geometry loads at runtime from `public/data/pittsburgh.json` (~1.6 MB), served by Vite at `/data/pittsburgh.json`. If the scene stays stuck on the "Generating Pittsburgh…" loader, verify that this fetch returns 200.
- `vite.config.js` sets `base: './'` for GitHub Pages, so built assets use relative paths; use `npm run preview` (not a bare file open) to smoke-test the production build.
