// Quadtree cube-sphere with one instanced draw call per body.
//
// Each chunk is anchored at its centre point, expressed relative to the camera in the body
// frame in double precision on the CPU; the vertex shader only adds small, precise offsets.
import * as THREE from 'three';

const FACES = [
  { N: [1, 0, 0], U: [0, 1, 0], V: [0, 0, 1] },
  { N: [-1, 0, 0], U: [0, -1, 0], V: [0, 0, 1] },
  { N: [0, 1, 0], U: [-1, 0, 0], V: [0, 0, 1] },
  { N: [0, -1, 0], U: [1, 0, 0], V: [0, 0, 1] },
  { N: [0, 0, 1], U: [1, 0, 0], V: [0, 1, 0] },
  { N: [0, 0, -1], U: [-1, 0, 0], V: [0, 1, 0] },
];

export function faceDir(face, u, v, out) {
  const f = FACES[face];
  const a = Math.tan(u * Math.PI / 4), b = Math.tan(v * Math.PI / 4);
  const x = f.N[0] + a * f.U[0] + b * f.V[0];
  const y = f.N[1] + a * f.U[1] + b * f.V[1];
  const z = f.N[2] + a * f.U[2] + b * f.V[2];
  const l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

function buildGrid(N) {
  const pos = [];
  const idx = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) pos.push(i / N, j / N, 0);
  const id = (i, j) => j * (N + 1) + i;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = id(i, j), b = id(i + 1, j), c = id(i, j + 1), d = id(i + 1, j + 1);
      if ((i + j) % 2) idx.push(a, b, d, a, d, c);
      else idx.push(a, b, c, b, d, c);
    }
  }
  // skirts around the border
  const border = [];
  for (let i = 0; i < N; i++) border.push([i, 0]);
  for (let j = 0; j < N; j++) border.push([N, j]);
  for (let i = N; i > 0; i--) border.push([i, N]);
  for (let j = N; j > 0; j--) border.push([0, j]);
  const base = pos.length / 3;
  border.forEach(([i, j]) => pos.push(i / N, j / N, 1));
  for (let k = 0; k < border.length; k++) {
    const k2 = (k + 1) % border.length;
    const a = id(...border[k]), b = id(...border[k2]);
    const as = base + k, bs = base + k2;
    idx.push(a, as, b, b, as, bs);
  }
  return { pos: new Float32Array(pos), idx };
}

export class SphereLOD {
  /**
   * @param {object} opts
   *  radii: [a,b,c] metres; maxRelief: metres; material: ShaderMaterial
   */
  constructor({ radii, maxRelief = 0, material, gridN = 32, maxInstances = 3000, splitK = 1.5, minEdge = 0.15, horizonCull = true, model = null, thinSkirts = false, boundMargin = 0 }) {
    // thinSkirts: smooth shells (clouds) only need to cover the chord/arc sag between LOD levels;
    // long skirts on a translucent layer show up as bright walls along chunk borders
    this.thinSkirts = thinSkirts;
    // extra bounding margin for data that the CPU only approximates (streamed elevation)
    this.boundMargin = boundMargin;
    this._demVersion = -1;
    this.model = model; // optional terrain model: per-node centre heights and relief bounds
    this._hCache = new Map();
    this._reliefL = [];
    this.radii = radii;
    this.R = Math.max(...radii);
    this.Rmin = Math.min(...radii);
    this.maxRelief = maxRelief;
    this.gridN = gridN;
    this.splitK = splitK;
    this.horizonCull = horizonCull;
    this.maxLevel = Math.min(30, Math.ceil(Math.log2((Math.PI / 2) * this.R / minEdge)));
    this.refreshBounds();
    this.maxInstances = maxInstances;

    const g = buildGrid(gridN);
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    geom.setIndex(g.idx);
    this.anchor = new Float32Array(maxInstances * 3);
    this.chunk = new Float32Array(maxInstances * 4);
    this.skirt = new Float32Array(maxInstances);
    this.bound = new Float32Array(maxInstances); // bounding radius of each chunk (m), CPU only
    this.aAnchor = new THREE.InstancedBufferAttribute(this.anchor, 3).setUsage(THREE.DynamicDrawUsage);
    this.aChunk = new THREE.InstancedBufferAttribute(this.chunk, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSkirt = new THREE.InstancedBufferAttribute(this.skirt, 1).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('iAnchor', this.aAnchor);
    geom.setAttribute('iChunk', this.aChunk);
    geom.setAttribute('iSkirt', this.aSkirt);
    geom.instanceCount = 0;
    this.geometry = geom;
    this.mesh = new THREE.Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.count = 0;
    this._d = [0, 0, 0];
    this._v = new THREE.Vector3();
    this._sphere = new THREE.Sphere();
  }

  /** Recompute radii-dependent limits (after the body switched to a real DEM). */
  refreshBounds(radii = this.radii, maxRelief = this.maxRelief) {
    this.radii = radii;
    this.R = Math.max(...radii);
    this.Rmin = Math.min(...radii);
    this.maxRelief = maxRelief;
    this._reliefL = [];
    const model = this.model;
    for (let l = 0; l <= this.maxLevel; l++) {
      const edge = 2 * (Math.PI / 4) * this.R / 2 ** l;
      this._reliefL.push(model && model.reliefBelow ? Math.min(maxRelief, model.reliefBelow(edge)) : maxRelief);
    }
    this._hCache.clear();
  }

  /** Terrain height at a node centre (cached; the terrain is static apart from streamed DEM). */
  _centreHeight(face, u, v, level, d, edge) {
    if (!this.model || this.model.kind !== 'rock') return 0;
    const key = face * 1e12 + level * 1e10 + Math.round((u + 1) * 32768) * 65537 + Math.round((v + 1) * 32768);
    let h = this._hCache.get(key);
    if (h === undefined) {
      h = this.model.groundHeight(d[0], d[1], d[2], Math.max(edge / 4, 0.25));
      if (this._hCache.size > 30000) this._hCache.clear();
      this._hCache.set(key, h);
    }
    return h;
  }

  /**
   * @param camPF   camera position in the body frame (m, double)
   * @param bodyRelCam  body centre relative to camera, world frame (m)
   * @param rot     Matrix3 body -> world
   * @param frustum THREE.Frustum in camera-relative world coordinates
   * @param groundH terrain height under the camera (m), improves split decisions near the ground
   * @param extra   optional THREE.Sphere (camera-relative world): chunks inside it are kept even
   *                outside the view frustum (terrain that casts shadows into the view)
   */
  update(camPF, bodyRelCam, rot, frustum, groundH = 0, extra = null) {
    this.count = 0;
    // streamed elevation changed: cached centre heights are stale
    const dem = this.model && this.model.dem;
    if (dem && dem.version !== this._demVersion) { this._demVersion = dem.version; this._hCache.clear(); }
    const camDist = camPF.length();
    const R = this.R;
    const Rh = this.Rmin * 0.998 - this.maxRelief;
    const cull = this.horizonCull && Rh > 0 && camDist > Rh;
    const alphaC = cull ? Math.acos(Math.min(1, Rh / camDist)) : Math.PI;
    const alphaN = cull ? Math.acos(Math.min(1, Rh / (R + this.maxRelief))) : 0;
    const cx = camPF.x / camDist, cy = camPF.y / camDist, cz = camPF.z / camDist;
    const e = rot.elements;
    const [ra, rb, rc] = this.radii;

    const visit = (face, u, v, half, level) => {
      if (this.count >= this.maxInstances) return;
      const d = faceDir(face, u, v, this._d);
      const beta = half * 1.12;
      // horizon culling
      if (cull) {
        const cosG = d[0] * cx + d[1] * cy + d[2] * cz;
        const gamma = Math.acos(Math.max(-1, Math.min(1, cosG)));
        if (gamma - beta > alphaC + alphaN) return;
      }
      const edge = 2 * half * (Math.PI / 4) * R;
      const hc = this._centreHeight(face, u, v, level, d, edge);
      const px = ra * d[0] + d[0] * hc, py = rb * d[1] + d[1] * hc, pz = rc * d[2] + d[2] * hc;
      // node bound: horizontal extent, relief of the detail inside the node, slopes across it,
      // and a margin for heights the CPU only approximates
      const nodeR = R * beta * 1.05 + this._reliefL[level] + 0.35 * edge + this.boundMargin;
      // frustum culling (world, camera relative)
      if (level > 0) {
        const wx = e[0] * px + e[3] * py + e[6] * pz + bodyRelCam.x;
        const wy = e[1] * px + e[4] * py + e[7] * pz + bodyRelCam.y;
        const wz = e[2] * px + e[5] * py + e[8] * pz + bodyRelCam.z;
        this._sphere.center.set(wx, wy, wz);
        this._sphere.radius = nodeR;
        if (!frustum.intersectsSphere(this._sphere) && !(extra && extra.intersectsSphere(this._sphere))) return;
      }
      const gh = this.model ? 0 : groundH;
      const gx = px + d[0] * gh - camPF.x, gy = py + d[1] * gh - camPF.y, gz = pz + d[2] * gh - camPF.z;
      const dist = Math.max(Math.hypot(gx, gy, gz) - R * beta, 0);
      if (level < this.maxLevel && dist < this.splitK * edge) {
        const h2 = half / 2;
        visit(face, u - h2, v - h2, h2, level + 1);
        visit(face, u + h2, v - h2, h2, level + 1);
        visit(face, u - h2, v + h2, h2, level + 1);
        visit(face, u + h2, v + h2, h2, level + 1);
        return;
      }
      const i = this.count++;
      // re-evaluate (the recursion above reuses the scratch vector)
      const dd = faceDir(face, u, v, this._d);
      this.anchor[i * 3] = ra * dd[0] - camPF.x;
      this.anchor[i * 3 + 1] = rb * dd[1] - camPF.y;
      this.anchor[i * 3 + 2] = rc * dd[2] - camPF.z;
      this.chunk[i * 4] = face;
      // tangents of the centre's face angles, in double precision: the GPU's trig functions are
      // not accurate enough at this scale (see cubeSphere in terrain.js)
      this.chunk[i * 4 + 1] = Math.tan(u * Math.PI / 4);
      this.chunk[i * 4 + 2] = Math.tan(v * Math.PI / 4);
      this.chunk[i * 4 + 3] = half;
      this.bound[i] = nodeR;
      if (this.thinSkirts) {
        const s = edge / this.gridN;
        this.skirt[i] = (s * s) / (2 * R) + 0.5;
      } else this.skirt[i] = edge * 0.04 + 1.0;
    };
    for (let f = 0; f < 6; f++) visit(f, 0, 0, 1, 0);
    this.geometry.instanceCount = this.count;
    this.aAnchor.needsUpdate = true;
    this.aChunk.needsUpdate = true;
    this.aSkirt.needsUpdate = true;
    this.aAnchor.clearUpdateRanges(); this.aAnchor.addUpdateRange(0, this.count * 3);
    this.aChunk.clearUpdateRanges(); this.aChunk.addUpdateRange(0, this.count * 4);
    this.aSkirt.clearUpdateRanges(); this.aSkirt.addUpdateRange(0, this.count);
    this.mesh.visible = this.count > 0;
  }
}
