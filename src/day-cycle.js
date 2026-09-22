import * as THREE from 'three';
import {applyWeatherLook, WEATHER_LOOK} from './weather.js';

export function createDayCycle(ctx, getWeather, setWeather) {
  const lamps = [];
  ctx.scene.traverse((o) => {
    if (o.material?.userData?.cityLamp) lamps.push(o.material);
  });
  const facades = Object.values(ctx.materials.families).map((f) => ({mat: f.mat, base: f.mat.emissiveIntensity}));
  let hour = 17;
  let elapsed = 0;
  let lastWeather = 0;
  let weatherSeen = getWeather();
  const clock = document.getElementById('city-clock');
  const slider = document.getElementById('time-slider');
  const play = document.getElementById('cycle-play');
  const weatherCycle = document.getElementById('weather-cycle');
  let running = true;
  play.addEventListener('click', () => {
    running = !running;
    play.textContent = running ? 'Pause day' : 'Resume day';
    play.setAttribute('aria-pressed', String(running));
  });
  slider.addEventListener('input', () => {
    hour = Number(slider.value);
  });
  let scrubbing = false;
  const stopScrub = () => {
    scrubbing = false;
  };
  slider.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  slider.addEventListener('pointerup', stopScrub);
  slider.addEventListener('pointercancel', stopScrub);
  slider.addEventListener('blur', stopScrub);
  const nightColor = new THREE.Color(0x070e23);
  const nightHorizon = new THREE.Color(0x222a45);
  const warm = new THREE.Color(0xf4a56e);
  const warmLamps = new THREE.Color(0xf4b561);
  const sunny = WEATHER_LOOK.sunny;
  return {update(dt) {
    elapsed += dt;
    if (running) hour = (hour + dt / 30) % 24;
    const weather = getWeather();
    // A manual change restarts the 90s hold, so picking rain is not undone a frame later.
    if (weather !== weatherSeen) {
      weatherSeen = weather;
      lastWeather = elapsed;
    }
    if (weatherCycle.checked && elapsed - lastWeather > 90) {
      lastWeather = elapsed;
      const next = {sunny: 'rain', rain: 'snow', snow: 'sunny'}[weatherSeen] || 'sunny';
      setWeather(next);
      weatherSeen = getWeather();
    }
    const angle = ((hour - 6) / 24) * Math.PI * 2;
    const elevation = Math.sin(angle);
    const day = THREE.MathUtils.smoothstep(elevation, -0.12, 0.3);
    const night = 1 - day;
    applyWeatherLook(weatherSeen, ctx);
    const sunBase = ctx.sun.intensity;
    const hemiBase = ctx.hemi.intensity;
    const fillBase = ctx.fill.intensity;
    const envBase = ctx.scene.environmentIntensity;
    const sunset = Math.max(0, 1 - Math.abs(elevation) / 0.32) * day;
    const u = ctx.sky.material.uniforms;
    u.uDay.value = day;
    u.uZenith.value.lerp(nightColor, night);
    u.uHorizon.value.lerp(warm, sunset * 0.7).lerp(nightHorizon, night);
    u.uGlow.value.lerp(warm, sunset);
    u.uCityGlow.value.lerp(warmLamps, night);
    ctx.waterUniforms.uWaterDay.value = day;
    ctx.waterUniforms.uWaterZenith.value.copy(u.uZenith.value);
    ctx.waterUniforms.uWaterHorizon.value.copy(u.uHorizon.value);
    ctx.sunDir.set(Math.cos(angle), Math.max(0.05, elevation), 0.35).normalize();
    u.uSunDir.value.copy(ctx.sunDir);
    ctx.sun.intensity = sunBase * day;
    ctx.sun.color.lerp(warm, sunset);
    ctx.hemi.intensity = 0.14 + hemiBase * day;
    // Sunny noon stays at the tuned 0.20 fill / 0.42 environment. Rain and snow
    // keep their ratio to that baseline instead of being overwritten by it.
    ctx.fill.intensity = (0.08 + 0.12 * day) * (fillBase / sunny.fill);
    ctx.scene.environmentIntensity = (0.045 + 0.375 * day) * (envBase / sunny.env);
    const horiz = Math.hypot(ctx.sunDir.x, ctx.sunDir.z) || 1;
    ctx.fill.position.set(-ctx.sunDir.x / horiz, 0.158, -ctx.sunDir.z / horiz).normalize().multiplyScalar(1400);
    ctx.scene.fog.color.lerp(nightHorizon, night);
    ctx.scene.background.copy(ctx.scene.fog.color);
    ctx.renderer.setClearColor(ctx.scene.background, 1);
    const h = Math.floor(hour);
    const m = Math.floor((hour - h) * 60);
    clock.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (!scrubbing && document.activeElement !== slider) slider.value = hour;
    for (const mat of lamps) {
      mat.emissive.setHex(0xffc878);
      mat.emissiveIntensity = night * 3;
    }
    for (const {mat, base} of facades) mat.emissiveIntensity = base + night * 0.85;
    ctx.materials.roadMat.roughness = weatherSeen === 'rain' ? 0.35 : 0.9;
    return night;
  }};
}
