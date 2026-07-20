// -----------------------------------------------------------------------------
// Real-asset city loader.
//
// This REPLACES the earlier pure-procedural BoxGeometry city with the actual
// reverse-engineered "Cyberpunk Megapolis" GLB pack (Unity asset -> FBX ->
// glTF/GLB export, per .claude/skills/threejs-webgpu-cyberpunk-city/SKILL.md),
// driven by its own authored placement list (public/citypack/data/scene.json,
// 2774 transforms) instead of a seeded PRNG — same core trick as the
// reference build (one InstancedMesh per prefab/material pair for the draw
// call budget), ported to run under THREE.WebGPURenderer and feed our own
// collision/camera/weather systems instead of its parkour game.
//
// What's intentionally NOT ported: the player/parkour controller, vehicle
// animation, decal occlusion, deck-clutter/belt scatter jsons. Those are game
// mechanics for the reference's web-slinger demo, not city visuals.
// -----------------------------------------------------------------------------
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const BASE = '/citypack/';

// Coordinate convention (matches the reference build): the glTF export is the
// X-mirror of the authored Unity world, so instance transforms are
// CONJUGATED — pos(-x,y,z), quat(x,-y,-z,w), scale unchanged.
const convPos = (t) => new THREE.Vector3(-t[0], t[1], t[2]);
const convQuat = (r) => new THREE.Quaternion(r[0], -r[1], -r[2], r[3]);
// three's PropertyBinding.sanitizeNodeName, applied by GLTFLoader to node names
const sanitize = (s) => s.replace(/\s/g, '_').replace(/[[\].:\\/]/g, '');
const strip = (n) => n.replace(/\.\d{3}$/, ''); // Blender ".001" suffixes

const LOD_RE = /_lod[1-9]\d*(?:[_.]|$)/i;
const COLLIDER_RE = /collider/i;
const DECK_UV_DENSITY = 1.5e-6; // photo-tile baseline ~= (1/200 m)^2

async function fetchJSON(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`citypack: failed to fetch ${path} (${res.status})`);
  return res.json();
}

export async function loadCityAssets(renderer, { onProgress } = {}) {
  const manager = new THREE.LoadingManager();
  if (onProgress) manager.onProgress = (_url, loaded, total) => onProgress(loaded / Math.max(total, 1));

  const [MATS, PREFABS, SCALES, SCENE, SIGN_FIXES, FBXORD] = await Promise.all([
    fetchJSON('data/materials.json'), fetchJSON('data/prefabs.json'),
    fetchJSON('data/scales.json'), fetchJSON('data/scene.json'),
    fetchJSON('data/sign_fixes.json'), fetchJSON('data/fbx_mat_order.json'),
  ]);

  // Synthetic material for elevated deck/plate surfaces whose authored UVs
  // stretch the city-photo texture into blank gray "steel plates" (see the
  // per-triangle rebuild in bakePrefab below).
  MATS.CP_Deck = {
    tex: 'CP_Concrete_03_A.tga', normalTex: 'CP_Concrete_03_N.tga',
    texScale: [1, 1], color: [0.32, 0.335, 0.365, 1], emission: [0, 0, 0, 1],
    metallic: 0, smoothness: 0.08, mode: 0, cutoff: 0.5, bumpScale: 1,
  };

  // ---------- textures ----------
  const maxAniso = renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy() : 8;
  const texCache = {};
  const texFile = (file) => file.replace(/\.(tga|psd|tif|png|webp)$/i, '') + '.webp';
  // NOTE: tiled variants get their OWN TextureLoader.load() call (browser HTTP
  // cache dedups the actual network fetch) rather than a .clone() of a
  // possibly-still-loading base texture. A clone shares the same (possibly
  // still-null) `.image` reference; forcing `needsUpdate = true` on it right
  // away — before the shared image has actually finished decoding — bumps
  // `texture.version` while `image` is still null, which crashes three's
  // upload path (`image.complete` on a null image). Loading fresh keeps
  // `needsUpdate` correctly gated behind the loader's own onLoad.
  function texture(file, srgb = true, repeat = null) {
    file = texFile(file);
    const key = file + (srgb ? '' : '#lin') + (repeat ? `#${repeat[0]}x${repeat[1]}` : '');
    if (!texCache[key]) {
      const t = new THREE.TextureLoader(manager).load(BASE + 'textures/' + encodeURIComponent(file));
      t.flipY = false; // glTF UV convention
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = maxAniso;
      if (repeat) t.repeat.set(repeat[0], repeat[1]);
      texCache[key] = t;
    }
    return texCache[key];
  }
  // Unity MetallicSmoothness (R=metallic, A=smoothness) -> three metalnessMap(B)/roughnessMap(G).
  //
  // Preloaded up front (see preloadMetalRough() below) rather than lazily on
  // first matFor() use: assigning metalnessMap/roughnessMap to a material
  // AFTER it has already rendered a frame forces a structural NodeMaterial
  // rebuild mid-session, which under the WebGPU backend raced with an
  // in-flight frame and produced an "Invalid Texture" GPUValidationError that
  // then wedged the render loop permanently. Loading every MS texture before
  // any material referencing it is ever constructed removes the race
  // entirely — matFor() below only ever does a synchronous cache lookup.
  const msCache = {};
  function packMetalRough(file) {
    const url = BASE + 'textures/' + encodeURIComponent(texFile(file));
    if (msCache[url]) return msCache[url];
    return (msCache[url] = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
        for (let i = 0; i < px.length; i += 4) {
          const metal = px[i], smooth = px[i + 3];
          px[i + 1] = 255 - smooth; // G = roughness
          px[i + 2] = metal;        // B = metalness
          px[i] = 0; px[i + 3] = 255;
        }
        ctx.putImageData(d, 0, 0);
        const t = new THREE.CanvasTexture(c);
        t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.LinearSRGBColorSpace;
        t.anisotropy = maxAniso;
        resolve(t);
      };
      img.onerror = () => { console.warn('citypack: MS texture missing', url); resolve(null); };
      img.src = url;
    }));
  }
  const msReady = {}; // url -> resolved CanvasTexture (or null), filled by preloadMetalRough()
  async function preloadMetalRough(materials) {
    const files = new Set();
    for (const name in materials) if (materials[name].metalTex) files.add(materials[name].metalTex);
    await Promise.all([...files].map(async (f) => {
      const url = BASE + 'textures/' + encodeURIComponent(texFile(f));
      msReady[url] = await packMetalRough(f);
    }));
  }

  // ---------- material factory ----------
  const matCache = {};
  // {mat, baseRoughness} pairs — driven by applyWetness() every frame so rain
  // reads on the REAL facades/streets, not just as a rain-particle overlay.
  const wetMaterials = [];
  // Only used for the packMetalRough CanvasTexture, whose `.image` (a canvas)
  // is already fully drawn and synchronously "complete" — safe to clone +
  // force-update immediately, unlike a network-loaded Texture (see `texture()`).
  function tiledClone(base, repeat) {
    const t = base.clone();
    t.needsUpdate = true;
    t.repeat.set(repeat[0], repeat[1]);
    return t;
  }
  function matFor(name) {
    if (!name || !MATS[name]) name = 'CP_Base';
    if (matCache[name]) return matCache[name];
    const i = MATS[name], m = new THREE.MeshStandardMaterial({ name });
    const rep = i.texScale || [1, 1], tiled = rep[0] !== 1 || rep[1] !== 1;
    m.color.setRGB(i.color[0], i.color[1], i.color[2], THREE.SRGBColorSpace);
    if (i.tex) m.map = texture(i.tex, true, tiled ? rep : null);
    if (i.normalTex) {
      m.normalMap = texture(i.normalTex, false, tiled ? rep : null);
      m.normalScale.setScalar(i.bumpScale ?? 1);
    }
    if (i.metalTex) {
      m.metalness = 1; m.roughness = 1;
      // Already resolved by preloadMetalRough() before any matFor() call —
      // synchronous lookup only, so the map is present from the material's
      // very first build (no post-hoc mutation / rebuild race).
      const url = BASE + 'textures/' + encodeURIComponent(texFile(i.metalTex));
      const t = msReady[url];
      if (t) {
        m.metalnessMap = tiled ? tiledClone(t, rep) : t;
        m.roughnessMap = m.metalnessMap;
      }
    } else {
      m.metalness = Math.min(i.metallic ?? 0, 0.5);
      m.roughness = THREE.MathUtils.clamp(1 - (i.smoothness ?? 0.3), 0.35, 1);
    }
    if (i.aoTex) { m.aoMap = texture(i.aoTex, false); m.aoMapIntensity = 1; }
    if (i.emission[0] + i.emission[1] + i.emission[2] > 0.03) {
      m.emissive.setRGB(i.emission[0], i.emission[1], i.emission[2], THREE.SRGBColorSpace);
      m.emissiveMap = i.emisTex ? texture(i.emisTex) : (m.map || null);
    }
    if (i.mode === 1) {                  // cutout (signboards, grates)
      m.alphaTest = i.cutoff ?? 0.5;
      m.alphaToCoverage = true;
    } else if (i.mode >= 2) {            // transparent (decals, glass)
      m.transparent = true;
      m.opacity = Math.max(i.color[3], 0.25);
      m.depthWrite = false;
      m.side = THREE.DoubleSide;
      m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
    }
    matCache[name] = m;
    wetMaterials.push({ mat: m, baseRoughness: m.roughness });
    return m;
  }

  // ---------- GLB category templates ----------
  const dracoLoader = new DRACOLoader(manager).setDecoderPath('/draco/');
  const glbLoader = new GLTFLoader(manager).setDRACOLoader(dracoLoader);
  const glbFiles = ['Background', 'Car', 'Combined_Building', 'Decals', 'Environment',
    'Facade_Details', 'Metro', 'Modules', 'Street'];
  const templates = {}; // sanitized model name -> ROOT_ node
  // Runs alongside the GLB fetches — independent network/CPU work, and every
  // matFor() call below (triggered once GLBs finish loading) needs msReady
  // already populated.
  const msPreload = preloadMetalRough(MATS);
  await Promise.all(glbFiles.map((f) => glbLoader.loadAsync(BASE + 'glb/' + f + '.glb').then((gltf) => {
    gltf.scene.traverse((o) => {
      if (o.name.startsWith('ROOT_')) {
        const name = o.name.slice(5);
        templates[name] = o;
        o.userData.skinned = false;
        o.traverse((c) => { if (c.isSkinnedMesh) o.userData.skinned = true; });
        const gs = SCALES[name];
        if (gs && gs !== 1) for (const c of o.children) {
          c.scale.multiplyScalar(gs); c.position.multiplyScalar(gs);
        }
      }
    });
  })));
  await msPreload; // must finish before assignMaterials()/matFor() run below

  // ---------- bind materials to primitives ----------
  const partsByModel = {};
  for (const pn in PREFABS) {
    const p = PREFABS[pn];
    if (p.model && p.parts) partsByModel[p.model] = p.parts;
  }
  function assignMaterials(modelName) {
    const tpl = templates[sanitize(modelName)];
    if (!tpl || tpl.userData.matsDone) return tpl;
    tpl.userData.matsDone = true;
    const parts = {};
    const raw = partsByModel[modelName] || {};
    for (const k in raw) parts[sanitize(strip(k))] = raw[k];
    const orders = {};
    const rawOrd = FBXORD[modelName] || {};
    for (const k in rawOrd) orders[sanitize(strip(k))] = rawOrd[k];
    tpl.traverse((o) => {
      if (!o.isMesh) return;
      const key = sanitize(strip(o.name));
      const parentKey = o.parent ? sanitize(strip(o.parent.name)) : '';
      const fbxName = (o.material?.name || '').replace(/\.\d+$/, '');
      const mats = parts[key] || parts[parentKey];
      if (mats?.length) {
        const order = orders[key] || orders[parentKey];
        let idx = order ? order.indexOf(fbxName) : -1;
        if (idx < 0) {
          const sibs = o.parent.children.filter((c) => c.isMesh);
          idx = sibs.length > 1 ? Math.min(Math.max(sibs.indexOf(o), 0), mats.length - 1) : 0;
        }
        o.material = matFor(mats[Math.min(idx, mats.length - 1)]);
      } else if (MATS[fbxName]) {
        o.material = matFor(fbxName);
      } else {
        o.material = matFor(null);
      }
    });
    return tpl;
  }

  // ---------- bake each prefab: one merged geometry per material ----------
  function normalizeGeo(g, world) {
    const out = g.clone().applyMatrix4(world);
    for (const k of Object.keys(out.attributes)) {
      if (!['position', 'normal', 'uv', 'uv2'].includes(k)) out.deleteAttribute(k);
    }
    if (!out.attributes.uv) {
      out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2));
    }
    if (!out.attributes.uv2) {
      out.setAttribute('uv2', new THREE.BufferAttribute(out.attributes.uv.array.slice(0), 2));
    }
    out.morphAttributes = {};
    return out;
  }
  const bakeCache = {};
  function bakePrefab(prefabName) {
    if (bakeCache[prefabName] !== undefined) return bakeCache[prefabName];
    const model = PREFABS[prefabName]?.model;
    const tpl = model && assignMaterials(model);
    if (!tpl || tpl.userData.skinned) return (bakeCache[prefabName] = null);
    tpl.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(tpl.matrixWorld).invert();
    const byMat = new Map();
    tpl.traverse((o) => {
      if (!o.isMesh) return;
      if (LOD_RE.test(o.name) || (o.parent && LOD_RE.test(o.parent.name))) return;
      if (COLLIDER_RE.test(o.name) || (o.parent && COLLIDER_RE.test(o.parent.name))) return;
      const rel = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
      const list = byMat.get(o.material) || byMat.set(o.material, []).get(o.material);
      list.push(normalizeGeo(o.geometry, rel));
    });
    const merged = [];
    for (const [mat, geos] of byMat) {
      const g = geos.length === 1 ? geos[0] : BufferGeometryUtils.mergeGeometries(geos, false);
      if (g) merged.push({ geo: g, mat });
    }
    // Stacked-city surfaces: some ground/deck primitives hold base grounds AND
    // elevated plates whose authored UVs collapse onto the photo texture's
    // highway strip — from the air they read as blank "steel plates". Detect
    // degenerate mapping PER TRIANGLE (uv-area vs world-area density) and
    // rebuild those faces with planar UVs + tiled concrete; healthy faces keep
    // the authored photo mapping.
    for (let mi = merged.length - 1; mi >= 0; mi--) {
      const isCG = merged[mi].mat.name === 'CP_City_Ground';
      if (merged[mi].mat === matFor('CP_Deck')) continue;
      const src = merged[mi].geo.index ? merged[mi].geo.toNonIndexed() : merged[mi].geo;
      const p = src.attributes.position, srcUv = src.attributes.uv;
      if (!srcUv) continue;
      const bp = [], bu = [], dp = [];
      const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
      for (let t = 0; t < p.count; t += 3) {
        e1.set(p.getX(t + 1) - p.getX(t), p.getY(t + 1) - p.getY(t), p.getZ(t + 1) - p.getZ(t));
        e2.set(p.getX(t + 2) - p.getX(t), p.getY(t + 2) - p.getY(t), p.getZ(t + 2) - p.getZ(t));
        cr.crossVectors(e1, e2);
        const worldArea = cr.length() / 2;
        const horiz = worldArea > 0 && Math.abs(cr.y) / (worldArea * 2) > 0.75;
        const du1 = srcUv.getX(t + 1) - srcUv.getX(t), dv1 = srcUv.getY(t + 1) - srcUv.getY(t);
        const du2 = srcUv.getX(t + 2) - srcUv.getX(t), dv2 = srcUv.getY(t + 2) - srcUv.getY(t);
        const uvArea = Math.abs(du1 * dv2 - du2 * dv1) / 2;
        const density = uvArea / Math.max(worldArea, 1e-9);
        const degenerate = horiz && (worldArea > 2500 ||
          (isCG && worldArea > 1 && density < DECK_UV_DENSITY) ||
          (!isCG && worldArea > 4 && density < 6e-4));
        if (degenerate) {
          for (let k = 0; k < 3; k++) dp.push(p.getX(t + k), p.getY(t + k), p.getZ(t + k));
        } else {
          for (let k = 0; k < 3; k++) {
            bp.push(p.getX(t + k), p.getY(t + k), p.getZ(t + k));
            bu.push(srcUv.getX(t + k), srcUv.getY(t + k));
          }
        }
      }
      if (!dp.length) continue;
      const out = [];
      if (bp.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(bu, 2));
        geo.setAttribute('uv2', new THREE.Float32BufferAttribute(bu.slice(0), 2));
        geo.computeVertexNormals();
        out.push({ geo, mat: merged[mi].mat });
      }
      const dgeo = new THREE.BufferGeometry();
      dgeo.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
      const duv = new Float32Array((dp.length / 3) * 2);
      for (let v = 0, u = 0; v < dp.length; v += 3, u += 2) {
        duv[u] = dp[v] * 0.12; duv[u + 1] = dp[v + 2] * 0.12; // ~8.3 m tiles
      }
      dgeo.setAttribute('uv', new THREE.BufferAttribute(duv, 2));
      dgeo.setAttribute('uv2', new THREE.BufferAttribute(duv.slice(0), 2));
      dgeo.computeVertexNormals();
      out.push({ geo: dgeo, mat: matFor('CP_Deck') });
      merged.splice(mi, 1, ...out);
    }
    return (bakeCache[prefabName] = { merged });
  }

  // ---------- build the city: one InstancedMesh per (prefab, material) ----------
  const world = new THREE.Group();
  world.name = 'citypack';

  // Drop byte-identical duplicate placements (authoring errors); same-spot
  // rotated layers (density stacking) get a small lift so coplanar ground
  // planes don't z-fight.
  const dupSeen = new Map();
  const placements = [];
  const fixSign = (pl) => { // snap authored-floating billboards onto the nearest tower facade
    for (const f of SIGN_FIXES) {
      if (f.p === pl.p && Math.abs(f.ot[0] - pl.t[0]) < 0.6 &&
          Math.abs(f.ot[1] - pl.t[1]) < 0.6 && Math.abs(f.ot[2] - pl.t[2]) < 0.6) {
        return { p: pl.p, t: f.t.slice(), r: f.r.slice(), s: pl.s };
      }
    }
    return pl;
  };
  for (const pl of SCENE.placements) {
    const k = pl.p + '|' + pl.t.map((v) => v.toFixed(2)).join(',');
    const prev = dupSeen.get(k);
    if (prev) {
      if (prev.r === pl.r.join(',') && prev.s === pl.s.join(',')) continue; // exact dup
      placements.push(fixSign({ p: pl.p, t: [pl.t[0], pl.t[1] + 0.03, pl.t[2]], r: pl.r, s: pl.s }));
    } else {
      dupSeen.set(k, { r: pl.r.join(','), s: pl.s.join(',') });
      placements.push(fixSign(pl));
    }
  }
  const byPrefab = new Map();
  for (const pl of placements) {
    if (!byPrefab.has(pl.p)) byPrefab.set(pl.p, []);
    byPrefab.get(pl.p).push(pl);
  }

  const _s = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _c = new THREE.Vector3();
  const aabbs = [];
  const bounds = new THREE.Box3();
  const cloudPlacements = [];
  let drawMeshes = 0;

  for (const [prefabName, list] of byPrefab) {
    const baked = bakePrefab(prefabName);
    if (!baked) {                                // pure-FX prefab (smoke/dust/clouds/air lanes)
      if (prefabName.startsWith('CP_Cloud')) cloudPlacements.push(...list);
      continue;
    }
    // split negative-scale instances (mirrored copies) — need DoubleSide material
    const neg = list.filter((pl) => pl.s[0] * pl.s[1] * pl.s[2] < 0);
    const pos = list.filter((pl) => pl.s[0] * pl.s[1] * pl.s[2] >= 0);
    for (const { geo, mat } of baked.merged) {
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const corners = [
        [bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.min.z],
        [bb.min.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z],
        [bb.min.x, bb.min.y, bb.max.z], [bb.max.x, bb.min.y, bb.max.z],
        [bb.min.x, bb.max.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z],
      ];
      for (const [group, flip] of [[pos, false], [neg, true]]) {
        if (!group.length) continue;
        const material = flip ? Object.assign(mat.clone(), { side: THREE.DoubleSide }) : mat;
        const im = new THREE.InstancedMesh(geo, material, group.length);
        im.userData.prefab = prefabName;
        group.forEach((pl, i) => {
          _m.compose(convPos(pl.t), convQuat(pl.r), _s.set(pl.s[0], pl.s[1], pl.s[2]));
          im.setMatrixAt(i, _m);

          // per-instance world AABB, fed to the fly-camera collision system
          let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (const co of corners) {
            _c.set(co[0], co[1], co[2]).applyMatrix4(_m);
            if (_c.x < minX) minX = _c.x; if (_c.x > maxX) maxX = _c.x;
            if (_c.y < minY) minY = _c.y; if (_c.y > maxY) maxY = _c.y;
            if (_c.z < minZ) minZ = _c.z; if (_c.z > maxZ) maxZ = _c.z;
          }
          const footprint = Math.max(maxX - minX, maxZ - minZ);
          const height = maxY - minY;
          // Giant merged ground/district plates and paper-thin decals only
          // exist to read visually — colliding against them would snag the
          // camera on every sidewalk quad. Only building-scale volumes fly-block
          // AND count toward the city's framing bounds (the pack also scatters
          // km-scale background/skybox scenery whose bounds would otherwise
          // blow up citySpan and zoom the establishing shot out to nothing).
          if (height > 1.5 && footprint <= 90) {
            aabbs.push({ minX, maxX, minY, maxY, minZ, maxZ });
            bounds.expandByPoint(new THREE.Vector3(minX, minY, minZ));
            bounds.expandByPoint(new THREE.Vector3(maxX, maxY, maxZ));
          }
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        if (mat.transparent) im.renderOrder = 2;
        world.add(im);
        drawMeshes++;
      }
    }
  }

  // ---------- scene-native meshes (neon tube/strip accents) ----------
  for (const e of SCENE.meshes || []) {
    let geo = null;
    if (e.builtin === 'Cube') geo = new THREE.BoxGeometry(1, 1, 1);
    else if (e.builtin === 'Plane') geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    else if (e.builtin === 'Cylinder') geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
    else continue;
    const mat = matFor(e.mats?.[0]);
    const mesh = new THREE.Mesh(geo, mat);
    _m.compose(convPos(e.t), convQuat(e.r), _s.set(e.s[0], e.s[1], e.s[2]));
    mesh.applyMatrix4(_m);
    world.add(mesh);
  }

  // ---------- sky clouds (billboards, camera-facing via post-fx alignment is
  // not required here — kept as soft-blended flat planes, matching source) ----------
  const cloudMeshes = [];
  for (const pl of cloudPlacements) {
    // NOTE: pass the bare prefab name, not a pre-built ".webp" filename —
    // texture()/texFile() already appends ".webp" itself (and only strips a
    // recognized source extension first), so doing it here too produced a
    // literal "*.webp.webp" 404 that Vite's dev SPA-fallback turned into a
    // 200 text/html response; the browser then failed to decode that as an
    // image, leaving an invalid GPU texture that wedged the render loop.
    const file = pl.p;
    const mat = new THREE.MeshBasicMaterial({
      map: texture(file), transparent: true, depthWrite: false,
      opacity: 0.45, side: THREE.DoubleSide, fog: true, color: 0x9aa0a8,
    });
    const sc = Math.min(pl.s[0], 20);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(30 * sc / pl.s[0], 15 * sc / pl.s[0]), mat);
    _m.compose(convPos(pl.t), convQuat(pl.r), _s.set(pl.s[0], pl.s[1], pl.s[2]));
    mesh.applyMatrix4(_m);
    mesh.renderOrder = 1;
    world.add(mesh);
    cloudMeshes.push(mesh);
  }

  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const citySpan = Math.max(size.x, size.z) / 2;

  console.log(`[citypack] ${drawMeshes} instanced meshes from ${placements.length}/${SCENE.placements.length} ` +
              `placements, ${aabbs.length} collidable AABBs, span=${citySpan.toFixed(0)}m`);

  return { group: world, aabbs, bounds, center, citySpan, cloudMeshes, instanceCount: drawMeshes,
    placementCount: placements.length, wetMaterials };
}

// Lets real weather drive the loaded PBR materials directly (rain-soaked
// facades/streets get glossier as wetness rises) instead of only showing up
// as a rain-particle overlay.
export function applyCityWetness(cityAssets, wetness) {
  for (const { mat, baseRoughness } of cityAssets.wetMaterials) {
    mat.roughness = THREE.MathUtils.clamp(baseRoughness - wetness * 0.35, 0.05, 1);
  }
}
