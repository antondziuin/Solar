// Physical model of a nuclear explosion: how the fireball, the thermal pulse, the blast wave and
// the mushroom cloud evolve with time for a given yield, height of burst and atmosphere.
//
// Empirical scaling laws from S. Glasstone & P. J. Dolan, "The Effects of Nuclear Weapons"
// (3rd ed., 1977) and the cloud-height data behind it (Fig. 2.16), cross-checked against
// NUKEMAP (A. Wellerstein) for the damage radii:
//  - maximum fireball radius ~ 66 m W^0.4 (W in kt), x 2^(1/3) for a surface burst;
//  - time of the second thermal maximum t2 = 0.0417 s W^0.44; the thermal pulse follows
//    P/Pmax = 2 tau^2 / (1 + tau^4)-like shape, tau = t / t2, ~35 % of the yield as heat;
//  - the fireball's colour is the black body of its effective temperature (Stefan-Boltzmann);
//  - blast wave: Sedov-Taylor point explosion, turning into a sound wave far away;
//  - the hot gas rises as a buoyant vortex ring and stabilises in ~10 min at the heights
//    measured in atmospheric tests (22 km for 1 Mt, 64 km for the 50 Mt Tsar Bomba);
//  - on airless bodies there is no fireball cloud: a crater throws a ballistic ejecta curtain
//    (an inverted cone) that rises and falls back in the body's gravity.
// Units: SI (m, s, K). Yield W in kilotonnes of TNT.

export const KT = 4.184e12; // J
const SIGMA = 5.670374e-8;
const RHO0 = 1.225;

// atmospheres that can carry a blast wave and lift a cloud (surface values)
const AIR = {
  earth: { rho: 1.225, cs: 340, H: 8500, water: true, dust: [0.40, 0.33, 0.26] },
  mars: { rho: 0.020, cs: 240, H: 11100, water: false },
  titan: { rho: 5.4, cs: 194, H: 21000, water: false },
};

/** log-log interpolation in a table of [x, y] rows */
function logInterp(table, x) {
  const lx = Math.log(x);
  if (x <= table[0][0]) return table[0][1] * (x / table[0][0]) ** ((Math.log(table[1][1] / table[0][1])) / Math.log(table[1][0] / table[0][0]));
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      const t = (lx - Math.log(x0)) / (Math.log(x1) - Math.log(x0));
      return Math.exp(Math.log(y0) + t * (Math.log(y1) - Math.log(y0)));
    }
  }
  const n = table.length;
  const [x0, y0] = table[n - 2], [x1, y1] = table[n - 1];
  return y1 * (x / x1) ** (Math.log(y1 / y0) / Math.log(x1 / x0));
}

// stabilised cloud top / cloud base (km) and cap radius (km) versus yield (kt), mid latitudes
const CLOUD_TOP = [[0.001, 0.45], [0.01, 0.9], [0.1, 2.0], [1, 3.6], [10, 7.5], [20, 9.5], [100, 14], [1000, 22], [10000, 37], [50000, 64]];
const CLOUD_BASE = [[0.001, 0.22], [0.01, 0.45], [0.1, 1.1], [1, 2.0], [10, 4.5], [20, 5.8], [100, 8.5], [1000, 13], [10000, 21], [50000, 38]];
const CLOUD_R = [[0.001, 0.12], [0.01, 0.25], [0.1, 0.55], [1, 1.1], [10, 2.6], [20, 3.2], [100, 5.2], [1000, 11], [10000, 28], [50000, 47]];

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** critically damped approach 0 -> 1 (starts at rest) */
const rise = (x) => (x <= 0 ? 0 : 1 - (1 + x) * Math.exp(-x));

// black body: radiance relative to the Sun's photosphere (5772 K) at three wavelengths (R, G, B)
const LAMBDA = [610e-9, 550e-9, 465e-9];
const C2 = 0.014388; // m K
function planckRel(T, i) {
  if (T < 300) return 0;
  const l = LAMBDA[i];
  return Math.expm1(C2 / (l * 5772)) / Math.expm1(Math.min(C2 / (l * T), 700));
}
/** Visible radiance of a black body at T, in units of the Sun's disc radiance, per channel. */
export function blackbody(T, out = [0, 0, 0]) {
  for (let i = 0; i < 3; i++) out[i] = planckRel(T, i);
  return out;
}
/** Radiance of the solar disc in display units (irradiance at 1 AU = 1, solid angle 6.8e-5 sr). */
export const SUN_DISC_RADIANCE = 1 / 6.8e-5;

/** Environment of a detonation on `body` (BODIES entry): air, gravity, dust colour. */
export function blastEnvironment(body, dustLinear) {
  const air = AIR[body.id] || null;
  const R = body.radius * 1000;
  const g = (body.GM * 1e9) / (R * R);
  return {
    air: !!air,
    rho: air ? air.rho : 0,
    cs: air ? air.cs : 0,
    H: air ? air.H : 0,
    water: air ? air.water : false,
    g,
    dust: air?.dust || dustLinear || [0.35, 0.33, 0.3],
  };
}

/** Height of burst that maximises the 5 psi radius ("optimum airburst"), m. */
export const optimumHOB = (W) => 235 * W ** (1 / 3);

export class Detonation {
  /**
   * @param W yield (kt); @param hob height of burst (m); @param env from blastEnvironment
   * @param opts { water: surface is open water }
   */
  constructor(W, hob, env, opts = {}) {
    this.W = W;
    this.env = env;
    this.water = !!opts.water;
    this.hob = env.air ? hob : 0;
    const air = env.air;
    const dens = air ? (RHO0 / env.rho) ** (1 / 3) : 1;
    // the fireball touches the ground below ~ its own radius: a surface burst (hemisphere, crater)
    this.Rfb0 = 66 * W ** 0.4 * dens;
    this.surface = this.hob < this.Rfb0 * 0.9;
    this.Rfb = this.Rfb0 * (this.surface ? 1.26 : 1);
    this.t2 = 0.0417 * W ** 0.44;
    // thermal power: second maximum Pmax, pulse shape normalised so ~35 % of the yield is heat
    this.Pmax = (0.35 * W * KT) / (3.0 * this.t2);
    // cloud (heights scaled with the atmosphere's scale height and density)
    const hs = air ? Math.min(2.5, Math.max(0.5, (env.H / 8500) ** 0.8 * (RHO0 / env.rho) ** 0.08)) : 1;
    this.top = logInterp(CLOUD_TOP, W) * 1000 * hs;
    this.base = logInterp(CLOUD_BASE, W) * 1000 * hs;
    this.capR = logInterp(CLOUD_R, W) * 1000 * hs;
    this.tauR = 60 * (W / 1000) ** 0.1 * Math.sqrt(hs);
    // wind: a gentle drift that grows with height (bends the stem over the minutes)
    const a = (opts.seed ?? Math.random()) * Math.PI * 2;
    const wv = air ? 6 + 10 * ((opts.seed2 ?? Math.random())) : 0;
    this.wind = [Math.cos(a) * wv, Math.sin(a) * wv];
    // blast wave
    this.Eblast = 0.5 * W * KT * (this.surface ? 2 : 1);
    if (air) {
      // switch from Sedov-Taylor to a decaying sound wave where the front slows to Mach 1.5
      const k = 1.03 * (this.Eblast / env.rho) ** 0.2;
      // R = k t^0.4, v = 0.4 R / t = 1.5 cs  ->  t* = (0.4 k / 1.5 cs)^(1/0.6)
      this.tStar = ((0.4 * k) / (1.5 * env.cs)) ** (1 / 0.6);
      this.RStar = k * this.tStar ** 0.4;
      this.kSedov = k;
    }
    // crater (dry soil / regolith) and ejecta
    this.Rc = this.surface ? 30 * W ** 0.3 : 0;
    if (!air) {
      this.vmin = 0.5 * Math.sqrt(env.g * Math.max(this.Rc, 1));
      this.vmax = 25 * this.vmin;
    }
    this.effects = this._effects();
    this.lifetime = air ? Math.max(3600, 12 * this.tauR) : Math.max(120, 1.5 * Math.SQRT2 * this.vmax / env.g);
  }

  /** Damage radii (m) for the info panel. Blast radii scale as W^1/3 (air: optimum height). */
  _effects() {
    const c = this.W ** (1 / 3);
    const s = this.surface ? 0.75 : 1;
    const air = this.env.air;
    const dens = air ? (RHO0 / this.env.rho) ** (1 / 3) : 0;
    return {
      fireball: this.Rfb,
      crater: this.Rc,
      psi20: air ? 280 * c * s * dens : 0,
      psi5: air ? 590 * c * s * dens : 0,
      psi1: air ? 1550 * c * s * dens : 0,
      thermal: air ? 670 * this.W ** 0.41 * (this.surface ? 0.8 : 1) : 0,
      cloudTop: air ? this.top : 0,
      cloudR: air ? this.capR : 0,
    };
  }

  /** Radius of the blast front (m) at time t (s). */
  shockRadius(t) {
    if (!this.env.air || t <= 0) return 0;
    if (t < this.tStar) return this.kSedov * t ** 0.4;
    const cs = this.env.cs;
    return this.RStar + cs * (t - this.tStar) + 0.5 * cs * this.tStar * Math.log(t / this.tStar);
  }

  /** Time (s) at which the blast front reaches distance d (m). */
  shockArrival(d) {
    if (!this.env.air) return Infinity;
    let lo = 0, hi = 1;
    while (this.shockRadius(hi) < d) hi *= 2;
    for (let i = 0; i < 40; i++) { const m = 0.5 * (lo + hi); if (this.shockRadius(m) < d) lo = m; else hi = m; }
    return hi;
  }

  /** Peak overpressure at distance d (psi), from the scaled distance (approximate fit). */
  overpressure(d) {
    const Z = d / (this.W ** (1 / 3) * (this.surface ? 1.26 : 1)); // m / kt^1/3
    return Z < 590 ? 20 * (280 / Z) ** 1.86 : 5 * (590 / Z) ** 1.66;
  }

  /** Thermal power (W) radiated at time t. */
  thermalPower(t) {
    if (t <= 0) return 0;
    const tau = t / this.t2;
    // first pulse (shock-heated air, milliseconds), the breakaway minimum, the second maximum
    const first = 3 * Math.exp(-tau / 0.012) * Math.min(1, tau / 0.001);
    const second = (2 * tau * tau) / (1 + tau ** 3.6);
    return this.Pmax * (first + second);
  }

  /** Radius of the luminous fireball (m). */
  fireballRadius(t) {
    if (t <= 0) return 0;
    const x = t / this.t2;
    if (!this.env.air) return this.Rfb * 2.2 * (1 - Math.exp(-x * 1.5)) + 1;
    return x < 1 ? this.Rfb * Math.max(x ** 0.4, 0.02) : this.Rfb * (1 + 0.08 * Math.log(x));
  }

  /**
   * State at time t (s) after detonation: everything the renderer needs.
   * Lengths in m, local frame: z up from ground zero.
   */
  state(t, out = {}) {
    const air = this.env.air;
    out.t = t;
    const Rf = this.fireballRadius(t);
    out.fireR = Rf;
    // effective temperature of the fireball surface (and later of the hot core of the cloud)
    let P = this.thermalPower(t);
    if (!air) P = this.Pmax * 3 * Math.exp(-t / (this.t2 * 1.5)) / 1.5; // vapour plume
    const T = Math.min(14000, (P / (4 * Math.PI * Rf * Rf * SIGMA + 1e-9)) ** 0.25);
    out.T = T;
    out.P = P;
    out.shockR = this.shockRadius(t);
    if (!air) {
      // vapour plume: a short-lived glowing hemisphere at the crater; ballistic ejecta curtain
      out.headZ = 0; out.a = 0; out.b = Rf; out.k = 0.9; out.coreT = T;
      out.stemR = 0; out.stemTop = 0; out.stemDens = 0;
      out.ringR = 0; out.ringH = 0; out.ringDens = 0; out.wilson = 0;
      out.capDens = 0; out.condense = 0;
      out.fireDens = Math.exp(-t / (this.t2 * 6));
      const g = this.env.g, s2 = Math.SQRT1_2;
      out.ejR0 = this.Rc * 0.6;
      out.ejDrop = 0.5 * g * t * t;
      out.ejLo = Math.max(this.vmin * t * s2, out.ejDrop);
      out.ejHi = this.vmax * t * s2;
      out.ejNorm = Math.max(this.vmin * t * s2, 1);
      out.ejDens = this.Rc > 0 && out.ejHi > out.ejLo ? smooth(0, this.t2 * 2, t) : 0;
      out.landed = Math.min(out.ejDrop, out.ejHi);
      out.top = Math.max(out.ejHi - out.ejDrop, Rf * 1.2);
      out.extent = out.ejHi + out.ejR0 + Rf;
      out.windX = 0; out.windY = 0;
      return out;
    }
    out.ejDens = 0; out.landed = 0;
    const tauR = this.tauR;
    const x = t / tauR;
    // the head: fireball -> buoyant vortex ring -> stabilised cap that keeps spreading
    const z0 = this.surface ? Rf * 0.35 : this.hob;
    const hh = 0.5 * (this.top - this.base);
    const zc = Math.max(0.5 * (this.top + this.base), z0 + hh);
    const rB = this.surface ? 1.15 : 1;
    const headZ = z0 + (zc - z0) * rise(x * 1.15) * (t > this.t2 ? 1 : (t / this.t2) ** 2);
    const spread = rise(x * 0.8) * (1 + 0.18 * Math.log1p(t / (10 * tauR)));
    const rh = Math.max(Rf, Rf + (this.capR * rB - Rf) * spread);
    const m = smooth(this.t2 * 2, tauR * 0.7, t);
    const a = 0.5 * rh * m;
    const b = rh - a;
    const kF = Math.min(1, hh / (0.5 * this.capR));
    out.headZ = headZ; out.a = a; out.b = b; out.k = 1 + (kF - 1) * m;
    // the surface of a surface burst's fireball sits on the ground: squash it into a dome early
    if (this.surface && t < this.t2 * 3) out.k = Math.min(out.k, 0.85);
    out.capDens = 1;
    out.fireDens = 1;
    // hot core: cools as the pulse fades; NO2 browns the cloud, then water condenses (white)
    // the core of the cloud cools more slowly than the radiating surface: it glows orange-red
    // inside the rising cloud for about a minute (1 Mt)
    out.coreT = Math.max(T, t > this.t2 ? 6000 * (t / this.t2) ** -0.33 : 0);
    out.condense = this.env.water ? smooth(tauR * 0.25, tauR * 2.0, t) : 0;
    // stem: dust and debris sucked up by the afterwinds
    const capBottom = headZ - b * out.k * 0.55;
    const dustDelay = this.surface ? this.t2 : this.hob / this.env.cs;
    if (this.surface) {
      out.stemDens = smooth(this.t2, this.t2 * 6, t);
      out.stemTop = capBottom;
    } else {
      const strength = 0.85 * Math.exp(-this.hob / (4 * this.Rfb));
      out.stemDens = strength * smooth(dustDelay, dustDelay + tauR * 0.3, t);
      const join = Math.min(1, Math.max(0, (t - dustDelay) / (tauR * 1.6)));
      out.stemTop = Math.min(capBottom, capBottom * join ** 0.7 + 50);
    }
    out.stemR = Math.max(0.17 * rh * (0.5 + 0.5 * m), Rf * 0.25);
    // dust raised by the blast wave along the ground, rolling outwards with the front
    const Rs = out.shockR;
    const dustMax = this.effects.psi5 * (this.surface ? 1.1 : 0.85);
    const dustStart = this.surface ? 0 : this.hob / this.env.cs;
    out.ringR = Math.min(Rs, dustMax) * (1 + 0.15 * Math.log1p(Math.max(0, t - dustStart) / (tauR * 4)));
    out.ringH = (0.05 * out.ringR + 30) * (1 + t / (tauR * 1.5));
    out.ringDens = (this.surface ? 1 : 0.55 * Math.exp(-this.hob / (6 * this.Rfb))) * smooth(dustStart, dustStart + this.t2 * 4, t) * Math.exp(-t / (tauR * 8 + 300));
    // Wilson condensation cloud: a short-lived shell behind the front in humid air
    const xs = Rs / this.Rfb;
    out.wilson = this.env.water ? 0.8 * smooth(1.3, 2.2, xs) * (1 - smooth(3.0, 6.5, xs)) : 0;
    out.burstZ = this.surface ? 0 : this.hob;
    // the whole cloud fades as it disperses (after ~an hour)
    const fade = 1 - smooth(this.lifetime * 0.45, this.lifetime, t);
    out.capDens *= fade; out.stemDens *= fade * (1 - smooth(tauR * 10, tauR * 30, t) * 0.7); out.ringDens *= fade;
    out.windX = this.wind[0]; out.windY = this.wind[1];
    out.top = headZ + b * out.k * 1.1 + 200;
    out.extent = Math.max(rh * 1.25 + Math.hypot(...this.wind) * t, out.ringR + out.ringH * 2, Rs * (out.wilson > 0 ? 1.1 : 0));
    return out;
  }
}
