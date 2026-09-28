import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import * as Astronomy from 'astronomy-engine';

import { BODIES } from './data/bodies.js';
import { AU } from './core/constants.js';
import { Ephemeris } from './core/ephemeris.js';
import { TerrainModel, EquirectSampler } from './core/terrainModel.js';
import { CameraController } from './core/CameraController.js';
import { BodyView } from './render/BodyView.js';
import { Sky } from './render/Sky.js';
import { Orbits } from './render/Orbits.js';
import { Markers } from './render/Markers.js';
import { UI } from './ui/ui.js';

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
    this.settings = { ev: 0, ambient: 0, bloom: 0.5, detail: 1.5, resolution: 1 };
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
    const [earth_day, earth_lights, earth_clouds, earth_water, earth_topo, moon_albedo] = await Promise.all([
      tex('earth_day.jpg', true), tex('earth_lights.jpg', false), tex('earth_clouds.jpg', false),
      tex('earth_water.png', false), tex('earth_topo.png', false), tex('moon_albedo.png', false),
    ]);
    this.textures = { earth_day, earth_lights, earth_clouds, earth_water, earth_topo, moon_albedo };
    const [waterData, topoData, moonData] = await Promise.all([
      loadImageData(`${BASE}textures/earth_water.png`), loadImageData(`${BASE}textures/earth_topo.png`), loadImageData(`${BASE}textures/moon_albedo.png`),
    ]);

    setText('Building worlds…');
    this.ephem.update(this.clock.ut);
    for (const b of BODIES) {
      const model = new TerrainModel(b);
      if (b.id === 'earth') model.samplers = { water: new EquirectSampler(waterData), topo: new EquirectSampler(topoData) };
      if (b.id === 'moon') model.samplers = { albedo: new EquirectSampler(moonData) };
      this.views[b.id] = new BodyView(b, model, this.textures, this.scene);
    }
    this.viewList = BODIES.map((b) => this.views[b.id]);

    this.sky = new Sky();
    setText('Loading 41 000 stars…');
    await this.sky.load(BASE);
    this.orbits = new Orbits(this.scene, this.ephem);
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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), this.settings.bloom, 0.55, 0.9);
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
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * (this.settings.resolution || 1);
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

  _autoExposure(dt) {
    const f = this.controller.focus;
    let d;
    if (!f || f.type === 'star') d = Math.max(this.controller.position.length(), 0.25 * AU);
    else d = f.state.pos.length();
    const target = 5.0 * (d / AU) ** 2 * 2 ** this.settings.ev;
    const k = 1 - Math.exp(-dt * 2.5);
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * k);
  }

  frame(now) {
    const rawDt = (now - this._last) / 1000;
    this._fps = this._fps ? this._fps * 0.9 + 0.1 / Math.max(rawDt, 1e-3) : 1 / Math.max(rawDt, 1e-3);
    const dt = Math.min(0.1, rawDt);
    this._last = now;
    this.clock.tick(dt);
    this.ephem.update(this.clock.ut);
    this.controller.update(dt);
    this._autoExposure(dt);

    const cam = this.camera;
    const camPos = this.controller.position;
    const alt = Math.max(this.controller.altitude ?? 1e6, 0.1);
    cam.near = Math.min(Math.max(alt * 0.1, 0.02), 1e5);
    cam.updateProjectionMatrix();
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._projScreen);

    const frustum = this.frustum;
    const sphere = new THREE.Sphere();
    const ctx = {
      camPos, frustum, pixelAngle: this.pixelAngle, pixelRatio: this.pixelRatio, exposure: this.exposure,
      time: now / 1000, ambient: this.settings.ambient, bodies: this.ephem.bodies, byId: this.ephem.byId,
      sun: this.ephem.byId.sun, views: this.views, markerFloor: 0.03,
      cameraFacing: (rel, r) => { sphere.center.copy(rel); sphere.radius = r; return frustum.intersectsSphere(sphere); },
    };
    for (const v of this.viewList) v.update(ctx);
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
