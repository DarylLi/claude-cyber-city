// -----------------------------------------------------------------------------
// Camera rig — two modes:
//   'orbit' — OrbitControls with a slow cinematic auto-rotate while idle,
//             for a "showcase" first impression (matches how the reference
//             project's landing camera behaves before you take over).
//   'fly'   — spectator-style free flight: mouse-drag to look, WASD to move
//             in the look direction, Shift to boost, AABB collision against
//             the generated city (src/systems/collision.js) so you can't
//             clip through towers, ground-clamped so you can't dive below
//             street level.
//
// Both modes drive the same "speed sensation via FOV kick" trick from the
// baseline (FOV eased toward a speed-scaled target — no real motion blur
// pass) and expose `speedNormalized` for the post-fx chromatic
// aberration/vignette gating.
// -----------------------------------------------------------------------------
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class CameraRig {
  // `spawn` — { position: Vector3, target: Vector3 } — must be computed by the
  // caller from the ACTUAL generated city layout (see main.js), not hardcoded
  // here: a fixed coordinate can land inside a procedurally-placed tower for
  // some seeds, which then feeds a near-zero-length vector into the fake sky
  // reflection's normalize() and (observed in testing) can blow up into NaN
  // that bloom's blur spreads across the whole frame.
  constructor(camera, domElement, collisionWorld, spawn) {
    this.camera = camera;
    this.dom = domElement;
    this.collision = collisionWorld;
    this.mode = 'orbit';

    const spawnPos = spawn?.position ?? new THREE.Vector3(95, 58, 150);
    const spawnTarget = spawn?.target ?? new THREE.Vector3(0, 26, 0);

    this.orbit = new OrbitControls(camera, domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.06;
    this.orbit.minDistance = 10;
    this.orbit.maxDistance = 420;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.target.copy(spawnTarget);
    camera.position.copy(spawnPos);
    this.orbit.update();

    this.baseFov = 55;
    camera.fov = this.baseFov;

    this.flyPos = spawnPos.clone();
    this.yaw = -2.4;
    this.pitch = -0.12;
    this.velocity = new THREE.Vector3();
    this.keys = new Set();
    this.dragging = false;
    this.lastX = 0;
    this.lastY = 0;
    this.autoOrbit = true;
    this.aiming = false;
    this.speedNormalized = 0;

    this._bindEvents();
  }

  _bindEvents() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.toggleMode();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    this.dom.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.autoOrbit = false;
        this.orbit.autoRotate = false;
      }
      if (e.button === 2) this.aiming = true;
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.dragging = false;
      if (e.button === 2) this.aiming = false;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging || this.mode !== 'fly') return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw -= dx * 0.0032;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0032, -1.35, 1.35);
    });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  toggleMode() {
    if (this.mode === 'orbit') {
      this.flyPos.copy(this.camera.position);
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.yaw = Math.atan2(dir.x, dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      this.mode = 'fly';
    } else {
      this.orbit.target.copy(this.flyPos).addScaledVector(this._forwardVector(), 35);
      this.mode = 'orbit';
      this.orbit.update();
    }
  }

  _forwardVector() {
    const cosP = Math.cos(this.pitch);
    return new THREE.Vector3(Math.sin(this.yaw) * cosP, Math.sin(this.pitch), Math.cos(this.yaw) * cosP);
  }

  // Keeps the orbit camera clear of building geometry even when it arrives at
  // a bad spot in one jump (auto-rotate/zoom don't move incrementally the way
  // the fly rig does, so collision.resolveSphere()'s edge-only push isn't
  // enough — its nearest-surface-point vector is zero, and thus can't push
  // anywhere, when the camera is already inside a footprint).
  _avoidBuildings(clearance) {
    const pos = this.camera.position;
    const nearby = this.collision.queryNearby(pos.x, pos.z, clearance + 60);
    for (const box of nearby) {
      if (pos.y < box.minY - clearance || pos.y > box.maxY + clearance) continue;
      const insideX = pos.x >= box.minX && pos.x <= box.maxX;
      const insideZ = pos.z >= box.minZ && pos.z <= box.maxZ;
      if (!insideX || !insideZ) continue;

      const cx = (box.minX + box.maxX) / 2;
      const cz = (box.minZ + box.maxZ) / 2;
      let dx = pos.x - cx;
      let dz = pos.z - cz;
      if (dx === 0 && dz === 0) dx = 1;
      const len = Math.hypot(dx, dz);
      const halfDiag = Math.hypot((box.maxX - box.minX) / 2, (box.maxZ - box.minZ) / 2);
      pos.x = cx + (dx / len) * (halfDiag + clearance);
      pos.z = cz + (dz / len) * (halfDiag + clearance);
    }
    this.collision.resolveSphere(pos, clearance);
  }

  update(dt) {
    if (this.mode === 'orbit') {
      this.orbit.autoRotate = this.autoOrbit;
      this.orbit.autoRotateSpeed = 0.35;
      this.orbit.update();

      // OrbitControls only constrains *radial* distance to the target — on a
      // fixed-radius circular sweep around a procedurally generated city that
      // says nothing about clearance from whatever building happens to sit
      // near that radius at a given angle. Auto-rotate can swing the camera
      // right up against — or, since it *teleports* along the sphere each
      // frame rather than moving incrementally, straight inside — a facade.
      // Safe to mutate position here: OrbitControls recomputes it next frame
      // from its own internal spherical state, not by reading camera.position.
      if (this.collision) this._avoidBuildings(34);

      this.camera.fov += (this.baseFov - this.camera.fov) * (1 - Math.exp(-4.5 * dt));
      this.camera.updateProjectionMatrix();
      this.speedNormalized *= 0.9;
      return;
    }

    const forward = this._forwardVector();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(forward);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(forward);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
    if (this.keys.has('Space')) move.y += 1;
    if (this.keys.has('ControlLeft') || this.keys.has('KeyC')) move.y -= 1;

    const boosting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const targetSpeed = move.lengthSq() > 0 ? (boosting ? 95 : 32) : 0;
    const targetVel = move.normalize().multiplyScalar(targetSpeed);

    this.velocity.lerp(targetVel, 1 - Math.exp(-6 * dt));
    this.flyPos.addScaledVector(this.velocity, dt);

    if (this.collision) this.collision.resolveSphere(this.flyPos, 1.6);
    if (this.flyPos.y < 2.2) this.flyPos.y = 2.2;
    if (this.flyPos.y > 400) this.flyPos.y = 400;

    this.camera.position.copy(this.flyPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.flyPos.clone().add(forward));

    this.speedNormalized = THREE.MathUtils.clamp(this.velocity.length() / 95, 0, 1);
    const targetFov = this.baseFov + this.speedNormalized * 17 + (boosting ? 4 : 0);
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-4.5 * dt));
    this.camera.updateProjectionMatrix();
  }
}
