// -----------------------------------------------------------------------------
// Entry point — wires renderer, environment, sky, city, weather, camera rig,
// post-fx and HUD together and drives the frame loop.
// -----------------------------------------------------------------------------
import * as THREE from 'three/webgpu';

import { Environment } from './systems/environment.js';
import { CollisionWorld } from './systems/collision.js';
import { createSky } from './sky/sky.js';
import { loadCityAssets, applyCityWetness } from './city/assetCity.js';
import { createRain } from './weather/rain.js';
import { PostFX } from './postfx/pipeline.js';
import { CameraRig } from './controls/cameraRig.js';
import { createHUD } from './ui/hud.js';
import { detectQualityTier } from './utils/quality.js';
import { QUALITY } from './config/presets.js';

// Picks a cinematic camera spawn point scaled to the actual loaded city
// footprint (citySpan/center from the real scene.json bounds) instead of a
// coordinate hardcoded for one particular layout. Starting from *outside*
// the whole footprint with a healthy clearance margin means it's safe
// regardless of which corner of the pack the placement bounds land in.
function findCameraSpawn(city) {
  const span = city.citySpan;
  const dir = new THREE.Vector3(0.535, 0, 0.845); // establishing 3/4 view angle
  let radius = span * 1.05;
  let height = span * 0.35;
  const position = new THREE.Vector3(
    city.center.x + dir.x * radius, height, city.center.z + dir.z * radius,
  );
  const target = new THREE.Vector3(city.center.x, Math.min(40, span * 0.08), city.center.z);

  // Defensive nudge-out loop with a real standoff clearance (not just
  // "non-overlapping"), in case the pack's bounds put a tower near this angle.
  const margin = Math.max(60, span * 0.18);
  for (let guard = 0; guard < 40; guard++) {
    const hit = city.aabbs.some((b) =>
      position.x >= b.minX - margin && position.x <= b.maxX + margin &&
      position.z >= b.minZ - margin && position.z <= b.maxZ + margin &&
      position.y >= b.minY - margin && position.y <= b.maxY + margin,
    );
    if (!hit) break;
    radius += span * 0.05;
    height += span * 0.02;
    position.set(city.center.x + dir.x * radius, height, city.center.z + dir.z * radius);
  }

  return { position, target };
}

async function main() {
  const app = document.getElementById('app');
  const bootEl = document.getElementById('boot');
  const hintEl = document.getElementById('hint');
  const crosshairEl = document.getElementById('crosshair');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2600);

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 1);
  app.appendChild(renderer.domElement);
  await renderer.init();

  let qualityKey = detectQualityTier();
  let quality = QUALITY[qualityKey];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // --- environment / sky ---------------------------------------------------
  const environment = new Environment(renderer, scene);
  const sky = createSky(environment);
  scene.add(sky.dome);

  // --- city ------------------------------------------------------------------
  // Real GLB city pack (buildings/street/facades/decals/environment props),
  // not a procedural stand-in — see src/city/assetCity.js.
  const city = await loadCityAssets(renderer, {
    onProgress: (frac) => {
      const sub = bootEl?.querySelector('.sub');
      if (sub) sub.textContent = `loading city assets · ${Math.round(frac * 100)}%`;
    },
  });
  scene.add(city.group);
  const collisionWorld = new CollisionWorld(city.aabbs);

  // --- camera rig --------------------------------------------------------
  const spawn = findCameraSpawn(city);
  const rig = new CameraRig(camera, renderer.domElement, collisionWorld, spawn);

  // --- weather -------------------------------------------------------------
  const rain = createRain(environment, QUALITY.high.rainParticles);
  scene.add(rain.sprite);
  rain.setCount(quality.rainParticles);
  await rain.init(renderer, camera);

  // --- post-fx ---------------------------------------------------------------
  const postfx = new PostFX(renderer, scene, camera, environment);
  postfx.build(qualityKey);

  function applyQuality(key) {
    qualityKey = key;
    quality = QUALITY[key];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    renderer.shadowMap.enabled = quality.shadows;
    rain.setCount(quality.rainParticles);
    postfx.build(key);
  }

  // --- HUD ---------------------------------------------------------------
  const hud = createHUD({ environment, postfx, rig, initialQuality: qualityKey, onQualityChange: applyQuality });
  environment.setTimeOfDay(hud.state.timeOfDay);
  environment.setWeather(hud.state.weather);

  window.__debug = { renderer, scene, camera, postfx, environment, rig, city, applyQuality, hud, rain };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let lastMode = rig.mode;
  const clock = new THREE.Timer();
  clock.connect(document); // avoids a huge dt spike from the Page Visibility API when the tab regains focus
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fpsTimer = 0;

  function animate() {
    clock.update();
    const dt = Math.min(clock.getDelta(), 0.1);

    rig.update(dt);
    environment.update(dt);
    applyCityWetness(city, environment.current.wetness);
    sky.followCamera(camera);

    postfx.setSpeed(rig.speedNormalized);
    postfx.setAiming(rig.mode === 'fly' && rig.aiming);
    postfx.update(dt);

    if (rig.mode !== lastMode) {
      lastMode = rig.mode;
      hud.setCameraModeLabel(rig.mode === 'orbit' ? 'F 切换到飞行模式 (当前: 环绕)' : 'F 切换到环绕模式 (当前: 飞行)');
    }
    crosshairEl.classList.toggle('aim', rig.mode === 'fly' && rig.aiming);

    // Fire-and-forget: WebGPU command submission order is preserved by the
    // queue regardless of when the returned promise settles, so the render
    // pass below still samples this frame's updated rain positions without
    // needing to await completion here (awaiting every frame caused the
    // animation loop to stall after a handful of frames — see git history).
    rain.update(renderer, dt, camera);

    postfx.render();


    fpsAccum += dt;
    fpsFrames += 1;
    fpsTimer += dt;
    if (fpsTimer > 0.5) {
      hud.stats.fps = Math.round(fpsFrames / fpsAccum);
      hud.stats.rain = Math.round(environment.current.rainAmount * 100) / 100;
      hud.stats.wetness = Math.round(environment.current.wetness * 100) / 100;
      hud.stats.buildings = city.placementCount;
      fpsAccum = 0;
      fpsFrames = 0;
      fpsTimer = 0;
    }

    if (bootEl && !bootEl.classList.contains('hidden')) {
      bootEl.classList.add('hidden');
      setTimeout(() => bootEl.remove(), 900);
      setTimeout(() => hintEl.classList.add('hidden'), 8000);
    }
  }

  window.__debug.animate = animate;
  renderer.setAnimationLoop(animate);
}

main().catch((err) => {
  console.error(err);
  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.querySelector('.sub').textContent = 'webgpu init failed — ' + (err?.message || err);
    bootEl.querySelector('.sub').style.color = '#ff6a6a';
  }
});
