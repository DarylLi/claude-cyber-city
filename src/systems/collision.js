// -----------------------------------------------------------------------------
// AABB collision world — no physics engine, mirroring the baseline's
// buildCityBoxes()/queryNearby() approach: bucket every building's AABB into
// a coarse spatial hash grid, then only test the handful of boxes near the
// query point. Used here for a soft sphere-vs-AABB push-out so the fly camera
// can't clip through towers, and for a ground-height query so it doesn't dip
// below street level.
// -----------------------------------------------------------------------------
const CELL_SIZE = 60;

export class CollisionWorld {
  constructor(aabbs) {
    this.aabbs = aabbs;
    this.grid = new Map();
    for (const box of aabbs) this._insert(box);
  }

  _key(cx, cz) {
    return `${cx},${cz}`;
  }

  _cellsFor(box) {
    const cx0 = Math.floor(box.minX / CELL_SIZE);
    const cx1 = Math.floor(box.maxX / CELL_SIZE);
    const cz0 = Math.floor(box.minZ / CELL_SIZE);
    const cz1 = Math.floor(box.maxZ / CELL_SIZE);
    const cells = [];
    for (let x = cx0; x <= cx1; x++) {
      for (let z = cz0; z <= cz1; z++) cells.push([x, z]);
    }
    return cells;
  }

  _insert(box) {
    for (const [x, z] of this._cellsFor(box)) {
      const key = this._key(x, z);
      let bucket = this.grid.get(key);
      if (!bucket) this.grid.set(key, (bucket = []));
      bucket.push(box);
    }
  }

  queryNearby(x, z, radius) {
    const cx0 = Math.floor((x - radius) / CELL_SIZE);
    const cx1 = Math.floor((x + radius) / CELL_SIZE);
    const cz0 = Math.floor((z - radius) / CELL_SIZE);
    const cz1 = Math.floor((z + radius) / CELL_SIZE);
    const seen = new Set();
    const out = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = this.grid.get(this._key(cx, cz));
        if (!bucket) continue;
        for (const box of bucket) {
          if (seen.has(box)) continue;
          seen.add(box);
          out.push(box);
        }
      }
    }
    return out;
  }

  // Pushes a sphere (center + radius) out of any overlapping building AABBs.
  // Mutates `outPosition` (a THREE.Vector3-like with x/y/z) in place.
  resolveSphere(outPosition, radius) {
    const nearby = this.queryNearby(outPosition.x, outPosition.z, radius + 8);
    for (const box of nearby) {
      if (outPosition.y < box.minY - radius || outPosition.y > box.maxY + radius) continue;

      const cx = Math.max(box.minX, Math.min(outPosition.x, box.maxX));
      const cz = Math.max(box.minZ, Math.min(outPosition.z, box.maxZ));
      const dx = outPosition.x - cx;
      const dz = outPosition.z - cz;
      const distSq = dx * dx + dz * dz;

      if (distSq < radius * radius) {
        const dist = Math.sqrt(distSq) || 0.0001;
        const push = (radius - dist) / dist;
        outPosition.x += dx * push;
        outPosition.z += dz * push;
      }
    }
    return outPosition;
  }
}
