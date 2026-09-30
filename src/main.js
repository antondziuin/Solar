import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import * as Astronomy from 'astronomy-engine';

import { BODIES } from './data/bodies.js';
import { AU } from './core/constants.js';
import { Ephemeris } from './core/ephemeris.js';
import { sunlightFraction } from './core/eclipse.js';
import { TerrainModel, EquirectSampler, CoastSampler } from './core/terrainModel.js';
import { CameraController } from './core/CameraController.js';
import { BodyView } from './render/BodyView.js';
import { Sky } from './render/Sky.js';
import { Orbits } from './render/Orbits.js';
import { Markers } from './render/Markers.js';
import { TerrainShadows } from './render/TerrainShadows.js';
import { UI } from './ui/ui.js';
import { EarthDEM } from './core/earthDem.js';

const BASE = import.meta.env.BASE_URL;

class SimClock {
  constructor() {
    this.setDate(new Date());
    this.rate = 1;
    this.paused = false;
  }
  setDate(d) { this.ut = Astronomy.MakeTime(d).ut; }
  date() { return new Date(Date.UTC(2000, 0, 1, 12) + this.ut * 86400000); }
  tick(dt) { if (!this.paused) this.ut += (dt * this.rate) / 86400; }
}

async function loadImageData(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, img.width, img.height);
}

class App {
  constructor() {
    this.canvas = document.getElementById('view');
    this.settings = { ev: 0, ambient: 0, bloom: 0.5, detail: 1.1, resolution: 1 };
    this.autoScale = 1; // dynamic resolution (<= 1), applied on top of the user setting
    this._ftAvg = 16;
    this._ftCheck = 0;
    this.clock = new SimClock();
    this.ephem = new Ephemeris(BODIES);
    this.views = {};
    this.exposure = 1;
    this.pixelAngle = 0.001;
    this.pixelRatio = 1;
  }

  async init() {
    const setText = (t) => { document.getElementById('loading-text').textContent = t; };
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1e14);
    this.camera.matrixAutoUpdate = true;

    setText('Loading textures…');
    const tl = new THREE.TextureLoader();
    const tex = async (name, srgb) => {
      const t = await tl.loadAsync(`${BASE}textures/${name}`);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.anisotropy = 4;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      return t;
    };
    this.dem = new EarthDEM();
    const [earth_day, earth_lights, earth_clouds, earth_coast, moon_albedo, lakeLevels] = await Promise.all([
      tex('earth_day.jpg', true), tex('earth_lights.jpg', false), tex('earth_clouds.jpg', false),
      tex('earth_coast.png', false), tex('moon_albedo.png', false),
      fetch(`${BASE}textures/earth_lakes.json`).then((r) => r.json()),
      this.dem.loadBase(`${BASE}textures/earth_dem.png`),
    ]);
    const earth_lakes = new THREE.DataTexture(new Float32Array(256), 256, 1, THREE.RedFormat, THREE.FloatType);
    lakeLevels.forEach((h, i) => { earth_lakes.image.data[i + 1] = h; });
    earth_lakes.needsUpdate = true;
    this.textures = { earth_day, earth_lights, earth_clouds, earth_coast, earth_lakes, moon_albedo, dem: this.dem };
    const moonData = await loadImageData(`${BASE}textures/moon_albedo.png`);

    setText('Building worlds…');
    try { await this.ephem.loadTables(BASE); } catch (e) { console.warn('trajectory tables', e); }
    this.ephem.update(this.clock.ut);
    for (const b of BODIES) {
      const model = new TerrainModel(b);
      if (b.id === 'earth') { model.coast = new CoastSampler(earth_coast.image, lakeLevels); model.dem = this.dem; }
      if (b.id === 'moon') model.samplers = { albedo: new EquirectSampler(moonData) };
      this.views[b.id] = new BodyView(b, model, this.textures, this.scene);
    }
    this.viewList = BODIES.map((b) => this.views[b.id]);
    // real elevation models and surface maps (loaded per body when it is first seen)
    try {
      const manifest = await fetch(`${BASE}bodies/manifest.json`).then((r) => r.json());
      for (const [id, entry] of Object.entries(manifest)) if (this.views[id]) this.views[id].assets = entry;
    } catch (e) { console.warn('no body data manifest', e); }

    this.sky = new Sky();
    setText('Loading 41 000 stars…');
    await this.sky.load(BASE);
    this.orbits = new Orbits(this.scene, this.ephem);
    this.shadows = new TerrainShadows();
    this.markers = new Markers(this.scene, BODIES.length);

    // post-processing: sky pass, scene pass, bloom, tone mapping
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    const skyPass = new RenderPass(this.sky.scene, this.sky.camera);
    skyPass.clearColor = new THREE.Color(0, 0, 0);
    skyPass.clearAlpha = 1;
    const mainPass = new RenderPass(this.scene, this.camera);
    mainPass.clear = false;
    mainPass.clearDepth = true;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), this.settings.bloom, 0.55, 1.3);
    this.composer.addPass(skyPass);
    this.composer.addPass(mainPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.controller = new CameraController(this.camera, this.canvas, this);
    this.onFocus = (b) => this.ui?.setActive(b);
    this.ui = new UI(this);
    this.frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.canvas.addEventListener('dblclick', (e) => this.pick(e));

    // start at Earth, or at the body named in the URL hash
    const start = BODIES.find((b) => b.id === location.hash.slice(1)) || this.ephem.byId.earth;
    this.controller.focusOn(start, { instant: true });
    this.ui.setActive(start);
    window.addEventListener('hashchange', () => {
      const b = this.ephem.byId[location.hash.slice(1)];
      if (b) this.controller.focusOn(b);
    });

    document.getElementById('loading').classList.add('done');
    this._last = performance.now();
    renderer.setAnimationLoop((t) => this.frame(t));
  }

  /** Jump to a viewpoint: lat/lon in degrees (body-fixed when locked), altitude in metres. */
  view(id, { alt, lat = 0, lon = 0, heading = 0, pitch = 0, locked } = {}) {
    const b = this.ephem.byId[id];
    const c = this.controller;
    const R = this.views[id].model.R;
    const D = Math.PI / 180;
    c.fly = null;
    c.focus = b;
    c.locked = locked ?? alt < 1.5 * R;
    Object.assign(c.s, { lon: lon * D, lat: lat * D, alt, heading: heading * D, pitch: pitch * D });
    Object.assign(c.t, c.s);
    this.ui.setActive(b);
    this.exposure = this._exposureFor(b);
  }

  /**
   * Apophis' Earth flyby of 13 April 2029: go to 20:00 UTC at 1 min/s and look at the asteroid
   * with the Earth behind it (closest approach 21:46 UTC, 38 000 km). Apophis passes over the
   * night side, so both are seen as crescents, the Earth with its city lights.
   */
  apophisFlyby() {
    this.clock.setDate(new Date(Date.UTC(2029, 3, 13, 20, 0, 0)));
    this.ui.setRate(60);
    this.ephem.update(this.clock.ut);
    const a = this.ephem.byId.apophis, e = this.ephem.byId.earth;
    const away = a.state.pos.clone().sub(e.state.pos).normalize();
    // offset ~20 deg towards the Sun so that the Earth sits beside the asteroid, not hidden by it
    const sun = a.state.pos.clone().negate().normalize();
    const perp = sun.addScaledVector(away, -sun.dot(away));
    if (perp.lengthSq() < 1e-6) perp.set(0, 1, 0).addScaledVector(away, -away.y);
    const dir = away.addScaledVector(perp.normalize(), 0.36).normalize();
    this.view('apophis', { alt: 1200, locked: false });
    const F = this.controller.frame(a, false, new THREE.Matrix3());
    const p = dir.applyMatrix3(F.clone().transpose());
    this.view('apophis', { alt: 1200, lat: Math.asin(p.z) * 180 / Math.PI, lon: Math.atan2(p.y, p.x) * 180 / Math.PI, locked: false });
  }

  /**
   * Jump to an eclipse: a solar one seen from above the point of greatest eclipse (the Moon's
   * shadow crossing the Earth), a lunar one looking at the Earth-facing side of the Moon.
   * Starts shortly before the peak at 1 min/s.
   */
  watchEclipse(kind, e) {
    const peak = e.peak.date.getTime();
    const lead = kind === 'lunar' ? Math.min(100, (e.sd_partial || e.sd_penum || 60) + 10) : 50;
    this.clock.setDate(new Date(peak - lead * 60000));
    this.ui.setRate(60);
    this.ephem.update(this.clock.ut);
    const toLatLon = (b, target) => {
      const d = target.state.pos.clone().sub(b.state.pos).applyMatrix3(b.state.rotInv).normalize();
      return { lat: Math.asin(d.z) * 180 / Math.PI, lon: Math.atan2(d.y, d.x) * 180 / Math.PI };
    };
    if (kind === 'solar') {
      const ll = e.latitude !== undefined ? { lat: e.latitude, lon: e.longitude } : toLatLon(this.ephem.byId.earth, this.ephem.byId.moon);
      this.view('earth', { alt: 9e6, lat: ll.lat, lon: ll.lon, locked: true });
    } else {
      const ll = toLatLon(this.ephem.byId.moon, this.ephem.byId.earth);
      this.view('moon', { alt: 7e6, lat: ll.lat, lon: ll.lon, locked: true });
    }
  }

  setDetail(v) {
    this.settings.detail = v;
    for (const view of Object.values(this.views)) {
      view.lod.splitK = v;
      if (view.cloudLod) view.cloudLod.splitK = v * 0.8;
    }
  }

  setResolution(v) {
    this.settings.resolution = v;
    this.resize();
  }

  resize() {
    if (!this.renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * (this.settings.resolution || 1) * this.autoScale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pixelAngle = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / (h * this.pixelRatio);
  }

  /** Double-click: fly to the body under the cursor (ray-sphere in double precision). */
  pick(e) {
    const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).normalize();
    let best = null, bestT = Infinity;
    for (const v of this.viewList) {
      const R = v.model.R * (v.pixelRadius < 6 ? 6 / Math.max(v.pixelRadius, 0.01) : 1);
      const b = dir.dot(v.relCam);
      const c = v.relCam.lengthSq() - R * R;
      const disc = b * b - c;
      if (disc < 0 || b < 0) continue;
      const t = b - Math.sqrt(disc);
      if (t < bestT) { bestT = t; best = v.body; }
    }
    if (best && best !== this.controller.focus) this.controller.focusOn(best);
  }

  /** Exposure that makes a sunlit surface of `body` look right (eye adaptation). */
  _exposureFor(body) {
    let d;
    if (!body || body.type === 'star') d = Math.max(this.controller.position.length(), 0.25 * AU);
    else d = body.state.pos.length();
    // partial adaptation to the body's brightness (dark Mercury, dazzling Enceladus)
    const adapt = body && body.type !== 'star' ? Math.min(1.6, Math.max(0.6, Math.sqrt(0.3 / (body.albedo || 0.3)))) : 1;
    // eyes adapt (up to ~9 stops) when the body looked at - or the place the camera is at - lies
    // in an eclipse shadow: the red Moon in the Earth's umbra, the landscape under totality
    let dark = 1;
    if (body && body.type !== 'star') {
      const cam = this.controller.position;
      const sun = this.ephem.byId.sun;
      const R = body.radius * 1000;
      const toCam = cam.clone().sub(body.state.pos);
      if (toCam.length() < R * 1.2) {
        dark = sunlightFraction(cam, this.ephem.bodies, sun, body, !!body.atmosphere);
      } else {
        // adapt to the brightest part of the disc (a partly eclipsed Moon is judged by its lit limb)
        toCam.normalize();
        const u = new THREE.Vector3().crossVectors(toCam, Math.abs(toCam.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
        const v = new THREE.Vector3().crossVectors(toCam, u);
        dark = sunlightFraction(body.state.pos, this.ephem.bodies, sun, body);
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const p = body.state.pos.clone().addScaledVector(u, Math.cos(a) * R * 0.9).addScaledVector(v, Math.sin(a) * R * 0.9);
          dark = Math.max(dark, sunlightFraction(p, this.ephem.bodies, sun, body));
        }
      }
      dark = Math.max(dark, 1 / 400);
    }
    return 5.0 * (d / AU) ** 2 * adapt * 2 ** this.settings.ev / dark;
  }

  _autoExposure(dt) {
    const fly = this.controller.fly;
    if (fly) {
      // adapt along the flight, so nothing changes after arrival
      const a = Math.log(this._exposureFor(fly.from)), b = Math.log(this._exposureFor(fly.body));
      this.exposure = Math.exp(a + (b - a) * fly.e);
      return;
    }
    const target = this._exposureFor(this.controller.focus);
    const k = 1 - Math.exp(-dt * 2.5);
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * k);
  }

  /** Distance to the closest thing that could be drawn (surfaces, ring planes), for the near plane. */
  _nearestGeometry(alt) {
    let d = alt;
    const cam = this.controller.position;
    for (const v of this.viewList) {
      const b = v.body;
      const rel = cam.clone().sub(b.state.pos);
      const r = rel.length();
      d = Math.min(d, Math.max(r - v.model.R - v.model.maxRelief, 0.05));
      if (v.rings) {
        const p = rel.applyMatrix3(b.state.rotInv);
        const rr = Math.hypot(p.x, p.y);
        const radial = rr < v.rings.inner ? v.rings.inner - rr : rr > v.rings.outer ? rr - v.rings.outer : 0;
        d = Math.min(d, Math.max(Math.hypot(radial, p.z), 0.05));
      }
    }
    return d;
  }

  /** Keep the frame time reasonable on slower GPUs by scaling the render resolution. */
  _dynamicResolution(rawDt) {
    if (rawDt > 0.5) return; // tab was hidden / stalled
    this._ftAvg = this._ftAvg * 0.95 + rawDt * 1000 * 0.05;
    this._ftCheck += rawDt;
    if (this._ftCheck < 1.5) return;
    this._ftCheck = 0;
    let s = this.autoScale;
    if (this._ftAvg > 40 && s > 0.5) s = Math.max(0.5, s - 0.1);
    else if (this._ftAvg < 20 && s < 1) s = Math.min(1, s + 0.1);
    if (s !== this.autoScale) { this.autoScale = s; this.resize(); }
  }

  /** Stream real elevation tiles around the point below the camera. */
  _updateDem() {
    const earth = this.ephem.byId.earth;
    const p = this.controller.position.clone().sub(earth.state.pos).applyMatrix3(earth.state.rotInv);
    const r = p.length();
    const lat = Math.asin(p.z / r) * 180 / Math.PI, lon = Math.atan2(p.y, p.x) * 180 / Math.PI;
    const alt = r - 6371000 - Math.max(this.views.earth.groundH, 0);
    this.dem.update(lat, lon, Math.max(alt, 1));
  }

  frame(now) {
    const rawDt = (now - this._last) / 1000;
    this._fps = this._fps ? this._fps * 0.9 + 0.1 / Math.max(rawDt, 1e-3) : 1 / Math.max(rawDt, 1e-3);
    const dt = Math.min(0.1, rawDt);
    this._dynamicResolution(rawDt);
    this._last = now;
    this.clock.tick(dt);
    this.ephem.update(this.clock.ut);
    this.controller.update(dt);
    this._autoExposure(dt);
    this._updateDem();

    const cam = this.camera;
    const camPos = this.controller.position;
    const alt = Math.max(this.controller.altitude ?? 1e6, 0.1);
    cam.near = Math.min(Math.max(this._nearestGeometry(alt) * 0.1, 0.01), 1e5);
    cam.updateProjectionMatrix();
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._projScreen);

    const frustum = this.frustum;
    // per-pixel view rays: columns = right * tan(fovx/2), up * tan(fovy/2), forward (world)
    const ty = Math.tan((cam.fov * Math.PI) / 360), tx = ty * cam.aspect;
    const me = cam.matrixWorld.elements;
    this._invViewProj = (this._invViewProj || new THREE.Matrix3()).set(
      me[0] * tx, me[4] * ty, -me[8],
      me[1] * tx, me[5] * ty, -me[9],
      me[2] * tx, me[6] * ty, -me[10]);
    this._resolution = this.renderer.getDrawingBufferSize(this._resolution || new THREE.Vector2());
    const sphere = new THREE.Sphere();
    const ctx = {
      camPos, frustum, pixelAngle: this.pixelAngle, pixelRatio: this.pixelRatio, exposure: this.exposure,
      time: now / 1000, ambient: this.settings.ambient, bodies: this.ephem.bodies, byId: this.ephem.byId,
      sun: this.ephem.byId.sun, views: this.views, markerFloor: 0.03,
      base: BASE, focusId: (this.controller.fly?.body || this.controller.focus)?.id,
      invViewProj: this._invViewProj, resolution: this._resolution,
      shadows: this.shadows, alt, camForward: new THREE.Vector3(-me[8], -me[9], -me[10]),
      cameraFacing: (rel, r) => { sphere.center.copy(rel); sphere.radius = r; return frustum.intersectsSphere(sphere); },
    };
    this.shadows.active = false;
    for (const v of this.viewList) v.update(ctx);
    if (!this.shadows.active && this.shadows.view) this.shadows.view.material.uniforms.uShadowOn.value = 0;
    this.shadows.render(this.renderer, ctx);
    this.markers.update(this.viewList, ctx);
    // orbit lines fade out when flying close to a surface
    const fR = this.controller.focus ? this.views[this.controller.focus.id].model.R : 1;
    const lowFade = Math.min(1, Math.max(0, Math.log(alt / (0.02 * fR)) / Math.log(15)));
    this.orbits.update(this.clock.ut, camPos, this.pixelAngle, this.controller.focus?.id, lowFade);
    this.sky.update(cam, 1, this.pixelRatio);
    this.bloom.strength = this.settings.bloom;

    this.composer.render();

    this.ui.updateLabels(cam, this.viewList);
    this.ui.updateTime();
    this.ui.updateHUD();
    this.ui.updateInfo(now);
  }
}

const app = new App();
window.solar = app;
app.init().catch((err) => {
  console.error(err);
  const el = document.getElementById('error');
  el.hidden = false;
  el.textContent = `Failed to start: ${err.message}\n${err.stack || ''}`;
});
