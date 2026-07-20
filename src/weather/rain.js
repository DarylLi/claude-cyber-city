// -----------------------------------------------------------------------------
// Rain — GPU-compute particle field (TSL storage buffers), not a CPU sim.
//
// Doesn't simulate the whole city: a fixed-radius cylinder "wind bubble"
// follows the camera. Each particle's lateral offset from the camera is
// sampled once (disk distribution) and never touched again; only its height
// is updated by a compute pass each frame (fall + wrap). That split is what
// makes "follows the camera" free — the lateral follow happens implicitly by
// adding the live camera-position uniform at draw time, no per-frame XZ
// wrap/rebucket logic needed at all.
//
// Sized for the "high" quality tier's particle budget; lower tiers just draw
// fewer instances of the same storage buffers via `sprite.count` — no realloc.
// -----------------------------------------------------------------------------
import * as THREE from 'three/webgpu';
import {
  Fn, If, instancedArray, instanceIndex, hash, uniform, vec2, vec3,
  uv, smoothstep, abs, time,
} from 'three/tsl';

const RADIUS = 62;
const TOP_MARGIN = 46;
const BOTTOM_MARGIN = 4;

export function createRain(environment, maxCount) {
  const u = environment.u;

  const fallY = instancedArray(maxCount, 'float');
  const basePos = instancedArray(maxCount, 'vec2');
  const speedMul = instancedArray(maxCount, 'float');

  const cameraPos = uniform(new THREE.Vector3());
  const dtUniform = uniform(0.016);
  const fallSpeed = uniform(34.0);

  const computeInit = Fn(() => {
    const pos = basePos.element(instanceIndex);
    const angle = hash(instanceIndex).mul(6.2831853);
    const r = hash(instanceIndex.add(9137.0)).sqrt().mul(RADIUS);
    pos.assign(vec2(angle.cos().mul(r), angle.sin().mul(r)));

    speedMul.element(instanceIndex).assign(hash(instanceIndex.add(4211.0)).mul(0.5).add(0.75));
    fallY.element(instanceIndex).assign(
      hash(instanceIndex.add(77.0)).mul(TOP_MARGIN + BOTTOM_MARGIN).sub(BOTTOM_MARGIN).add(cameraPos.y),
    );
  })().compute(maxCount);

  const computeUpdate = Fn(() => {
    const y = fallY.element(instanceIndex);
    const sMul = speedMul.element(instanceIndex);
    y.subAssign(fallSpeed.mul(sMul).mul(dtUniform));

    If(y.lessThan(cameraPos.y.sub(BOTTOM_MARGIN)), () => {
      y.assign(cameraPos.y.add(TOP_MARGIN).add(hash(instanceIndex.add(time.mul(37.0))).mul(6.0)));
    });
  })().compute(maxCount);

  const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });

  const basePosAttr = basePos.toAttribute();
  const fallYAttr = fallY.toAttribute();
  material.positionNode = vec3(basePosAttr.x.add(cameraPos.x), fallYAttr, basePosAttr.y.add(cameraPos.z));
  material.scaleNode = vec2(0.028, 0.85);

  const uvNode = uv();
  const streak = smoothstep(0.0, 0.22, uvNode.y).mul(smoothstep(1.0, 0.72, uvNode.y));
  const edge = smoothstep(0.5, 0.05, abs(uvNode.x.sub(0.5)));
  material.opacityNode = streak.mul(edge).mul(u.rainAmount).mul(0.55);
  material.colorNode = vec3(0.72, 0.8, 0.9);

  const sprite = new THREE.Sprite(material);
  sprite.count = maxCount;
  sprite.frustumCulled = false;
  sprite.renderOrder = 900;

  // In-flight guard: `update()` is called fire-and-forget every frame (see
  // the call site's comment), but with nothing capping concurrency, issuing
  // a fresh computeAsync() before the previous one resolves lets pending GPU
  // submissions pile up without bound whenever a frame's total GPU work
  // (much heavier now with the real-asset city + full post-fx chain) takes
  // longer than one rAF tick — which is exactly when a slow backend needs
  // this the most. Once backlogged, that pile-up starved the whole render
  // loop indefinitely. Skipping a frame's rain update while one is already
  // in flight bounds the backlog to at most one pending submission.
  let inFlight = false;
  return {
    sprite,
    material,
    setCount(n) {
      sprite.count = Math.min(maxCount, n);
    },
    update(renderer, dt, camera) {
      if (inFlight) return;
      dtUniform.value = dt;
      cameraPos.value.copy(camera.position);
      inFlight = true;
      renderer.computeAsync(computeUpdate).finally(() => { inFlight = false; });
    },
    async init(renderer, camera) {
      cameraPos.value.copy(camera.position);
      await renderer.computeAsync(computeInit);
    },
  };
}
