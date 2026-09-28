// Positions and orientations of all bodies, in double precision.
//
// World frame: J2000 ecliptic, metres, heliocentric, mapped onto three.js axes as
//   three.x = ecliptic x (towards the vernal equinox)
//   three.y = ecliptic z (ecliptic north)
//   three.z = -ecliptic y
import * as Astronomy from 'astronomy-engine';
import { Matrix3, Vector3 } from 'three';
import { AU, DEG, DAY, KM, OBLIQUITY_J2000 } from './constants.js';

const cosE = Math.cos(OBLIQUITY_J2000);
const sinE = Math.sin(OBLIQUITY_J2000);

/** EQJ (x,y,z) -> world Vector3 (same units). */
export function eqjToWorld(x, y, z, out = new Vector3()) {
  const ey = cosE * y + sinE * z;
  const ez = -sinE * y + cosE * z;
  return out.set(x, ez, -ey);
}

/** Unit vector in world frame from ICRF right ascension / declination (degrees). */
export function raDecToWorld(raDeg, decDeg, out = new Vector3()) {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  return eqjToWorld(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), out);
}

/**
 * Body-fixed frame from IAU pole (ra, dec) and prime-meridian angle W (degrees).
 * Returns a Matrix3 whose columns are the body x, y, z axes in world coordinates.
 */
export function iauFrame(raDeg, decDeg, wDeg, out = new Matrix3()) {
  const z = raDecToWorld(raDeg, decDeg);
  // Ascending node of the body equator on the ICRF equator lies at RA = ra + 90 deg.
  const node = raDecToWorld(raDeg + 90, 0);
  const nodePerp = new Vector3().crossVectors(z, node);
  const W = wDeg * DEG;
  const x = node.clone().multiplyScalar(Math.cos(W)).addScaledVector(nodePerp, Math.sin(W));
  const y = new Vector3().crossVectors(z, x);
  return out.set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
}

function solveKepler(M, e) {
  M = ((M % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

/**
 * Position (and velocity) of a satellite relative to its parent from J2000 mean elements
 * with J2-driven secular precession of node and periapsis. Result in world frame, metres.
 */
function keplerState(el, parent, planeFrame, tDays, outPos, outVel) {
  const GM = (parent.GM + (el.GMsat || 0)) * 1e9; // m^3/s^2
  const a = el.a * KM;
  const n = Math.sqrt(GM / (a * a * a)); // rad/s
  const e = el.e;
  const inc = el.i * DEG;
  let node = el.node * DEG, peri = el.peri * DEG;
  if (parent.J2 && el.plane === 'equator') {
    const Rp = parent.radius * KM;
    const k = n * parent.J2 * (Rp / a) ** 2 / (1 - e * e) ** 2;
    node += -1.5 * k * Math.cos(inc) * tDays * DAY;
    peri += 0.75 * k * (5 * Math.cos(inc) ** 2 - 1) * tDays * DAY;
  }
  const M = el.M * DEG + n * tDays * DAY;
  const E = solveKepler(M, e);
  const cosE_ = Math.cos(E), sinE_ = Math.sin(E);
  const b = a * Math.sqrt(1 - e * e);
  const px = a * (cosE_ - e), py = b * sinE_;
  const Edot = n / (1 - e * cosE_);
  const vx = -a * sinE_ * Edot, vy = b * cosE_ * Edot;
  // orbital plane -> reference plane
  const cO = Math.cos(node), sO = Math.sin(node), cw = Math.cos(peri), sw = Math.sin(peri), ci = Math.cos(inc), si = Math.sin(inc);
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;
  const lx = r11 * px + r12 * py, ly = r21 * px + r22 * py, lz = r31 * px + r32 * py;
  const lvx = r11 * vx + r12 * vy, lvy = r21 * vx + r22 * vy, lvz = r31 * vx + r32 * vy;
  // reference plane -> world
  const m = planeFrame.elements;
  outPos.set(m[0] * lx + m[3] * ly + m[6] * lz, m[1] * lx + m[4] * ly + m[7] * lz, m[2] * lx + m[5] * ly + m[8] * lz);
  if (outVel) outVel.set(m[0] * lvx + m[3] * lvy + m[6] * lvz, m[1] * lvx + m[4] * lvy + m[7] * lvz, m[2] * lvx + m[5] * lvy + m[8] * lvz);
}

const JUP_MOONS = ['io', 'europa', 'ganymede', 'callisto'];

export class Ephemeris {
  constructor(bodies) {
    this.bodies = bodies;
    this.byId = Object.fromEntries(bodies.map((b) => [b.id, b]));
    for (const b of bodies) {
      b.state = {
        pos: new Vector3(), // heliocentric world position (m)
        vel: new Vector3(), // m/s (approximate for some bodies)
        rel: new Vector3(), // position relative to parent
        rot: new Matrix3(), // body-fixed -> world
        rotInv: new Matrix3(),
        pole: new Vector3(0, 1, 0),
      };
    }
    // topological order so parents are computed before children
    this.order = [];
    const visit = (b) => {
      if (this.order.includes(b)) return;
      if (b.parent) visit(this.byId[b.parent]);
      this.order.push(b);
    };
    bodies.forEach(visit);
    this._tmp = new Vector3();
    this._tmp2 = new Vector3();
  }

  /** Reference plane frame (columns: node direction, in-plane perpendicular, pole) for a satellite. */
  _planeFrame(b, parent, time) {
    const el = b.ephem;
    let ra, dec;
    if (el.plane === 'equator') {
      const ax = parent._axis;
      ra = ax.ra * 15; dec = ax.dec;
    } else {
      ra = el.plane.ra; dec = el.plane.dec;
    }
    return iauFrame(ra, dec, 0, b._planeM || (b._planeM = new Matrix3()));
  }

  update(ut) {
    const time = Astronomy.MakeTime(ut);
    const tDays = time.tt; // days since J2000 (TT)
    let jm = null;
    for (const b of this.order) {
      const s = b.state;
      const parent = b.parent ? this.byId[b.parent] : null;
      // ---- orientation from IAU model (needed before children use the equator plane)
      if (b.rotation.kind === 'iau') {
        const ax = Astronomy.RotationAxis(b.rotation.body, time);
        b._axis = ax;
        iauFrame(ax.ra * 15, ax.dec, ax.spin, s.rot);
      } else if (!b._axis) {
        b._axis = { ra: 0, dec: 90, spin: 0 };
      }
      // ---- position
      const ep = b.ephem;
      if (ep.kind === 'sun') {
        s.pos.set(0, 0, 0);
        s.rel.set(0, 0, 0);
      } else if (ep.kind === 'astro') {
        const v = Astronomy.HelioVector(ep.body, time);
        eqjToWorld(v.x * AU, v.y * AU, v.z * AU, s.pos);
        const v2 = Astronomy.HelioVector(ep.body, time.AddDays(1 / 24));
        eqjToWorld(v2.x * AU, v2.y * AU, v2.z * AU, s.vel).sub(s.pos).divideScalar(3600);
        if (parent) s.rel.copy(s.pos).sub(parent.state.pos);
      } else if (ep.kind === 'jupiterMoon') {
        if (!jm) jm = Astronomy.JupiterMoons(time);
        const sv = jm[JUP_MOONS[ep.index]];
        eqjToWorld(sv.x * AU, sv.y * AU, sv.z * AU, s.rel);
        eqjToWorld(sv.vx * AU / DAY, sv.vy * AU / DAY, sv.vz * AU / DAY, s.vel);
        s.pos.copy(parent.state.pos).add(s.rel);
      } else if (ep.kind === 'kepler') {
        const pf = this._planeFrame(b, parent, time);
        keplerState({ ...ep, GMsat: b.GM }, parent, pf, tDays, s.rel, s.vel);
        s.pos.copy(parent.state.pos).add(s.rel);
      }
      // ---- non-IAU orientation
      if (b.rotation.kind === 'locked') {
        const x = this._tmp.copy(s.rel).negate().normalize();
        const z = this._tmp2.crossVectors(s.rel, s.vel).normalize();
        if (!isFinite(z.x) || z.lengthSq() < 0.5) z.set(0, 1, 0);
        const y = new Vector3().crossVectors(z, x).normalize();
        const zz = new Vector3().crossVectors(x, y);
        s.rot.set(x.x, y.x, zz.x, x.y, y.y, zz.y, x.z, y.z, zz.z);
      } else if (b.rotation.kind === 'chaotic' || b.rotation.kind === 'spin') {
        const W = (tDays / b.rotation.period) * 360;
        const tilt = b.rotation.kind === 'chaotic' ? 40 + 20 * Math.sin(tDays / 37) : 10;
        iauFrame(20 + tDays * 0.9, 90 - tilt, W, s.rot);
      }
      s.rotInv.copy(s.rot).transpose();
      s.pole.set(s.rot.elements[6], s.rot.elements[7], s.rot.elements[8]);
    }
    // Pluto–Charon: astronomy-engine gives the system barycentre; split it by mass.
    for (const b of this.bodies) {
      const partnerId = b.ephem.barycentricPartner;
      if (!partnerId) continue;
      const c = this.byId[partnerId];
      const q = c.mass / (b.mass + c.mass);
      const bary = this._tmp.copy(b.state.pos);
      b.state.pos.copy(bary).addScaledVector(c.state.rel, -q);
      c.state.pos.copy(bary).addScaledVector(c.state.rel, 1 - q);
    }
  }

  /** Sample the orbit of `b` relative to its parent over one period (for drawing). */
  sampleOrbit(b, ut, n = 512) {
    const parent = this.byId[b.parent];
    const pts = [];
    const ep = b.ephem;
    if (ep.kind === 'kepler') {
      const time = Astronomy.MakeTime(ut);
      const pf = this._planeFrame(b, parent, time);
      const a = ep.a * KM;
      const period = 2 * Math.PI * Math.sqrt((a * a * a) / ((parent.GM + b.GM) * 1e9)) / DAY;
      const p = new Vector3();
      for (let k = 0; k < n; k++) {
        keplerState({ ...ep, GMsat: b.GM }, parent, pf, time.tt + (period * k) / n, p, null);
        pts.push(p.clone());
      }
      return pts;
    }
    // Numerically sample with the full ephemeris (planets, Moon, Galilean moons).
    const period = orbitalPeriodDays(b, parent);
    const time0 = Astronomy.MakeTime(ut);
    for (let k = 0; k < n; k++) {
      const t = time0.AddDays(-period / 2 + (period * k) / n);
      let v;
      if (ep.kind === 'astro') {
        if (b.id === 'moon') {
          const g = Astronomy.GeoMoon(t);
          v = eqjToWorld(g.x * AU, g.y * AU, g.z * AU);
        } else {
          const h = Astronomy.HelioVector(ep.body, t);
          v = eqjToWorld(h.x * AU, h.y * AU, h.z * AU);
        }
      } else if (ep.kind === 'jupiterMoon') {
        const sv = Astronomy.JupiterMoons(t)[JUP_MOONS[ep.index]];
        v = eqjToWorld(sv.x * AU, sv.y * AU, sv.z * AU);
      }
      pts.push(v);
    }
    return pts;
  }
}

export function orbitalPeriodDays(b, parent) {
  const known = { mercury: 87.969, venus: 224.701, earth: 365.256, mars: 686.98, jupiter: 4332.59, saturn: 10759.22, uranus: 30688.5, neptune: 60182, pluto: 90560, moon: 27.3217, io: 1.769138, europa: 3.551181, ganymede: 7.154553, callisto: 16.689018 };
  if (known[b.id]) return known[b.id];
  const a = b.ephem.a * KM;
  return 2 * Math.PI * Math.sqrt((a * a * a) / ((parent.GM + b.GM) * 1e9)) / DAY;
}
