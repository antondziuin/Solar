import * as THREE from 'three';
import { AU, KM } from '../core/constants.js';
import { SphereLOD } from './SphereLOD.js';
import { createSurfaceMaterial, linColor } from './materials.js';
import { AtmosphereShell } from './Atmosphere.js';
import { RingView } from './Rings.js';
import { MAX_OCTAVES, MAX_OCCLUDERS } from './glsl/terrain.js';

export const SUN_COLOR = new THREE.Vector3(1.0, 0.97, 0.94);
const GRID_N = 32;
const SPLIT_K = 1.5;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class BodyView {
  constructor(body, model, textures, scene) {
    this.body = body;
    this.model = model;
    const kind = body.surface.kind;
    this.mode = kind === 'sun' ? 'sun' : kind;
    this.material = createSurfaceMaterial(body, model, this.mode, textures);
    this.lod = new SphereLOD({
      radii: model.radii,
      maxRelief: model.maxRelief,
      material: this.material,
      gridN: GRID_N,
      splitK: SPLIT_K,
      horizonCull: true,
    });
    this.lod.mesh.renderOrder = 1;
    this.lod.mesh.name = body.id;
    scene.add(this.lod.mesh);

    if (body.clouds) {
      const alt = body.clouds.altitude * KM;
      const radii = model.radii.map((r) => r + alt);
      this.cloudMaterial = createSurfaceMaterial({ ...body, surface: { ...body.surface, special: 'clouds' } }, model, 'clouds', textures, { radii });
      this.cloudMaterial.uniforms.uCamOff.value = this.material.uniforms.uCamOff.value;
      this.cloudLod = new SphereLOD({ radii, maxRelief: 0, material: this.cloudMaterial, gridN: 24, splitK: 1.2, horizonCull: true });
      this.cloudLod.mesh.renderOrder = 3;
      scene.add(this.cloudLod.mesh);
    }
    if (body.atmosphere) {
      this.atmo = new AtmosphereShell(body);
      scene.add(this.atmo.mesh);
    }
    if (body.rings) {
      this.rings = new RingView(body);
      scene.add(this.rings.mesh);
      this.material.uniforms.uRingTex.value = this.rings.material.uniforms.uRingTex.value;
      this.material.uniforms.uRingRange.value.set(this.rings.inner / 1000, this.rings.outer / 1000);
    }
    // representative colour for planetshine and point rendering
    const s = body.surface;
    if (s.bands) {
      const mid = s.bands[Math.floor(s.bands.length / 2)][1];
      this.meanColor = linColor(mid);
    } else if (kind === 'sun') {
      this.meanColor = new THREE.Color(1, 0.95, 0.85);
    } else {
      this.meanColor = linColor(s.c0 || '#888').lerp(linColor(s.c1 || '#aaa'), 0.5);
    }
    if (body.id === 'earth') this.meanColor = new THREE.Color(0.25, 0.32, 0.45);

    this.relCam = new THREE.Vector3();
    this.camPF = new THREE.Vector3();
    this.distance = Infinity;
    this.pixelRadius = 0;
    this.groundH = 0;
    this.visible = false;
  }

  setVisible(v) {
    this.lod.mesh.visible = v && this.lod.count > 0;
    if (this.cloudLod) this.cloudLod.mesh.visible = v && this.cloudLod.count > 0;
    if (this.atmo) this.atmo.mesh.visible = v;
    if (this.rings) this.rings.mesh.visible = v;
  }

  /** Occluders that may cast a shadow on this body (moons, parent). */
  _occluders(ctx, sunVec, sunDist) {
    const b = this.body;
    const list = [];
    const cand = [];
    const parent = b.parent ? ctx.byId[b.parent] : null;
    if (parent && parent.type !== 'star') cand.push(parent);
    for (const o of ctx.bodies) {
      if (o === b || o.type === 'star') continue;
      if (o.parent === b.id || (parent && o.parent === parent.id && parent.type !== 'star')) cand.push(o);
    }
    const sunAng = (ctx.sun.radius * KM) / sunDist;
    for (const o of cand) {
      _v.copy(o.state.pos).sub(b.state.pos);
      const d = _v.length();
      const cosA = _v.dot(sunVec) / (d * sunDist);
      if (cosA <= 0 || d > sunDist) continue;
      const ang = Math.acos(Math.min(1, cosA));
      const lim = Math.asin(Math.min(1, (o.radius * KM) / d)) + Math.asin(Math.min(1, (b.radius * KM) / d)) + sunAng;
      if (ang < lim * 1.05) list.push({ o, score: ang / lim });
    }
    list.sort((a, c) => a.score - c.score);
    return list.slice(0, MAX_OCCLUDERS).map((x) => x.o);
  }

  update(ctx) {
    const b = this.body;
    const s = b.state;
    const U = this.material.uniforms;
    this.relCam.copy(s.pos).sub(ctx.camPos);
    this.distance = this.relCam.length();
    this.camPF.copy(this.relCam).negate().applyMatrix3(s.rotInv);
    const R = this.model.R;
    this.pixelRadius = R / Math.max(this.distance, 1) / ctx.pixelAngle;
    this.visible = this.pixelRadius > 0.6 && ctx.cameraFacing(this.relCam, R * 1.5 + (b.rings ? this.rings.outer : 0));
    if (!this.visible) { this.setVisible(false); return; }

    // sun geometry
    const sun = ctx.sun;
    const sunVec = _v2.copy(sun.state.pos).sub(s.pos);
    const sunDist = Math.max(sunVec.length(), 1);
    const irr = this.mode === 'sun' ? 1 : (AU / sunDist) ** 2;
    const sunIrr = U.uSunIrr.value.copy(SUN_COLOR).multiplyScalar(irr * ctx.exposure);
    if (this.mode !== 'sun') {
      U.uSunDir.value.copy(sunVec).divideScalar(sunDist).applyMatrix3(s.rotInv);
      U.uSunPos.value.copy(sunVec).applyMatrix3(s.rotInv).multiplyScalar(0.001);
    }
    U.uSunRadius.value = sun.radius;

    // terrain height below the camera (for LOD split and collision)
    const altApprox = this.distance - R;
    if (this.model.kind === 'rock' && altApprox < 3 * R) {
      const d = _v.copy(this.camPF).normalize();
      this.groundH = this.model.groundHeight(d.x, d.y, d.z, Math.max(altApprox * 0.05, 0.25));
    } else this.groundH = 0;

    this.model.camOffsets(this.camPF, MAX_OCTAVES, U.uCamOff.value);
    this.lod.update(this.camPF, this.relCam, s.rot, ctx.frustum, this.groundH);
    U.uRot.value.copy(s.rot);
    U.uCamPF.value.copy(this.camPF);
    U.uVertexCut.value = 4 / (SPLIT_K * GRID_N);
    U.uPixelCut.value = ctx.pixelAngle * 1.5;
    U.uTime.value = ctx.time;
    U.uAmbient.value = ctx.ambient;
    U.uExposure.value = ctx.exposure;

    if (this.mode === 'sun') {
      // keep the disc detailed when it fills the screen, dazzling when it is small
      const px = this.pixelRadius;
      const t = Math.min(1, Math.max(0, Math.log10(px / 3) / 1.3));
      U.uSunRadiance.value = 60 * (1 - t) + 0.5 * t;
    } else {
      // eclipses
      const occ = this._occluders(ctx, sunVec, sunDist);
      U.uOccCount.value = occ.length;
      occ.forEach((o, i) => {
        _v.copy(o.state.pos).sub(s.pos).applyMatrix3(s.rotInv).multiplyScalar(0.001);
        U.uOcc.value[i].set(_v.x, _v.y, _v.z, o.radius);
        if (o.id === 'earth') U.uOccTint.value[i].set(0.07, 0.022, 0.006);
        else if (o.atmosphere) U.uOccTint.value[i].set(0.01, 0.006, 0.003);
        else U.uOccTint.value[i].set(0, 0, 0);
      });
      // planetshine from the parent planet
      const parent = b.parent ? ctx.byId[b.parent] : null;
      if (parent && parent.type !== 'star') {
        const vp = _v.copy(parent.state.pos).sub(s.pos);
        const dp = vp.length();
        const ps = new THREE.Vector3().copy(sun.state.pos).sub(parent.state.pos);
        const eP = (AU / ps.length()) ** 2;
        const cosPh = ps.normalize().dot(vp.clone().negate().divideScalar(dp));
        const frac = (1 + cosPh) / 2;
        const I = (parent.albedo || 0.3) * eP * ((parent.radius * KM) / dp) ** 2 * frac * 0.66;
        U.uShine.value.copy(vp).divideScalar(dp).applyMatrix3(s.rotInv);
        const pc = ctx.views[parent.id]?.meanColor || new THREE.Color(1, 1, 1);
        const lum = (pc.r + pc.g + pc.b) / 3 || 1;
        U.uShineColor.value.set(pc.r / lum, pc.g / lum, pc.b / lum).multiplyScalar(I * ctx.exposure);
      } else {
        U.uShineColor.value.set(0, 0, 0);
      }
    }

    if (this.cloudLod) {
      const C = this.cloudMaterial.uniforms;
      this.cloudLod.update(this.camPF, this.relCam, s.rot, ctx.frustum, 0);
      for (const k of ['uRot', 'uCamPF', 'uSunDir', 'uSunPos', 'uSunIrr', 'uVertexCut', 'uPixelCut', 'uTime', 'uOccCount', 'uAmbient', 'uExposure']) {
        const src = U[k].value;
        if (src && src.copy) C[k].value.copy(src); else C[k].value = src;
      }
      for (let i = 0; i < MAX_OCCLUDERS; i++) { C.uOcc.value[i].copy(U.uOcc.value[i]); C.uOccTint.value[i].copy(U.uOccTint.value[i]); }
    }
    if (this.atmo) this.atmo.update(this.relCam, s.rot, s.rotInv, this.camPF, U.uSunDir.value, sunIrr);
    if (this.rings) this.rings.update(this.relCam, s.rot, s.rotInv, this.camPF, U.uSunDir.value, sunIrr, ctx.pixelAngle * 1.5);
    this.setVisible(true);
  }
}
