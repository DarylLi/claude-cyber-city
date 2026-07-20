// -----------------------------------------------------------------------------
// Node-based post-processing pipeline (three/addons TSL display nodes), built
// fresh per quality tier since three.js's PostProcessing graph is just a Node
// assignment — swapping `outputNode` on tier change is cheap and clean, no
// manual pass bookkeeping like the classic EffectComposer needed.
//
// Chain order (skip stages the active quality tier doesn't ask for):
//   scenePass -> [GTAO] -> bloom -> rain lens streaks -> [depth of field] ->
//   [chromatic aberration] -> vignette (speed-gated) -> [film grain] ->
//   (PostProcessing auto-appends ACES tonemap + color space conversion)
//
// DoF is gated by the `aim` uniform (right-mouse "zoom-in" state driven by
// the camera rig) rather than removed from the graph entirely while idle —
// a full graph rebuild per key-press would be visible as a hitch, so instead
// bokehScale collapses to ~0 at rest, which is effectively a no-op blur radius.
// -----------------------------------------------------------------------------
import * as THREE from 'three/webgpu';
import {
  pass, mrt, output, normalView, uniform, vec2, vec3, vec4, float, screenUV,
  length, smoothstep, mix, time, mx_fractal_noise_float,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { QUALITY } from '../config/presets.js';

export class PostFX {
  constructor(renderer, scene, camera, environment) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.environment = environment;

    this.postProcessing = new THREE.RenderPipeline(renderer);

    this.speedNormalized = uniform(0.0);

    this.aimAmount = uniform(0.0);
    this.focusDistance = uniform(38.0);
    this.focalLength = uniform(26.0);
    this.bokehScale = uniform(0.0);
    this._aimTarget = 0;

    this.build('medium');
  }

  build(qualityKey) {
    const quality = QUALITY[qualityKey];
    this.qualityKey = qualityKey;
    this.quality = quality;

    const scenePass = pass(this.scene, this.camera);
    if (quality.ao) {
      scenePass.setMRT(mrt({ output, normal: normalView }));
    }
    this.scenePass = scenePass;

    const sceneColor = scenePass.getTextureNode('output');
    let chain = sceneColor;

    if (quality.ao) {
      const sceneNormal = scenePass.getTextureNode('normal');
      const sceneDepth = scenePass.getTextureNode('depth');
      const aoPass = ao(sceneDepth, sceneNormal, this.camera);
      aoPass.resolutionScale = 0.5;
      // GTAONode renders to a single-channel RedFormat target — its texture
      // node's g/b/a are NOT the scene's color, they're 0/0/1 from sampling a
      // one-component texture as vec4. Multiplying that raw vec4 straight
      // against `chain` (as we used to) crushes every pixel's G/B to zero,
      // which reads as a solid red wash once bright de-saturated content
      // (a blue daytime sky, white daylight) gets its color destroyed this
      // way — dramatic in daylight, easy to miss against an already-warm
      // night palette, but wrong in both. Broadcast just the .r occlusion
      // scalar across the color instead (matches the documented usage in
      // GTAONode.js's own JSDoc example).
      chain = chain.mul(aoPass.getTextureNode().r);
    }

    // NOTE: BloomNode's constructor does `this.strength = uniform(strength)` —
    // TSL's uniform() factory unwraps any Node argument to its value AT THAT
    // INSTANT rather than keeping a live reference, so passing our own live
    // uniforms in here would silently freeze bloom at whatever value it had
    // when the graph was built. Pass plain numbers instead and drive the
    // node's own internal uniforms directly from update().
    const bloomPass = bloom(chain, this.environment.current.bloomStrength, this.environment.current.bloomRadius, this.environment.current.bloomThreshold);
    this.bloomPass = bloomPass;
    chain = chain.add(bloomPass);

    if (quality.rainStreaks) {
      chain = this._rainOverlay(chain);
    }

    if (quality.dof) {
      const viewZ = scenePass.getViewZNode();
      chain = dof(chain, viewZ, this.focusDistance, this.focalLength, this.bokehScale);
    }

    if (quality.chromaticAberration) {
      const strength = this.speedNormalized.mul(0.006).add(this.aimAmount.mul(0.01)).add(0.0006);
      // NOTE: this addon's JSDoc claims `center=null` defaults to screen center,
      // but its setup() forwards the raw null straight into the TSL Fn graph and
      // throws on build() — pass the center explicitly instead of relying on that.
      chain = chromaticAberration(chain, strength, vec2(0.5, 0.5), 1.15);
    }

    chain = this._vignette(chain);

    if (quality.filmGrain) {
      chain = film(chain, 0.1);
    }

    this.postProcessing.outputNode = chain;
    this.postProcessing.needsUpdate = true;
  }

  _rainOverlay(node) {
    const u = this.environment.u;
    const suv = screenUV;
    const scroll = vec2(0.015, 1.0).mul(time).mul(u.windSpeed.add(0.4));
    const n = mx_fractal_noise_float(vec3(suv.mul(vec2(11.0, 17.0)).add(scroll), 0.0), 3, 2.2, 0.55);
    const drop = smoothstep(0.5, 0.85, n).mul(u.rainAmount);
    const darken = mix(1.0, 0.85, drop);
    const tint = vec3(0.7, 0.78, 0.92).mul(drop).mul(0.05);
    return vec4(node.rgb.mul(darken).add(tint), node.a);
  }

  _vignette(node) {
    const d = length(screenUV.sub(vec2(0.5, 0.5)));
    const strength = mix(0.22, 0.5, this.speedNormalized);
    const v = smoothstep(0.35, 0.95, d).mul(strength);
    return vec4(node.rgb.mul(float(1.0).sub(v)), node.a);
  }

  setSpeed(v) {
    this.speedNormalized.value = v;
  }

  setAiming(active) {
    this._aimTarget = active ? 1 : 0;
  }

  update(dt) {
    if (this.bloomPass) {
      this.bloomPass.strength.value = this.environment.current.bloomStrength;
      this.bloomPass.radius.value = this.environment.current.bloomRadius;
      this.bloomPass.threshold.value = this.environment.current.bloomThreshold;
    }

    this.aimAmount.value += (this._aimTarget - this.aimAmount.value) * (1 - Math.exp(-8 * dt));
    this.bokehScale.value = this.aimAmount.value * 3.2;
    this.focalLength.value = 26 - this.aimAmount.value * 10;
  }

  render() {
    this.postProcessing.render();
  }
}
