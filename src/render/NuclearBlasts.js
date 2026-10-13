// Nuclear explosions on the surfaces: picking ground zero under the cursor, the evolving state
// of every explosion (src/core/nuclear.js), the volumetric render pass (glsl/blast.js), the
// flash lighting and scars on the terrain (terrain.js), eye adaptation to the flash, the shake
// and the sound when the blast wave reaches the camera.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { AU, KM } from '../core/constants.js';
import { Detonation, blastEnvironment, optimumHOB, blackbody, SUN_DISC_RADIANCE } from '../core/nuclear.js';
import { BLAST_VERT, BLAST_FRAG, DEPTH_COPY_FRAG, MAX_BLASTS } from './glsl/blast.js';
import { atmosphereUniforms } from './materials.js';
import { SUN_COLOR } from './BodyView.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _t = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Optical depth of the air towards the sun -> transmittance (mirror of atmoOpticalDepthToSun). */
function sunTransmittance(a, groundKm, p, L, out) {
  const top = groundKm + a.height;
  const r = p.length();
  const mu = p.dot(L) / r;
  const horizon = -Math.sqrt(Math.max(0, 1 - (groundKm * groundKm) / (r * r)));
  const b = p.dot(L);
  const h = b * b - (r * r - top * top);
  const len = h < 0 ? 0 : Math.max(-b + Math.sqrt(h), 0);
  const ds = len / 6;
  let odR = 0, odM = 0, odA = 0;
  for (let i = 0; i < 6; i++) {
    _t.copy(p).addScaledVector(L, ds * (i + 0.5));
    const hh = Math.max(_t.length() - groundKm, 0);
    odR += Math.exp(-hh / a.rayleighH) * ds;
    odM += Math.exp(-hh / a.mieH) * ds;
    odA += ((a.absorbCenter ?? -1) >= 0 ? Math.max(0, 1 - Math.abs(hh - a.absorbCenter) / a.absorbWidth) : Math.exp(-hh / (a.absorbH ?? 10))) * ds;
  }
  const shadow = smooth(horizon - 0.01, horizon + 0.01, mu);
  const R = a.rayleigh || [0, 0, 0], A = a.absorb || [0, 0, 0];
  for (let c = 0; c < 3; c++) out[c] = shadow * Math.exp(-(R[c] * odR + a.mieExt * odM + A[c] * odA));
  return out;
}

/** Synthesised sound of the blast wave: a crack and a long, low rumble. */
class BlastAudio {
  constructor() { this.ctx = null; this.buffer = null; }
  _init() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    const n = this.ctx.sampleRate * 12;
    this.buffer = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = this.buffer.getChannelData(ch);
      let b = 0;
      for (let i = 0; i < n; i++) { b = (b + 0.04 * (Math.random() * 2 - 1)) / 1.04; d[i] = b * 6; }
    }
    return true;
  }
  /** Must be called from a user gesture once, so the browser lets the page play sound later. */
  unlock() { if (this._init() && this.ctx.state === 'suspended') this.ctx.resume(); }
  boom(gain, cutoff, dur) {
    if (!this._init()) return;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff, t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(40, cutoff * 0.15), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(gain * 0.35, t0 + 0.35);
    g.gain.exponentialRampToValueAtTime(gain * 0.12, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp).connect(g).connect(ctx.destination);
    src.start(t0, Math.random() * 2);
    src.stop(t0 + dur + 0.1);
  }
}

class BlastPass extends Pass {
  constructor(owner) { super(); this.owner = owner; this.needsSwap = false; }
  render(renderer, writeBuffer, readBuffer) {
    // a click to detonate is resolved here, where the scene's depth of this frame is in place
    if (this.owner._pending) this.owner._resolvePending(renderer, readBuffer);
    if (this.owner.blasts.length) this.owner.renderVolumes(renderer, readBuffer);
  }
}

export class NuclearBlasts {
  constructor(app) {
    this.app = app;
    this.blasts = [];
    this.settings = { yieldKt: 1000, mode: 'air', sound: true };
    this.armed = false;
    this.adapt = 1;         // eye / camera adaptation to the flash (multiplies the exposure)
    this.onDetonate = null; // UI callback
    this.audio = new BlastAudio();
    this._frame = 0;
    this.pass = new BlastPass(this);

    const dummy3 = new THREE.Data3DTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, 1);
    dummy3.needsUpdate = true;
    const arr = (n, f) => Array.from({ length: n }, f);
    const V3 = () => new THREE.Vector3(), V4 = () => new THREE.Vector4();
    const U = {
      uDepth: { value: null },
      uNoise: { value: dummy3 },
      uRayBasis: { value: new THREE.Matrix3() },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFrame: { value: 0 },
      uRadScale: { value: 1 },
      uCount: { value: 0 },
      uRo: { value: arr(MAX_BLASTS, V3) },
      uM: { value: arr(MAX_BLASTS, () => new THREE.Matrix3()) },
      uH: { value: arr(MAX_BLASTS, V4) },
      uS: { value: arr(MAX_BLASTS, V4) },
      uR: { value: arr(MAX_BLASTS, V4) },
      uW: { value: arr(MAX_BLASTS, V4) },
      uE: { value: arr(MAX_BLASTS, V4) },
      uE2: { value: arr(MAX_BLASTS, V4) },
      uWind: { value: arr(MAX_BLASTS, V4) },
      uMisc: { value: arr(MAX_BLASTS, V4) },
      uSunL: { value: arr(MAX_BLASTS, V3) },
      uSunT: { value: arr(MAX_BLASTS * 4, V3) },
      uSky: { value: arr(MAX_BLASTS, V3) },
      uDust: { value: arr(MAX_BLASTS, V3) },
      uGlowI: { value: arr(MAX_BLASTS, V3) },
      uBeta: { value: arr(MAX_BLASTS, V4) },
      uAtmo: { value: arr(MAX_BLASTS, () => 0) },
      uHumid: { value: arr(MAX_BLASTS, () => 0) },
      uRotInvA: { value: new THREE.Matrix3() },
      uCamA: { value: new THREE.Vector3() },
      uSunDirA: { value: new THREE.Vector3() },
      uSunIrrA: { value: new THREE.Vector3() },
    };
    atmosphereUniforms({ atmosphere: { height: 1, rayleighH: 1, mieH: 1, mie: 0, mieExt: 0 } }, 1, U);
    this.uniforms = U;
    this.material = new THREE.ShaderMaterial({
      vertexShader: BLAST_VERT, fragmentShader: BLAST_FRAG, uniforms: U,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.quad = new FullScreenQuad(this.material);
    this.copyMaterial = new THREE.ShaderMaterial({
      vertexShader: BLAST_VERT, fragmentShader: DEPTH_COPY_FRAG,
      uniforms: { uDepthTex: { value: null }, uLogFar: { value: 1 }, uResolution: { value: new THREE.Vector2(1, 1) }, uPick: { value: new THREE.Vector2(-1, -1) } },
      depthTest: false, depthWrite: false,
    });
    this.copyQuad = new FullScreenQuad(this.copyMaterial);
    this.depthRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.depthRT.texture.generateMipmaps = false;
    this.pickRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    U.uDepth.value = this.depthRT.texture;
    this._pickBuf = new Float32Array(4);
    this._atmoBody = null;
  }

  /** Start computing the cloud noise in a worker (a fraction of a second, off the main thread). */
  loadNoise() {
    if (this._noiseReq) return;
    this._noiseReq = true;
    const done = (data, size) => {
      const tex = new THREE.Data3DTexture(data, size, size, size);
      tex.format = THREE.RGBAFormat;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.uniforms.uNoise.value = tex;
    };
    try {
      const w = new Worker(new URL('./blastNoise.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => { done(e.data.data, e.data.size); w.terminate(); };
      w.onerror = () => { w.terminate(); import('./blastNoise.js').then((m) => done(m.computeBlastNoise(64), 64)); };
      w.postMessage({ size: 64 });
    } catch {
      import('./blastNoise.js').then((m) => done(m.computeBlastNoise(64), 64));
    }
  }

  // ------------------------------------------------------------------ picking / detonation
  /**
   * The surface point under a screen position: the scene's depth at that pixel (so exactly what
   * is drawn, real elevation and fractal detail included), turned into a point on a body.
   */
  pick(clientX, clientY, rb = this.app.composer.readBuffer) {
    const app = this.app;
    if (!rb.depthTexture || !app._invViewProj) return null;
    const r = app.renderer;
    const U = this.copyMaterial.uniforms;
    U.uDepthTex.value = rb.depthTexture;
    U.uLogFar.value = Math.log2(app.camera.far + 1);
    const u = clientX / window.innerWidth, v = 1 - clientY / window.innerHeight;
    U.uPick.value.set(u, v);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.pickRT);
    this.copyQuad.render(r);
    r.readRenderTargetPixels(this.pickRT, 0, 0, 1, 1, this._pickBuf);
    r.setRenderTarget(prev);
    U.uPick.value.set(-1, -1);
    const w = this._pickBuf[0];
    if (!(w > 0) || w > 1e20) return null;
    // view ray with unit forward component: the point is camera + ray * depth
    const ray = new THREE.Vector3(u * 2 - 1, v * 2 - 1, 1).applyMatrix3(app._invViewProj);
    const p = app.controller.position.clone().addScaledVector(ray, w);
    let best = null, bestD = Infinity;
    for (const view of app.viewList) {
      if (view.model.kind !== 'rock' || !view.visible) continue;
      const rel = _v.copy(p).sub(view.body.state.pos);
      const d = Math.abs(rel.length() - view.model.R);
      if (d < view.model.maxRelief + 0.02 * view.model.R + 2000 && d < bestD) { bestD = d; best = view; }
    }
    if (!best) return null;
    const pBody = p.clone().sub(best.body.state.pos).applyMatrix3(best.body.state.rotInv);
    return { view: best, pBody };
  }

  /** Detonate at the surface under a screen position (resolved during the next frame's render). */
  detonateAt(clientX, clientY) {
    this._pending = { x: clientX, y: clientY };
    if (this.settings.sound) this.audio.unlock(); // still inside the user's gesture
  }

  _resolvePending(renderer, readBuffer) {
    const { x, y } = this._pending;
    this._pending = null;
    const hit = this.pick(x, y, readBuffer);
    if (hit) this.detonate(hit.view, hit.pBody);
  }

  /** Detonate at latitude / longitude (deg) of a body (for scripted views). */
  detonateLatLon(id, lat, lon, opts = {}) {
    const view = this.app.views[id];
    const D = Math.PI / 180;
    const dir = new THREE.Vector3(Math.cos(lat * D) * Math.cos(lon * D), Math.cos(lat * D) * Math.sin(lon * D), Math.sin(lat * D));
    const r = this.app.controller.surfaceRadius(view.body, dir) + view.model.groundHeight(dir.x, dir.y, dir.z, 5);
    return this.detonate(view, dir.multiplyScalar(r), opts);
  }

  detonate(view, pBody, { yieldKt = this.settings.yieldKt, mode = this.settings.mode, age = 0 } = {}) {
    const body = view.body;
    const U0 = view.material.uniforms;
    const c = U0.uColor0.value.clone().lerp(U0.uColor1.value, 0.6);
    const m = Math.max(c.r, c.g, c.b, 1e-3);
    const dustK = Math.min(0.55, Math.max(0.25, m)) / m;
    const env = blastEnvironment(body, [c.r * dustK, c.g * dustK, c.b * dustK]);
    const dir = pBody.clone().normalize();
    let water = false;
    if (view.model.coast) {
      const [sea, lake] = view.model.coast.sample(dir.x, dir.y, dir.z);
      water = sea < -150 || lake < -150;
    }
    const hob = mode === 'surface' ? 0 : optimumHOB(yieldKt);
    const det = new Detonation(yieldKt, hob, env, { water });
    const [a, b, cc] = view.model.radii;
    const up = new THREE.Vector3(pBody.x / (a * a), pBody.y / (b * b), pBody.z / (cc * cc)).normalize();
    const east = new THREE.Vector3(0, 0, 1).cross(up);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(up, east);
    const B = new THREE.Matrix3().set(east.x, east.y, east.z, north.x, north.y, north.z, up.x, up.y, up.z);
    const blast = {
      view, body, det, gz: pBody.clone(), up, B,
      ut0: this.app.clock.ut - age / 86400,
      seed: Math.random() * 10,
      fire: env.air && !water ? 1 : 0,
      st: {}, age: 0, prevAge: age, boomDone: age > 0,
    };
    this.blasts.push(blast);
    if (this.blasts.length > MAX_BLASTS) this.blasts.shift();
    this.loadNoise();
    if (this.settings.sound) this.audio.unlock();
    // make sure it can be seen: run the clock at (near) real time
    const clock = this.app.clock;
    if (clock.paused || clock.rate < 0 || clock.rate > 60) this.app.ui?.setRate(1);
    this.onDetonate?.(det, body);
    return det;
  }

  clear() { this.blasts = []; this._resetTerrain(); }

  _resetTerrain() {
    for (const v of this.app.viewList) {
      if (v.material.uniforms.uBlastCount) v.material.uniforms.uBlastCount.value = 0;
      if (v.cloudMaterial?.uniforms.uBlastCount) v.cloudMaterial.uniforms.uBlastCount.value = 0;
    }
  }

  // ------------------------------------------------------------------ per frame
  /** Evolve the explosions; adapt the eyes to the flash; shake and sound. Before the exposure. */
  prepare(rawDt) {
    if (!this.blasts.length) { this.adapt += (1 - this.adapt) * (1 - Math.exp(-rawDt * 1.5)); return; }
    const app = this.app;
    const ut = app.clock.ut;
    const cam = app.controller.position;
    this.blasts = this.blasts.filter((b) => {
      const age = (ut - b.ut0) * 86400;
      return age < b.det.lifetime && age > -86400;
    });
    if (!this.blasts.length) this._resetTerrain();
    let flash = 0, shake = 0, fireLum = 0;
    const focus = app.controller.focus;
    const sunE = focus ? (AU / Math.max(focus.state.pos.distanceTo(app.ephem.byId.sun.state.pos), 1)) ** 2 : 1;
    const bb = [0, 0, 0];
    for (const b of this.blasts) {
      b.age = (ut - b.ut0) * 86400;
      const st = b.det.state(Math.max(b.age, 0), b.st);
      const s = b.body.state;
      // burst point and camera in the body frame
      const burst = _v.copy(b.up).multiplyScalar(b.age > 0 ? st.headZ : 0).add(b.gz);
      const camPF = _w.copy(cam).sub(s.pos).applyMatrix3(s.rotInv);
      b.camPF = (b.camPF || new THREE.Vector3()).copy(camPF);
      const dist = Math.max(camPF.distanceTo(burst), 1);
      b.dist = dist;
      if (b.age <= 0) continue;
      // fireball brightness at the camera (unless the body is in the way)
      blackbody(st.T, bb);
      const R = st.fireR;
      const I = lum(bb) * SUN_DISC_RADIANCE * Math.PI * R * R * st.fireDens;
      if (I > 0 && !this._occluded(camPF, burst, b.view.model.R * 0.998)) {
        flash += I / Math.max(dist * dist, R * R);
        // looking at the fireball: adapt to its own brightness (as a camera filming it would)
        const toB = _t.copy(burst).sub(camPF).normalize().applyMatrix3(s.rot);
        const fwd = _t2.set(0, 0, -1).applyQuaternion(app.camera.quaternion);
        if (toB.dot(fwd) > 0.75 && R / dist > 0.002) fireLum = Math.max(fireLum, lum(blackbody(Math.max(st.T, st.coreT * 0.9), bb)) * SUN_DISC_RADIANCE * st.fireDens * app.exposure);
      }
      // blast wave at the camera: shake and sound
      if (b.det.env.air) {
        const alt = camPF.length() - b.view.model.R;
        const inAir = alt < (b.body.atmosphere?.height || 50) * KM * 0.5;
        const tA = inAir ? b.det.shockArrival(dist) : Infinity;
        const psi = b.det.overpressure(dist);
        if (b.age >= tA && b.age < tA + 6) shake = Math.max(shake, Math.min(1, Math.log10(1 + psi * 4) * 0.6) * Math.exp(-(b.age - tA) / 1.2));
        if (!b.boomDone && b.prevAge < tA && b.age >= tA) {
          b.boomDone = true;
          const rate = app.clock.rate;
          if (this.settings.sound && !app.clock.paused && Math.abs(rate) <= 4) {
            const gain = Math.min(0.9, Math.max(0.04, Math.log10(1 + psi * 10) / 2.2));
            const cutoff = 120 + 3500 * Math.exp(-dist / 12000);
            this.audio.boom(gain, cutoff, 4 + 3 * Math.log10(1 + b.det.W));
          }
        }
      }
      b.prevAge = b.age;
    }
    // adapt quickly to the flash, recover more slowly
    const target = Math.min(1 / (1 + (1.5 * flash) / sunE), 1 / (1 + fireLum / 6));
    const k = 1 - Math.exp(-rawDt * (target < this.adapt ? 14 : 1.2));
    this.adapt = Math.exp(Math.log(this.adapt) + (Math.log(target) - Math.log(this.adapt)) * k);
    // shake the camera while the blast wave passes
    if (shake > 0.002 && !app.controller.fly) {
      const t = performance.now() / 1000;
      const a = shake * 0.02;
      _e.set(a * Math.sin(t * 37.1) * Math.sin(t * 5.3), a * Math.sin(t * 29.7 + 1.3), a * 0.5 * Math.sin(t * 23.3 + 2.1));
      app.camera.quaternion.multiply(_q.setFromEuler(_e));
    }
  }

  _occluded(from, to, R) {
    const dir = to.clone().sub(from);
    const L = dir.length();
    dir.divideScalar(L);
    const b = from.dot(dir);
    const c = from.lengthSq() - R * R;
    const h = b * b - c;
    if (h < 0) return false;
    const t = -b - Math.sqrt(h);
    return t > 0 && t < L;
  }

  /** Uniforms of the volumetric pass and of the terrain, after the bodies were updated. */
  apply(ctx) {
    const U = this.uniforms;
    const app = this.app;
    const list = this.blasts.filter((b) => b.age > 0).sort((a, b) => b.dist - a.dist);
    U.uCount.value = list.length;
    if (!list.length) return;
    U.uRayBasis.value.copy(ctx.invViewProj);
    U.uFrame.value = (this._frame = (this._frame + 1) % 1024);
    U.uRadScale.value = SUN_DISC_RADIANCE * ctx.exposure;
    // atmosphere for the aerial perspective: the body of the nearest explosion with air
    const atmoBlast = [...list].reverse().find((b) => b.body.atmosphere && b.det.env.air);
    const sun = ctx.sun;
    if (atmoBlast) {
      const body = atmoBlast.body;
      if (this._atmoBody !== body) {
        const tmp = atmosphereUniforms(body, body.radius + (body.renderRadiusOffset || 0), {});
        for (const k of Object.keys(tmp)) U[k].value = tmp[k].value;
        this._atmoBody = body;
      }
      const s = body.state;
      U.uRotInvA.value.copy(s.rotInv);
      U.uCamA.value.copy(atmoBlast.camPF).multiplyScalar(0.001);
      const sv = _v.copy(sun.state.pos).sub(s.pos);
      const sd = sv.length();
      U.uSunDirA.value.copy(sv).divideScalar(sd).applyMatrix3(s.rotInv);
      U.uSunIrrA.value.copy(SUN_COLOR).multiplyScalar((AU / sd) ** 2 * ctx.exposure);
    }
    const bb = [0, 0, 0], cb = [0, 0, 0], tr = [0, 0, 0];
    const perBody = new Map();
    list.forEach((b, i) => {
      const st = b.st, det = b.det, s = b.body.state;
      // world -> local, camera in local
      U.uM.value[i].multiplyMatrices(b.B, s.rotInv);
      U.uRo.value[i].copy(b.camPF).sub(b.gz).applyMatrix3(b.B);
      U.uH.value[i].set(st.headZ, st.a, st.b, st.k);
      U.uS.value[i].set(st.stemR, st.stemTop, st.stemDens, st.capDens);
      U.uR.value[i].set(st.ringR, st.ringH, st.ringDens, st.shockR);
      U.uW.value[i].set(st.wilson, st.burstZ ?? 0, st.coreT, st.fireDens);
      U.uE.value[i].set(st.ejR0 ?? 0, st.ejDrop ?? 0, st.ejLo ?? 0, st.ejHi ?? 0);
      U.uE2.value[i].set(st.ejNorm ?? 1, st.ejDens, b.age, st.condense);
      U.uWind.value[i].set(st.windX * b.age, st.windY * b.age, st.top, st.extent);
      const roll = Math.min(1.4, 0.8 * Math.log1p(b.age / (0.3 * det.tauR || 1)));
      U.uMisc.value[i].set(roll, (25 + 0.9 * st.headZ / Math.max(det.tauR, 1)) * b.age * 0.35, b.seed, det.water ? 1 : 0);
      U.uHumid.value[i] = det.env.water ? 1 : 0;
      U.uAtmo.value[i] = atmoBlast && b.body === atmoBlast.body ? 1 : 0;
      U.uDust.value[i].set(...det.env.dust);
      // sunlight on the cloud at four heights (through the air above, night side dark)
      const sv = _v.copy(sun.state.pos).sub(s.pos);
      const sd = sv.length();
      const L = sv.divideScalar(sd).applyMatrix3(s.rotInv).clone();
      U.uSunL.value[i].copy(L).applyMatrix3(b.B);
      const irr = (AU / sd) ** 2 * ctx.exposure;
      const a = b.body.atmosphere;
      const groundKm = b.body.radius + (b.body.renderRadiusOffset || 0);
      const muS = L.dot(b.up);
      for (let j = 0; j < 4; j++) {
        const p = _w.copy(b.up).multiplyScalar((st.top * j) / 3).add(b.gz).multiplyScalar(0.001);
        if (a && det.env.air) sunTransmittance(a, groundKm, p, L, tr);
        else { const lit = smooth(-0.02, 0.02, L.dot(p.normalize())); tr[0] = tr[1] = tr[2] = lit; }
        U.uSunT.value[i * 4 + j].set(SUN_COLOR.x * irr * tr[0], SUN_COLOR.y * irr * tr[1], SUN_COLOR.z * irr * tr[2]);
      }
      if (a && det.env.air) {
        const R = a.rayleigh, mx = Math.max(...R);
        const k = irr * 0.06 * smooth(-0.25, 0.3, muS);
        U.uSky.value[i].set(R[0] / mx * k, R[1] / mx * k, R[2] / mx * k);
        const hKm = st.headZ * 0.001;
        const er = Math.exp(-hKm / a.rayleighH) * 1e-3, em = Math.exp(-hKm / a.mieH) * 1e-3;
        U.uBeta.value[i].set(R[0] * er, R[1] * er, R[2] * er, a.mie * em);
      } else {
        U.uSky.value[i].set(0, 0, 0);
        U.uBeta.value[i].set(0, 0, 0, 0);
      }
      // the fireball as a light source
      // (the fireball's surface, then the hot core glowing through the rising cloud)
      blackbody(st.T, bb);
      blackbody(st.coreT, cb);
      const I = SUN_DISC_RADIANCE * ctx.exposure * Math.PI * st.fireR * st.fireR * st.fireDens;
      const Ic = st.coreT > st.T ? SUN_DISC_RADIANCE * ctx.exposure * Math.PI * (0.5 * st.b) ** 2 * 0.3 * st.fireDens : 0;
      for (let c = 0; c < 3; c++) bb[c] = bb[c] * I + cb[c] * Ic;
      U.uGlowI.value[i].set(bb[0], bb[1], bb[2]);
      // terrain: flash light, scorched ground, fires, crater, ejecta blanket
      let pb = perBody.get(b.view);
      if (!pb) perBody.set(b.view, (pb = []));
      pb.push({ b, I: [bb[0], bb[1], bb[2]] });
    });
    for (const v of app.viewList) {
      const items = perBody.get(v) || [];
      for (const mat of [v.material, v.cloudMaterial]) {
        if (!mat || !mat.uniforms.uBlastCount) continue;
        const T = mat.uniforms;
        T.uBlastCount.value = Math.min(items.length, MAX_BLASTS);
        items.forEach(({ b, I }, i) => {
          if (i >= MAX_BLASTS) return;
          const st = b.st, det = b.det;
          const g = _v.copy(b.gz).sub(v.camPF);
          T.uBlastG.value[i].set(g.x, g.y, g.z, b.age);
          const l = _v.copy(b.up).multiplyScalar(st.headZ).add(b.gz).sub(v.camPF);
          T.uBlastL.value[i].set(l.x, l.y, l.z, Math.max(st.fireR, 1));
          T.uBlastI.value[i].set(I[0], I[1], I[2], det.Rc);
          T.uBlastS.value[i].set(det.effects.thermal || det.Rfb * 4, b.fire, st.landed || 0, det.env.air ? 0 : 1);
        });
      }
    }
  }

  renderVolumes(renderer, readBuffer) {
    const U = this.uniforms;
    if (!U.uCount.value || !readBuffer.depthTexture) return;
    const w = readBuffer.width, h = readBuffer.height;
    if (this.depthRT.width !== w || this.depthRT.height !== h) this.depthRT.setSize(w, h);
    const C = this.copyMaterial.uniforms;
    C.uDepthTex.value = readBuffer.depthTexture;
    C.uLogFar.value = Math.log2(this.app.camera.far + 1);
    C.uResolution.value.set(w, h);
    C.uPick.value.set(-1, -1);
    U.uResolution.value.set(w, h);
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.depthRT);
    this.copyQuad.render(renderer);
    renderer.setRenderTarget(readBuffer);
    this.quad.render(renderer);
    renderer.autoClear = ac;
  }
}
