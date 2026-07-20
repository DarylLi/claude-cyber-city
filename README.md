# Neon Meridian

A procedural cyberpunk megacity, rendered with **Three.js WebGPURenderer + TSL**. Built as a
"do it better" take on the recently-viral `cyberpunk-megapolis` demo: same pitch (endless neon
city, fly around, watch it rain), rebuilt from scratch on the WebGPU node pipeline instead of
classic WebGLRenderer/EffectComposer, with a proper day/night/weather system driving the whole
scene instead of a single fixed lighting rig.

## Highlights over the baseline

- **WebGPU + TSL throughout.** No shader strings — every material and post-fx pass is a Three.js
  TSL node graph (`three/tsl`), including GPU-compute rain (`instancedArray` + compute shaders,
  not CPU-updated particles).
- **Procedural city, not a fixed placement list.** `src/city/cityLayout.js` recursively subdivides
  a seeded block grid into lots and towers — deterministic, but there's no baked scene/placement
  data to ship.
- **One coherent environment system**, not independent lighting toggles. `src/systems/environment.js`
  exponentially blends *every* sky/light/fog/bloom/wetness value between time-of-day and weather
  presets, so switching from "Night" to "Day" (or "Clear" to "Storm") reads as one continuous
  transition instead of a hard cut.
- **Real post-processing chain**: GTAO, bloom, GPU rain-streak overlay, depth of field (auto-engages
  on aim), chromatic aberration (speed/aim-driven), vignette, film grain — see
  `src/postfx/pipeline.js` for the exact stage order.
- **Fake IBL puddle reflections** (`src/tsl/shared.js`'s `fakeSkyReflection`) instead of a real
  reflection probe, cheap enough to run on every building/ground pixel.
- **Quality tiers auto-detected** from `navigator.hardwareConcurrency`/`deviceMemory` (`src/utils/quality.js`),
  gating AO/DoF/chromatic aberration/film grain/rain density/shadow resolution — switchable live from
  the HUD.

## Running it

```bash
npm install
npm run dev
```

Requires a WebGPU-capable browser (recent Chrome/Edge, or Safari Technology Preview).

## Controls

- **Orbit mode** (default): drag to orbit, scroll to zoom, auto-rotate toggle in the HUD.
- **F** — switch between orbit and fly camera.
- **Fly mode**: WASD/arrows to move, Shift to boost, mouse-drag to look, Space/Ctrl to move up/down.
- **Right mouse button** (fly mode) — aim, which pulls focus in via depth of field.
- HUD (top right): time of day, weather, quality tier, camera mode, live FPS/building/rain/wetness stats.

## Project layout

```
src/
  main.js               entry point — wires everything together, owns the frame loop
  config/presets.js      time-of-day / weather / quality-tier / city-generation presets
  city/
    cityLayout.js         pure-math seeded procedural block/lot/tower generator
    city.js                turns the layout into InstancedMesh draw calls + AABBs
    materials.js            TSL building/ground/beacon/billboard materials
  sky/sky.js              procedural sky dome — gradient + sun/moon discs + 3D-noise clouds
  systems/
    environment.js         time-of-day/weather blend — single source of truth for lighting
    collision.js            AABB spatial hash for fly-camera collision + orbit-camera avoidance
  weather/rain.js          GPU-compute rain particles + screen-space rain streak data
  postfx/pipeline.js       TSL node-graph post-processing chain
  controls/cameraRig.js   orbit/fly camera rig
  ui/hud.js                lil-gui control panel + live stats
  utils/quality.js          quality-tier auto-detection
```

## Notes on the WebGPU/TSL API surface

A few non-obvious gotchas hit during development that are worth knowing if you extend this:

- `uniform(value)` **unwraps** a Node argument to a value *snapshot at call time*, not a live
  reference — passing your own live uniform into another node's constructor (e.g. `bloom()`)
  silently freezes it. Pass plain numbers and drive the returned node's own internal uniforms
  directly afterward instead.
- `GTAONode` renders to a single-channel (`RedFormat`) target — its texture node's `.g/.b/.a` are
  not scene color, they're `0/0/1` from sampling a one-component texture as `vec4`. Multiply by
  `.r` only (`chain.mul(aoTexture.r)`), never multiply the raw vec4 against a color — doing so
  crushes green/blue to zero and reads as a solid red-tinted frame (very easy to miss at night
  against an already-warm palette, glaring in daylight).
- A fixed-radius orbit camera around a procedurally generated city isn't automatically clear of
  geometry — `OrbitControls.minDistance` only constrains distance-to-target, not clearance from
  whatever building happens to sit near that radius at a given angle. `CameraRig._avoidBuildings()`
  pushes the camera off (or, if it lands directly inside a footprint in one jump, out of) nearby
  buildings every frame in orbit mode.
