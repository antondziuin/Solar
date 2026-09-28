// Planet-centred camera: orbit around the focused body, zoom by altitude above the actual
// terrain (from metres to light-hours), look around at the horizon, and fly between bodies.
import * as THREE from 'three';
import { KM } from './constants.js';

const _m = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const Y_UP = new THREE.Vector3(0, 1, 0);

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraController {
  constructor(camera, dom, app) {
    this.camera = camera;
    this.dom = dom;
    this.app = app;
    this.position = new THREE.Vector3(); // world, double precision
    this.focus = null;
    this.locked = false;
    this.autoLock = true;
    // state and smoothed targets
    this.s = { lon: 0, lat: 0.3, alt: 1e7, heading: 0, pitch: 0 };
    this.t = { ...this.s };
    this.fly = null;
    this.minAlt = 1.8;
    this.sensitivity = 1; // user multiplier (Settings -> Mouse speed)
    this._pointers = new Map();
    this._bind();
  }

  // ---------------------------------------------------------------- frames
  frame(body, locked, out = new THREE.Matrix3()) {
    if (locked) return out.copy(body.state.rot);
    const z = (body.state.inertialPole || body.state.pole).clone();
    let x = new THREE.Vector3().crossVectors(Y_UP, z);
    if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
    x.normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    return out.set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
  }

  surfaceRadius(body, dirBody) {
    const view = this.app.views[body.id];
    const [a, b, c] = view.model.radii;
    const r = 1 / Math.sqrt((dirBody.x / a) ** 2 + (dirBody.y / b) ** 2 + (dirBody.z / c) ** 2);
    return r;
  }

  groundAt(body, dirBody, alt) {
    const view = this.app.views[body.id];
    const r = this.surfaceRadius(body, dirBody);
    if (view.model.kind !== 'rock' || alt > 4 * r) return r;
    return r + view.model.groundHeight(dirBody.x, dirBody.y, dirBody.z, Math.max(alt * 0.05, 0.25));
  }

  // ---------------------------------------------------------------- state <-> world
  _unit(lon, lat, out = new THREE.Vector3()) {
    return out.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  }

  /** Set the orbit state from a world-space camera position (keeps heading/pitch). */
  setFromWorld(body, worldPos, locked = this.locked) {
    const F = this.frame(body, locked, _m.clone());
    const rel = worldPos.clone().sub(body.state.pos);
    const Ft = F.clone().transpose();
    const p = rel.clone().applyMatrix3(Ft);
    const r = p.length();
    const u = p.clone().divideScalar(r);
    const dirBody = rel.clone().normalize().applyMatrix3(body.state.rotInv);
    const g = this.groundAt(body, dirBody, r);
    this.s.lon = this.t.lon = Math.atan2(u.y, u.x);
    this.s.lat = this.t.lat = Math.asin(Math.max(-1, Math.min(1, u.z)));
    this.s.alt = this.t.alt = Math.max(r - g, this.minAlt);
  }

  focusOn(body, { instant = false, altitude } = {}) {
    const view = this.app.views[body.id];
    const R = view.model.R;
    const alt = altitude ?? (body.type === 'star' ? R * 3 : R * 2.2);
    // final viewpoint: from the sunward side, ~40 degrees off, slightly above the equator
    const sun = this.app.ephem.byId.sun;
    let toSun = sun.state.pos.clone().sub(body.state.pos);
    if (toSun.lengthSq() < 1) toSun.set(1, 0.2, 0.4);
    toSun.normalize();
    const F = this.frame(body, false, new THREE.Matrix3());
    const p = toSun.applyMatrix3(F.clone().transpose());
    const lon = Math.atan2(p.y, p.x) + (body.type === 'star' ? 0 : 0.7);
    const lat = 0.28;
    if (instant || !this.focus) {
      this.focus = body;
      this.locked = false;
      Object.assign(this.s, { lon, lat, alt, heading: 0, pitch: 0 });
      Object.assign(this.t, this.s);
      this.app.onFocus?.(body);
      return;
    }
    this.fly = {
      body, t: 0, e: 0,
      from: this.focus,
      startPos: this.position.clone(),
      startRel: this.position.clone().sub(body.state.pos),
      startQuat: this.camera.quaternion.clone(),
      end: { lon, lat, alt, heading: 0, pitch: 0 },
      dur: 0,
    };
    const d0 = this.fly.startRel.length();
    const d1 = alt + R;
    this.fly.dur = Math.min(7, Math.max(2.2, 1.6 + 0.9 * Math.abs(Math.log10(d0 / d1))));
    this.app.onFocus?.(body);
  }

  // ---------------------------------------------------------------- input
  _bind() {
    const el = this.dom;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey || e.ctrlKey });
      this._pinch = null;
    });
    el.addEventListener('pointermove', (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (this._pointers.size === 2) {
        const pts = [...this._pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const cy = (pts[0].y + pts[1].y) / 2;
        if (this._pinch) {
          this.zoom(Math.log(this._pinch.d / d) * 2.2);
          this.look(0, (cy - this._pinch.cy) * 0.6);
        }
        this._pinch = { d, cy };
        return;
      }
      if (this.fly) return;
      if (p.button === 2 || p.shift) this.look(dx, dy);
      else this.drag(dx, dy);
    });
    const up = (e) => { this._pointers.delete(e.pointerId); this._pinch = null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : 1;
      this.zoom(e.deltaY * k * 0.0022 * Math.sqrt(this.sensitivity));
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const step = 15;
      switch (e.key) {
        case 'ArrowLeft': this.drag(step, 0); break;
        case 'ArrowRight': this.drag(-step, 0); break;
        case 'ArrowUp': this.drag(0, step); break;
        case 'ArrowDown': this.drag(0, -step); break;
        case '+': case '=': case 'PageUp': this.zoom(-0.25); break;
        case '-': case '_': case 'PageDown': this.zoom(0.25); break;
        case 'w': this.look(0, -20); break;
        case 's': this.look(0, 20); break;
        case 'a': this.look(-20, 0); break;
        case 'd': this.look(20, 0); break;
        default: return;
      }
      e.preventDefault();
    });
  }

  drag(dx, dy) {
    if (!this.focus || this.fly) return;
    const view = this.app.views[this.focus.id];
    const r = this.t.alt + view.model.R;
    // angle of one CSS pixel (independent of device pixel ratio and dynamic resolution)
    const cssPixelAngle = this.app.pixelAngle * this.app.pixelRatio;
    const scale = cssPixelAngle * Math.max(this.t.alt, this.minAlt) / r * 2.2 * this.sensitivity;
    const psi = this.t.heading;
    const dN = (dy * Math.cos(psi) + dx * Math.sin(psi)) * scale;
    const dE = (dy * Math.sin(psi) - dx * Math.cos(psi)) * scale;
    this.t.lat = Math.max(-1.5705, Math.min(1.5705, this.t.lat + dN));
    this.t.lon += dE / Math.max(Math.cos(this.t.lat), 0.02);
  }

  look(dx, dy) {
    if (this.fly) return;
    const k = 0.008 * this.sensitivity;
    this.t.heading += dx * k;
    this.t.pitch = Math.max(0, Math.min(Math.PI / 2 + 0.35, this.t.pitch + dy * k));
  }

  zoom(amount) {
    if (this.fly) return;
    const R = this.focus ? this.app.views[this.focus.id].model.R : 1e7;
    const maxAlt = 2e14;
    this.t.alt = Math.max(this.minAlt, Math.min(maxAlt, this.t.alt * Math.exp(amount)));
    // tilt back to the planet when zooming far out
    if (this.t.alt > 3 * R) this.t.pitch *= 0.8;
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    if (!this.focus) return;
    if (this.fly) return this._updateFly(dt);
    const body = this.focus;
    const view = this.app.views[body.id];
    const R = view.model.R;

    // automatic co-rotation near the surface
    if (this.autoLock) {
      const want = body.type !== 'star' && this.t.alt < 1.5 * R;
      if (want !== this.locked) this._switchFrame(want);
    }
    const k = 1 - Math.exp(-dt * 12);
    const s = this.s, t = this.t;
    s.lon += (t.lon - s.lon) * k;
    s.lat += (t.lat - s.lat) * k;
    s.alt = Math.exp(Math.log(s.alt) + (Math.log(t.alt) - Math.log(s.alt)) * k);
    s.heading += (t.heading - s.heading) * k;
    s.pitch += (t.pitch - s.pitch) * k;
    this._apply(body, s);
  }

  _switchFrame(locked) {
    const body = this.focus;
    const world = this.position.clone();
    const F0 = this.frame(body, this.locked, new THREE.Matrix3());
    const F1 = this.frame(body, locked, new THREE.Matrix3());
    // convert the smoothed and target lon (both frames share the pole)
    const conv = (lon, lat) => {
      const w = this._unit(lon, lat).applyMatrix3(F0);
      const p = w.applyMatrix3(F1.clone().transpose());
      return Math.atan2(p.y, p.x);
    };
    this.s.lon = conv(this.s.lon, this.s.lat);
    this.t.lon = conv(this.t.lon, this.t.lat);
    this.locked = locked;
    void world;
  }

  _apply(body, s) {
    const F = this.frame(body, this.locked, _m);
    const u = this._unit(s.lon, s.lat);
    const uw = u.clone().applyMatrix3(F);
    const dirBody = uw.clone().applyMatrix3(body.state.rotInv);
    const g = this.groundAt(body, dirBody, s.alt);
    const r = g + Math.max(s.alt, this.minAlt);
    this.position.copy(body.state.pos).addScaledVector(uw, r);
    this.altitude = r - g;
    this.groundRadius = g;
    // orientation: base looks at the centre with north up, then heading / pitch
    const zF = new THREE.Vector3(F.elements[6], F.elements[7], F.elements[8]);
    let east = new THREE.Vector3().crossVectors(zF, uw);
    if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(uw, east);
    const hdir = north.clone().multiplyScalar(Math.cos(s.heading)).addScaledVector(east, Math.sin(s.heading));
    const fwd = uw.clone().multiplyScalar(-Math.cos(s.pitch)).addScaledVector(hdir, Math.sin(s.pitch));
    const upv = uw.clone().multiplyScalar(Math.sin(s.pitch)).addScaledVector(hdir, Math.cos(s.pitch));
    this._setBasis(fwd, upv);
  }

  _setBasis(fwd, up) {
    const z = fwd.clone().negate().normalize();
    const x = new THREE.Vector3().crossVectors(up, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    const m4 = new THREE.Matrix4().makeBasis(x, y, z);
    this.camera.quaternion.setFromRotationMatrix(m4);
  }

  _updateFly(dt) {
    const f = this.fly;
    f.t = Math.min(1, f.t + dt / f.dur);
    const e = ease(f.t);
    f.e = e;
    const body = f.body;
    const R = this.app.views[body.id].model.R;
    const F = this.frame(body, false, _m);
    const endRel = this._unit(f.end.lon, f.end.lat).applyMatrix3(F).multiplyScalar(f.end.alt + R);
    const d0 = f.startRel.length(), d1 = endRel.length();
    const dir = f.startRel.clone().normalize();
    const dir1 = endRel.clone().normalize();
    // slerp directions
    const ang = Math.acos(Math.max(-1, Math.min(1, dir.dot(dir1))));
    let dirT;
    if (ang < 1e-6) dirT = dir1;
    else {
      const sa = Math.sin(ang);
      dirT = dir.clone().multiplyScalar(Math.sin((1 - e) * ang) / sa).addScaledVector(dir1, Math.sin(e * ang) / sa);
    }
    // log-distance with a gentle pull-back in the middle for long jumps
    const bump = 1 + 0.6 * Math.sin(Math.PI * e) * Math.min(1, Math.abs(Math.log10(d0 / d1)) / 3);
    const dT = Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * e) * bump;
    this.position.copy(body.state.pos).addScaledVector(dirT, dT);
    // orientation: turn towards the target early in the flight
    const toBody = dirT.clone().negate();
    const up = body.state.pole.clone();
    const z = toBody.clone().negate();
    let x = new THREE.Vector3().crossVectors(up, z);
    if (x.lengthSq() < 1e-10) x.set(1, 0, 0);
    x.normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    _q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    const turn = Math.min(1, f.t / 0.35);
    this.camera.quaternion.copy(f.startQuat).slerp(_q, ease(turn));
    this.altitude = dT - R;
    if (f.t >= 1) {
      this.focus = body;
      this.locked = false;
      Object.assign(this.s, f.end);
      Object.assign(this.t, f.end);
      this.fly = null;
      this._apply(body, this.s);
    }
  }
}
