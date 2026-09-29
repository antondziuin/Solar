// Cast shadows of the relief (mountains, crater rims, boulders) on the body the camera is near.
//
// Three cascaded orthographic depth maps are rendered from the Sun into one atlas, around the
// point below the camera: each cascade is 5x wider than the previous one. The terrain chunks are
// the ones the view already uses (plus those near the camera that are off screen, since they may
// cast shadows into the view), filtered per cascade and drawn with the terrain vertex shader, so
// the shadow casters have exactly the same geometry as the visible surface. The terrain fragment
// shader then looks the maps up with a penumbra set by the Sun's angular size (terrain.js).
import * as THREE from 'three';
import { TERRAIN_VERT, SHADOW_FRAG } from './glsl/terrain.js';
import { KM } from '../core/constants.js';

const CASCADES = 3;
const SPREAD = 5;

export class TerrainShadows {
  constructor(size = 1536) {
    this.size = size;
    this.enabled = true;
    this.mode = 1; // 1: shadow maps + small-scale ray march; 2 / 3: only one of them (debugging)
    const depth = new THREE.DepthTexture(size * CASCADES, size, THREE.FloatType);
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.target = new THREE.WebGLRenderTarget(size * CASCADES, size, { depthTexture: depth, depthBuffer: true, type: THREE.UnsignedByteType });
    this.target.texture.generateMipmaps = false;
    this.cams = Array.from({ length: CASCADES }, () => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    this.scenes = Array.from({ length: CASCADES }, () => new THREE.Scene());
    this.meshes = [];
    this.view = null;       // BodyView currently casting shadows
    this.extra = new THREE.Sphere(); // region whose chunks are kept for the shadow pass
    this.active = false;
    this._vp = new THREE.Matrix4();
    this._p = new THREE.Vector3();
  }

  /** Per-cascade instanced geometries sharing the body's grid, and a depth material sharing its uniforms. */
  _bind(view) {
    if (this.view === view) return;
    for (const m of this.meshes) { m.parent?.remove(m); m.geometry.dispose(); }
    this.meshes = [];
    this.view = view;
    const lod = view.lod;
    const U = view.material.uniforms;
    this.material = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERT,
      fragmentShader: SHADOW_FRAG,
      uniforms: U,
      defines: { ...view.material.defines, SHADOW_DEPTH: '' },
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < CASCADES; i++) {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', lod.geometry.attributes.position);
      g.setIndex(lod.geometry.index);
      const n = lod.maxInstances;
      g.setAttribute('iAnchor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iChunk', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iSkirt', new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
      g.instanceCount = 0;
      const mesh = new THREE.Mesh(g, this.material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.scenes[i].add(mesh);
      this.meshes.push(mesh);
    }
  }

  /**
   * Choose the body and the cascade frames before the LOD update (so off-screen casters are kept).
   * @returns the sphere to pass to SphereLOD.update, or null
   */
  prepare(view, ctx, alt, camForward) {
    this.active = false;
    if (!this.enabled || !view || view.model.kind !== 'rock' || !view.visible) {
      if (this.view) this.view.material.uniforms.uShadowOn.value = 0;
      return null;
    }
    if (this.view && this.view !== view) this.view.material.uniforms.uShadowOn.value = 0;
    const R = view.model.R;
    if (alt > 4 * R) { view.material.uniforms.uShadowOn.value = 0; return null; }
    this._bind(view);
    const b = view.body;
    // frames: up at the camera, the point below it, the Sun, the horizontal view direction
    const up = view.relCam.clone().negate().normalize();
    const ground = up.clone().multiplyScalar(-alt);
    const sunW = ctx.sun.state.pos.clone().sub(b.state.pos).normalize();
    const fh = camForward.clone().addScaledVector(up, -camForward.dot(up));
    if (fh.lengthSq() > 1e-6) fh.normalize(); else fh.set(0, 0, 0);
    const W0 = Math.min(Math.max(alt * 3, 12), R * 0.6);
    const relief = view.model.maxRelief;
    let outer = 0;
    this.frames = [];
    for (let i = 0; i < CASCADES; i++) {
      const W = W0 * SPREAD ** i;
      const centre = ground.clone().addScaledVector(fh, W * 0.55);
      // depth span: the cascade itself plus casters up to the relief height towards the Sun
      const depthHalf = W * 1.5 + Math.min(relief * 4, W * 4) + 10;
      const cam = this.cams[i];
      cam.left = -W; cam.right = W; cam.top = W; cam.bottom = -W;
      cam.near = 0; cam.far = 2 * depthHalf;
      cam.position.copy(centre).addScaledVector(sunW, depthHalf);
      cam.up.copy(Math.abs(sunW.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
      cam.lookAt(centre);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.frames.push({ W, vp, depth: 2 * depthHalf, texel: (2 * W) / this.size });
      outer = Math.max(outer, centre.length() + W * 1.5);
    }
    // keep chunks near the camera, including those towards the Sun that are off screen
    this.extra.center.copy(ground).addScaledVector(sunW, Math.min(relief * 3, outer));
    this.extra.radius = outer + Math.min(relief * 3, outer);
    this.active = true;
    return this.extra;
  }

  /** Filter the chunks into each cascade and render the depth atlas; set the terrain uniforms. */
  render(renderer, ctx) {
    if (!this.active) return;
    const view = this.view;
    const lod = view.lod;
    const U = view.material.uniforms;
    const rot = view.body.state.rot;
    const S = this.size;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    this.target.scissorTest = false;
    this.target.viewport.set(0, 0, S * CASCADES, S);
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    const e = rot.elements;
    for (let i = 0; i < CASCADES; i++) {
      const f = this.frames[i];
      const g = this.meshes[i].geometry;
      const A = g.attributes.iAnchor.array, C = g.attributes.iChunk.array, K = g.attributes.iSkirt.array;
      const vp = f.vp.elements;
      let n = 0;
      for (let k = 0; k < lod.count; k++) {
        const ax = lod.anchor[k * 3], ay = lod.anchor[k * 3 + 1], az = lod.anchor[k * 3 + 2];
        // chunk centre (camera-relative world) in the cascade's orthographic clip space
        const wx = e[0] * ax + e[3] * ay + e[6] * az, wy = e[1] * ax + e[4] * ay + e[7] * az, wz = e[2] * ax + e[5] * ay + e[8] * az;
        const x = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
        const y = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
        const r = lod.bound[k] / f.W;
        if (Math.abs(x) > 1 + r || Math.abs(y) > 1 + r) continue;
        A[n * 3] = ax; A[n * 3 + 1] = ay; A[n * 3 + 2] = az;
        C[n * 4] = lod.chunk[k * 4]; C[n * 4 + 1] = lod.chunk[k * 4 + 1]; C[n * 4 + 2] = lod.chunk[k * 4 + 2]; C[n * 4 + 3] = lod.chunk[k * 4 + 3];
        K[n] = lod.skirt[k];
        n++;
      }
      g.instanceCount = n;
      for (const key of ['iAnchor', 'iChunk', 'iSkirt']) {
        const at = g.attributes[key];
        at.needsUpdate = true;
        at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize);
      }
      this.meshes[i].visible = n > 0;
      U.uLightVP.value.copy(f.vp);
      this.target.viewport.set(i * S, 0, S, S);
      renderer.setRenderTarget(this.target);
      renderer.render(this.scenes[i], this.cams[i]);
      U.uShadowVP.value[i].copy(f.vp);
      U.uShadowInfo.value[i].set(f.texel, f.depth, 0, n > 0 ? 1 : 0);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    U.uShadowTex.value = this.target.depthTexture;
    U.uShadowSize.value = S;
    U.uShadowOn.value = this.mode;
    const sunDist = ctx.sun.state.pos.distanceTo(view.body.state.pos);
    U.uSunAngR.value = (ctx.sun.radius * KM) / sunDist;
  }
}
