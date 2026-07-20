// Small TSL helpers shared across city / weather materials.
import { Fn, mix, pow, clamp, reflect, normalize, dot, positionWorld, cameraPosition } from 'three/tsl';

// Cheap "fake IBL": re-derives the sky's zenith/horizon gradient along the
// reflection vector instead of sampling a real environment map. No PMREM
// bake, no extra render target, and it's always exactly in sync with the
// current (smoothly-blended) time-of-day — good enough for stylized wet
// asphalt / glass without paying for SSR or a probe re-render on every ToD
// or weather change.
export const fakeSkyReflection = Fn(([normalW, envUniforms]) => {
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const reflectDir = reflect(viewDir.negate(), normalW);
  const t = pow(clamp(reflectDir.y.mul(0.5).add(0.5), 0.0, 1.0), 0.45);
  return mix(envUniforms.horizon, envUniforms.zenith, t);
});

// Schlick fresnel, view vs. surface normal.
export const fresnelTerm = Fn(([normalW, power]) => {
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  return pow(clamp(dot(viewDir, normalW).oneMinus(), 0.0, 1.0), power);
});
