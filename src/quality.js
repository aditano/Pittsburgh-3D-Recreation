/**
 * Device quality and drawing-buffer scale.
 *
 * Quality changes shadows, bloom and weather particle density. Resolution is a
 * separate multiplier on `devicePixelRatio` (capped at 2), so a phone can run
 * medium shadows at 50% resolution without also forcing the desktop path.
 */

export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const QUALITY = {
  low: {
    shadows: false,
    shadowSize: 512,
    shadowSoft: false,
    bloom: false,
    particles: 0.28,
  },
  medium: {
    shadows: true,
    shadowSize: 1024,
    shadowSoft: false,
    bloom: false,
    particles: 0.55,
  },
  high: {
    shadows: true,
    shadowSize: 2048,
    shadowSoft: true,
    bloom: true,
    particles: 1,
  },
  ultra: {
    shadows: true,
    shadowSize: 2048,
    shadowSoft: true,
    bloom: true,
    particles: 1.35,
  },
};

export const RESOLUTION_PCTS = [50, 75, 100, 150, 200];

const QUALITY_KEY = 'pgh-quality';
const RESOLUTION_KEY = 'pgh-resolution';
const WEATHER_KEY = 'pgh-weather';

export function defaultQuality(constrained) {
  return constrained ? 'medium' : 'high';
}

export function defaultResolution(constrained) {
  return constrained ? 50 : 100;
}

export function loadSettings(constrained) {
  const qualityRaw = (localStorage.getItem(QUALITY_KEY) || '').toLowerCase();
  const quality = QUALITY[qualityRaw] ? qualityRaw : defaultQuality(constrained);
  const resRaw = Number(localStorage.getItem(RESOLUTION_KEY));
  const resolution = RESOLUTION_PCTS.includes(resRaw) ? resRaw : defaultResolution(constrained);
  const weatherRaw = (localStorage.getItem(WEATHER_KEY) || '').toLowerCase();
  const weather = weatherRaw === 'rain' || weatherRaw === 'snow' ? weatherRaw : 'sunny';
  return { quality, resolution, weather };
}

export function saveSettings({ quality, resolution, weather }) {
  if (quality) localStorage.setItem(QUALITY_KEY, quality);
  if (resolution) localStorage.setItem(RESOLUTION_KEY, String(resolution));
  if (weather) localStorage.setItem(WEATHER_KEY, weather);
}

export function pixelRatioFor(resolutionPct) {
  const cap = Math.min(window.devicePixelRatio || 1, 2);
  return Math.max(0.5, cap * (resolutionPct / 100));
}
