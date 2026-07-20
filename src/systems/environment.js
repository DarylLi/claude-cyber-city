// -----------------------------------------------------------------------------
// Environment: the single source of truth for time-of-day + weather.
//
// Follows the baseline's "one preset object drives everything" trick, but goes
// one better — instead of snapping every uniform/light/fog value at once when
// the preset changes, we exponentially smooth toward the target every frame.
// Sky colors, sun/moon position, hemi/key lights, fog, bloom params, exposure,
// wetness and neon intensity all ride the same blend so a ToD or weather
// change reads as one coherent transition instead of independent tweens
// drifting out of sync.
// -----------------------------------------------------------------------------
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { TIME_OF_DAY, WEATHER } from '../config/presets.js';

const TOD_LERP_RATE = 1.6;       // per-second exponential smoothing rate for ToD blend
const WEATHER_LERP_RATE = 0.5;   // weather rolls in slower — it should feel like it's "arriving"

const NUMERIC_KEYS = [
  'sunSize', 'sunGlow', 'moonSize', 'moonGlow', 'starIntensity', 'sunElevation', 'sunAzimuth',
  'moonElevation', 'moonAzimuth', 'cloudCoverage', 'cloudOpacity', 'hemiIntensity', 'keyIntensity',
  'exposure', 'bloomStrength', 'bloomRadius', 'bloomThreshold', 'fogDensity', 'envIntensity', 'neonBoost',
];
const VEC3_KEYS = ['zenith', 'horizon', 'ground', 'sunColor', 'moonColor', 'cloudColor', 'hemiSky', 'hemiGround', 'keyColor', 'fogColor'];

function dirFromElevAzim(elevationDeg, azimuthDeg) {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    this.todKey = 'night';
    this.weatherKey = 'clear';

    this.blend = this._snapshot(TIME_OF_DAY[this.todKey]);
    this.weatherBlend = { rainAmount: 0, fogMul: 1, cloudCoverageAdd: 0, windMul: 1 };
    this.wetness = 0;

    // TSL uniforms consumed by the sky dome / city / weather node materials.
    this.u = {
      zenith: uniform(new THREE.Vector3()),
      horizon: uniform(new THREE.Vector3()),
      ground: uniform(new THREE.Vector3()),
      sunDir: uniform(new THREE.Vector3(0, 1, 0)),
      sunColor: uniform(new THREE.Vector3()),
      sunSize: uniform(0.04),
      sunGlow: uniform(1.0),
      moonDir: uniform(new THREE.Vector3(0, -1, 0)),
      moonColor: uniform(new THREE.Vector3()),
      moonSize: uniform(0.03),
      moonGlow: uniform(1.0),
      starIntensity: uniform(0.0),
      cloudColor: uniform(new THREE.Vector3()),
      cloudCoverage: uniform(0.4),
      cloudOpacity: uniform(0.5),
      windDir: uniform(new THREE.Vector2(1, 0.4)),
      windSpeed: uniform(0.015),
      neonBoost: uniform(1.0),
      wetness: uniform(0.0),
      rainAmount: uniform(0.0),
    };

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1.0);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.moonLight = new THREE.DirectionalLight(0xaaccff, 0.0);
    scene.add(this.hemi, this.sunLight, this.moonLight);

    this.fog = new THREE.FogExp2(0x000000, 0.006);
    scene.fog = this.fog;

    this.current = {};
    this._applyImmediate();
  }

  setTimeOfDay(key) { this.todKey = key; }
  setWeather(key) { this.weatherKey = key; }

  _snapshot(preset) {
    const out = {};
    for (const k of NUMERIC_KEYS) out[k] = preset[k];
    for (const k of VEC3_KEYS) out[k] = preset[k].slice();
    return out;
  }

  _applyImmediate() {
    this.blend = this._snapshot(TIME_OF_DAY[this.todKey]);
    this._pushToUniforms();
  }

  update(dt) {
    const targetTod = TIME_OF_DAY[this.todKey];
    const targetWeather = WEATHER[this.weatherKey];
    const k = 1 - Math.exp(-TOD_LERP_RATE * dt);
    const kw = 1 - Math.exp(-WEATHER_LERP_RATE * dt);

    for (const key of NUMERIC_KEYS) {
      this.blend[key] += (targetTod[key] - this.blend[key]) * k;
    }
    for (const key of VEC3_KEYS) {
      const t = targetTod[key];
      const b = this.blend[key];
      b[0] += (t[0] - b[0]) * k;
      b[1] += (t[1] - b[1]) * k;
      b[2] += (t[2] - b[2]) * k;
    }

    this.weatherBlend.rainAmount += (targetWeather.rainAmount - this.weatherBlend.rainAmount) * kw;
    this.weatherBlend.fogMul += (targetWeather.fogMul - this.weatherBlend.fogMul) * kw;
    this.weatherBlend.cloudCoverageAdd += (targetWeather.cloudCoverageAdd - this.weatherBlend.cloudCoverageAdd) * kw;
    this.weatherBlend.windMul += (targetWeather.windMul - this.weatherBlend.windMul) * kw;

    // Wetness rises fast once rain starts, drains slowly after — sells the
    // "streets are still wet from the storm that just passed" read.
    const wetTarget = Math.max(targetWeather.wetnessTarget, this.weatherBlend.rainAmount);
    const wetRate = wetTarget > this.wetness ? 0.75 : 0.10;
    this.wetness += (wetTarget - this.wetness) * (1 - Math.exp(-wetRate * dt * 3));

    this._pushToUniforms(dt);
  }

  _pushToUniforms(dt = 0) {
    const b = this.blend;
    this.u.zenith.value.set(b.zenith[0], b.zenith[1], b.zenith[2]);
    this.u.horizon.value.set(b.horizon[0], b.horizon[1], b.horizon[2]);
    this.u.ground.value.set(b.ground[0], b.ground[1], b.ground[2]);
    this.u.sunColor.value.set(b.sunColor[0], b.sunColor[1], b.sunColor[2]);
    this.u.sunSize.value = b.sunSize;
    this.u.sunGlow.value = b.sunGlow;
    this.u.moonColor.value.set(b.moonColor[0], b.moonColor[1], b.moonColor[2]);
    this.u.moonSize.value = b.moonSize;
    this.u.moonGlow.value = b.moonGlow;
    this.u.starIntensity.value = b.starIntensity;
    this.u.cloudColor.value.set(b.cloudColor[0], b.cloudColor[1], b.cloudColor[2]);
    this.u.cloudCoverage.value = Math.min(1, b.cloudCoverage + this.weatherBlend.cloudCoverageAdd);
    this.u.cloudOpacity.value = b.cloudOpacity;
    this.u.windSpeed.value = 0.015 * this.weatherBlend.windMul;
    this.u.neonBoost.value = b.neonBoost;
    this.u.wetness.value = this.wetness;
    this.u.rainAmount.value = this.weatherBlend.rainAmount;

    const sunDir = dirFromElevAzim(b.sunElevation, b.sunAzimuth);
    const moonDir = dirFromElevAzim(b.moonElevation, b.moonAzimuth);
    this.u.sunDir.value.copy(sunDir);
    this.u.moonDir.value.copy(moonDir);

    this.sunLight.position.copy(sunDir).multiplyScalar(400);
    this.sunLight.color.setRGB(b.sunColor[0], b.sunColor[1], b.sunColor[2]);
    this.sunLight.intensity = b.keyIntensity * Math.max(0, sunDir.y) * 3.0;

    this.moonLight.position.copy(moonDir).multiplyScalar(400);
    this.moonLight.color.setRGB(b.moonColor[0], b.moonColor[1], b.moonColor[2]);
    this.moonLight.intensity = Math.max(0, moonDir.y) * 0.6;

    this.hemi.color.setRGB(b.hemiSky[0], b.hemiSky[1], b.hemiSky[2]);
    this.hemi.groundColor.setRGB(b.hemiGround[0], b.hemiGround[1], b.hemiGround[2]);
    this.hemi.intensity = b.hemiIntensity;

    this.fog.color.setRGB(b.fogColor[0], b.fogColor[1], b.fogColor[2]);
    this.fog.density = b.fogDensity * this.weatherBlend.fogMul;

    this.renderer.toneMappingExposure = b.exposure;

    this.current.bloomStrength = b.bloomStrength;
    this.current.bloomRadius = b.bloomRadius;
    this.current.bloomThreshold = b.bloomThreshold;
    this.current.envIntensity = b.envIntensity;
    this.current.wetness = this.wetness;
    this.current.rainAmount = this.weatherBlend.rainAmount;
    this.current.windMul = this.weatherBlend.windMul;
    this.current.fogDensity = this.fog.density;
    this.current.fogColor = this.fog.color;
  }
}
