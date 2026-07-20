// -----------------------------------------------------------------------------
// HUD — a small lil-gui panel for time-of-day / weather / quality tier / camera
// mode, plus a live FPS readout. Kept deliberately thin: all the actual state
// lives in Environment/PostFX/CameraRig, this just wires controls to it.
// -----------------------------------------------------------------------------
import GUI from 'lil-gui';
import { TIME_OF_DAY, WEATHER, QUALITY } from '../config/presets.js';

export function createHUD({ environment, postfx, rig, initialQuality, onQualityChange }) {
  const gui = new GUI({ title: 'NEON MERIDIAN · 控制面板' });

  const todOptions = {};
  for (const [key, preset] of Object.entries(TIME_OF_DAY)) todOptions[preset.label] = key;

  const weatherOptions = {};
  for (const [key, preset] of Object.entries(WEATHER)) weatherOptions[preset.label] = key;

  const qualityOptions = {};
  for (const [key, preset] of Object.entries(QUALITY)) qualityOptions[preset.label] = key;

  const state = {
    timeOfDay: 'night',
    weather: 'clear',
    quality: initialQuality,
    cameraMode: 'F 切换到飞行模式',
    autoOrbit: true,
  };

  const envFolder = gui.addFolder('环境 · Environment');
  envFolder.add(state, 'timeOfDay', todOptions).name('时段 Time of Day').onChange((key) => environment.setTimeOfDay(key));
  envFolder.add(state, 'weather', weatherOptions).name('天气 Weather').onChange((key) => environment.setWeather(key));

  const qualityFolder = gui.addFolder('画质 · Quality');
  qualityFolder.add(state, 'quality', qualityOptions).name('渲染质量 Tier').onChange((key) => onQualityChange(key));

  const cameraFolder = gui.addFolder('相机 · Camera');
  cameraFolder.add(state, 'cameraMode').name('模式 Mode').disable().listen();
  cameraFolder
    .add(state, 'autoOrbit')
    .name('环绕模式自动旋转')
    .onChange((v) => {
      rig.autoOrbit = v;
    });

  const statsFolder = gui.addFolder('状态 · Stats');
  const stats = { fps: 0, wetness: 0, rain: 0, buildings: 0 };
  statsFolder.add(stats, 'fps').name('FPS').disable().listen();
  statsFolder.add(stats, 'buildings').name('建筑 Buildings').disable().listen();
  statsFolder.add(stats, 'rain').name('降雨强度 Rain').disable().listen();
  statsFolder.add(stats, 'wetness').name('路面湿度 Wetness').disable().listen();

  return {
    gui,
    stats,
    state,
    setCameraModeLabel(text) {
      state.cameraMode = text;
    },
  };
}
