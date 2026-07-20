// -----------------------------------------------------------------------------
// Procedural sky dome — hand-written TSL, not three/addons Sky.js.
//
// Same ingredients as the reverse-engineered WebGL baseline (zenith/horizon/
// ground ramp, analytic sun disc+glow, moon disc w/ mottled surface + glow,
// hashed starfield, two fbm cloud layers scrolled by wind) rebuilt as a single
// TSL colorNode. One deliberate upgrade over the baseline: clouds are sampled
// directly in 3D on the view direction (mx_fractal_noise_float(dir * scale))
// instead of the baseline's planar `v.xz / h` projection — that division blows
// up near the horizon (h -> 0); sampling in 3D sidesteps the singularity
// entirely without needing a grazing-angle clamp hack.
//
// The dome follows the camera every frame (see main.js) and renders with
// depthTest/depthWrite off at a very low renderOrder, so it always reads as
// "infinitely far away" without needing the classic `gl_Position.z = w` pin.
// -----------------------------------------------------------------------------
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, float, mix, pow, clamp, smoothstep, dot, max, normalize,
  positionWorld, cameraPosition, time, floor, hash, step, mx_fractal_noise_float, mx_noise_float,
} from 'three/tsl';

export function createSky(environment) {
  const u = environment.u;

  const colorNode = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition));

    const hUp = clamp(dir.y, 0.0, 1.0);
    const hDown = clamp(dir.y.negate(), 0.0, 1.0);

    const skyCol = mix(u.horizon, u.zenith, pow(hUp, 0.45));
    const groundCol = mix(u.horizon, u.ground, pow(hDown, 0.6));
    const horizonBlend = smoothstep(-0.04, 0.04, dir.y);
    const base = mix(groundCol, skyCol, horizonBlend).toVar();

    // --- stars: hash the quantized view direction, sparse threshold + twinkle
    const cell = floor(dir.mul(420.0));
    const starSeed = cell.x.add(cell.y.mul(157.13)).add(cell.z.mul(113.7));
    const starHash = hash(starSeed);
    const twinkle = hash(starSeed.add(floor(time.mul(2.0)))).mul(0.7).add(0.3);
    const starMask = step(0.9975, starHash).mul(hUp).mul(twinkle);
    base.addAssign(vec3(0.85, 0.92, 1.0).mul(starMask).mul(u.starIntensity));

    // --- clouds: two fbm layers sampled in 3D on the view direction (no planar
    // divide, no grazing-angle singularity), scrolled by wind over time.
    const wind = u.windDir.mul(u.windSpeed).mul(time);
    const p1 = dir.mul(2.6).add(vec3(wind.x, 0.0, wind.y));
    const p2 = dir.mul(6.1).add(vec3(wind.x.mul(1.8), 0.0, wind.y.mul(1.8))).add(vec3(11.3, 0.0, 4.7));
    const n1 = mx_fractal_noise_float(p1, 5, 2.0, 0.55);
    const n2 = mx_fractal_noise_float(p2, 4, 2.0, 0.5);
    const density = n1.mul(0.65).add(n2.mul(0.35)).mul(0.5).add(0.5);
    const coverageEdge = float(1.0).sub(u.cloudCoverage);
    const cloudMask = smoothstep(coverageEdge, coverageEdge.add(0.3), density).mul(hUp);
    const sunFacing = clamp(dot(dir, u.sunDir).mul(0.5).add(0.5), 0.0, 1.0);
    const cloudLit = mix(u.cloudColor.mul(0.45), u.cloudColor, sunFacing);
    base.assign(mix(base, cloudLit, cloudMask.mul(u.cloudOpacity)));

    const cloudOcclusion = float(1.0).sub(cloudMask.mul(0.85));

    // --- sun: disc + falloff glow
    const sunDot = clamp(dot(dir, u.sunDir), 0.0, 1.0);
    const sunDisc = smoothstep(float(1.0).sub(u.sunSize), float(1.0).sub(u.sunSize.mul(0.5)), sunDot);
    const sunGlow = pow(sunDot, 8.0).mul(u.sunGlow);
    base.addAssign(u.sunColor.mul(sunDisc.mul(3.0).add(sunGlow)).mul(cloudOcclusion));

    // --- moon: disc w/ fbm crater mottling + soft glow
    const moonDot = clamp(dot(dir, u.moonDir), 0.0, 1.0);
    const moonDisc = smoothstep(float(1.0).sub(u.moonSize), float(1.0).sub(u.moonSize.mul(0.5)), moonDot);
    const moonMottle = mx_noise_float(dir.mul(50.0)).mul(0.15).add(0.85);
    const moonGlow = pow(moonDot, 26.0).mul(u.moonGlow).mul(0.35);
    base.addAssign(u.moonColor.mul(moonDisc.mul(moonMottle).add(moonGlow)).mul(cloudOcclusion));

    return base;
  });

  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: true,
  });
  material.colorNode = colorNode();

  const geometry = new THREE.SphereGeometry(1000, 32, 20);
  const dome = new THREE.Mesh(geometry, material);
  dome.renderOrder = -10000;
  dome.frustumCulled = false;
  dome.matrixAutoUpdate = false;

  return {
    dome,
    material,
    followCamera(camera) {
      dome.position.copy(camera.position);
      dome.updateMatrix();
    },
  };
}
