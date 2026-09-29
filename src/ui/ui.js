import * as THREE from 'three';
import { AU, C_LIGHT, KM } from '../core/constants.js';
import { orbitalPeriodDays, osculatingElements } from '../core/ephemeris.js';

const RATES = [-31557600, -2629800, -604800, -86400, -21600, -3600, -600, -60, -1, 1, 60, 600, 3600, 21600, 86400, 604800, 2629800, 31557600];

export function formatRate(r) {
  const a = Math.abs(r);
  const sign = r < 0 ? '−' : '';
  const units = [[31557600, 'yr'], [2629800, 'mo'], [604800, 'wk'], [86400, 'd'], [3600, 'h'], [60, 'min'], [1, 's']];
  for (const [s, u] of units) if (a >= s) return `${sign}${+(a / s).toFixed(a / s < 10 ? 1 : 0)} ${u}/s`;
  return `${sign}${a.toFixed(2)} s/s`;
}

export function formatDistance(m) {
  const a = Math.abs(m);
  if (a < 1) return `${(m * 100).toFixed(0)} cm`;
  if (a < 1000) return `${m.toFixed(a < 10 ? 1 : 0)} m`;
  if (a < 1e7) return `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: a < 1e5 ? 2 : 0 })} km`;
  if (a < 0.05 * AU) return `${(m / 1e9).toFixed(3)} million km`;
  if (a < 2000 * AU) return `${(m / AU).toFixed(a < 10 * AU ? 3 : 2)} AU`;
  return `${(m / 9.4607e15).toFixed(3)} ly`;
}

function sci(x, unit) {
  const e = Math.floor(Math.log10(x));
  const m = x / 10 ** e;
  return `${m.toFixed(3)}×10<sup>${e}</sup> ${unit}`;
}

function formatDuration(days) {
  if (days < 2) return `${(days * 24).toFixed(2)} h`;
  if (days < 800) return `${days.toFixed(2)} d`;
  return `${(days / 365.25).toFixed(2)} yr`;
}

export class UI {
  constructor(app) {
    this.app = app;
    this.$ = (id) => document.getElementById(id);
    this.rateIndex = RATES.indexOf(1);
    this.labels = new Map();
    this._buildBodies();
    this._buildLabels();
    this._bindTime();
    this.$('info').addEventListener('click', (e) => { if (e.target.dataset?.flyby) this.app.apophisFlyby(); });
    this._bindSettings();
    this._lastInfo = 0;
    const info = this.$('info');
    if (window.innerWidth < 720) info.classList.add('collapsed');
    info.addEventListener('click', (e) => { if (!e.target.closest('button')) info.classList.toggle('collapsed'); });
  }

  _dotColor(b) {
    const v = this.app.views[b.id];
    const c = v.meanColor.clone();
    const m = Math.max(c.r, c.g, c.b) || 1;
    c.multiplyScalar(0.9 / m);
    return `#${c.getHexString(THREE.SRGBColorSpace)}`;
  }

  _buildBodies() {
    const nav = this.$('bodies');
    const bodies = this.app.ephem.bodies;
    const top = bodies.filter((b) => b.type === 'star' || b.parent === 'sun');
    for (const p of top) {
      const group = document.createElement('div');
      group.className = 'group';
      const btn = this._bodyButton(p, false);
      group.appendChild(btn);
      const moons = bodies.filter((b) => b.parent === p.id && p.type !== 'star');
      if (moons.length) {
        const wrap = document.createElement('div');
        wrap.hidden = !['earth', 'mars'].includes(p.id);
        const tog = document.createElement('span');
        tog.className = 'toggle';
        tog.textContent = `${moons.length} ${wrap.hidden ? '▸' : '▾'}`;
        tog.addEventListener('click', (e) => {
          e.stopPropagation();
          wrap.hidden = !wrap.hidden;
          tog.textContent = `${moons.length} ${wrap.hidden ? '▸' : '▾'}`;
        });
        btn.appendChild(tog);
        for (const m of moons) wrap.appendChild(this._bodyButton(m, true));
        group.appendChild(wrap);
        group._moons = wrap;
      }
      nav.appendChild(group);
    }
    const toggleList = () => {
      nav.classList.toggle('closed');
      if (!nav.classList.contains('closed') && window.innerWidth < 720) {
        this.$('settings').hidden = true; this.$('help').hidden = true; this._syncPopover?.();
      }
    };
    this.$('btn-bodies').addEventListener('click', toggleList);
    if (window.innerWidth < 720) nav.classList.add('closed');
    window.addEventListener('keydown', (e) => { if (e.key === 'b' && e.target.tagName !== 'INPUT') toggleList(); });
  }

  _bodyButton(b, isMoon) {
    const btn = document.createElement('button');
    btn.className = `body ${isMoon ? 'moon' : ''}`;
    btn.dataset.id = b.id;
    btn.innerHTML = `<span class="dot" style="background:${this._dotColor(b)}"></span><span>${b.name}</span>`;
    btn.addEventListener('click', () => {
      this.app.controller.focusOn(b);
      if (window.innerWidth < 720) this.$('bodies').classList.add('closed');
    });
    return btn;
  }

  setActive(body) {
    document.querySelectorAll('#bodies button.body').forEach((el) => el.classList.toggle('active', el.dataset.id === body.id));
    const parentId = body.type === 'moon' ? body.parent : body.id;
    document.querySelectorAll('#bodies .group').forEach((g) => {
      if (g._moons && g.firstChild.dataset.id === parentId) g._moons.hidden = false;
    });
    for (const [id, el] of this.labels) el.classList.toggle('focus', id === body.id);
    this.$('focus-name').textContent = body.name;
    this._lastInfo = 0;
  }

  _buildLabels() {
    const layer = this.$('labels');
    for (const b of this.app.ephem.bodies) {
      const el = document.createElement('div');
      el.className = `label ${b.type}`;
      el.textContent = b.name;
      el.addEventListener('click', () => this.app.controller.focusOn(b));
      layer.appendChild(el);
      this.labels.set(b.id, el);
    }
    this.showLabels = true;
  }

  updateLabels(camera, views) {
    const w = window.innerWidth, h = window.innerHeight;
    const q = camera.quaternion.clone().invert();
    const proj = camera.projectionMatrix;
    const occluders = views.filter((v) => v.pixelRadius > 3);
    const v4 = new THREE.Vector4();
    const focus = this.app.controller.focus;
    for (const view of views) {
      const b = view.body;
      const el = this.labels.get(b.id);
      let show = this.showLabels;
      const rel = view.relCam;
      const p = rel.clone().applyQuaternion(q);
      if (p.z > 0) show = false;
      // moons: only when their system is resolved on screen
      if (show && b.type === 'moon') {
        const parent = this.app.ephem.byId[b.parent];
        const pv = this.app.views[parent.id];
        const sep = b.state.rel.length() / Math.max(pv.distance, 1) / this.app.pixelAngle / this.app.pixelRatio;
        if (sep < 28 && b.id !== focus?.id) show = false;
      }
      if (show && b.type !== 'star' && view.pixelRadius * 1 / this.app.pixelRatio > h * 0.45) show = false;
      if (show) {
        // hidden behind a nearer, larger body?
        const dir = rel.clone().divideScalar(view.distance);
        for (const o of occluders) {
          if (o === view || o.distance >= view.distance) continue;
          const od = o.relCam.clone().divideScalar(o.distance);
          const ang = Math.acos(Math.min(1, dir.dot(od)));
          if (ang < Math.asin(Math.min(1, o.model.R / o.distance))) { show = false; break; }
        }
      }
      if (!show) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
      v4.set(p.x, p.y, p.z, 1).applyMatrix4(proj);
      const x = (v4.x / v4.w * 0.5 + 0.5) * w;
      const y = (-v4.y / v4.w * 0.5 + 0.5) * h;
      const off = Math.min(view.pixelRadius / this.app.pixelRatio, h) + 4;
      el.style.display = '';
      el.style.transform = `translate(${(x + off * 0.7).toFixed(1)}px, ${(y - off * 0.7 - 8).toFixed(1)}px)`;
    }
  }

  _bindTime() {
    const clock = this.app.clock;
    const setRate = () => {
      clock.rate = RATES[this.rateIndex];
      this.$('rate').textContent = clock.paused ? 'paused' : formatRate(clock.rate);
      this.$('t-play').innerHTML = clock.paused ? '&#x25B6;' : '&#x23F8;';
    };
    this.$('t-slower').addEventListener('click', () => { this.rateIndex = Math.max(0, this.rateIndex - 1); clock.paused = false; setRate(); });
    this.$('t-faster').addEventListener('click', () => { this.rateIndex = Math.min(RATES.length - 1, this.rateIndex + 1); clock.paused = false; setRate(); });
    this.$('t-play').addEventListener('click', () => { clock.paused = !clock.paused; setRate(); });
    this.$('t-now').addEventListener('click', () => { clock.setDate(new Date()); this.rateIndex = RATES.indexOf(1); clock.paused = false; setRate(); });
    this.$('t-set').addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v) return;
      const d = new Date(v + 'Z');
      if (!isNaN(d)) clock.setDate(d);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === ' ') { clock.paused = !clock.paused; setRate(); e.preventDefault(); }
      if (e.key === ']') this.$('t-faster').click();
      if (e.key === '[') this.$('t-slower').click();
      if (e.key === 'n') this.$('t-now').click();
      if (e.key === 'h') { this.$('help').hidden = !this.$('help').hidden; this.$('settings').hidden = true; this._syncPopover?.(); }
    });
    this._setRate = setRate;
    setRate();
  }

  /** Set the time rate (s/s) to the nearest preset and run. */
  setRate(r) {
    let best = 0;
    RATES.forEach((x, i) => { if (Math.abs(Math.log(Math.abs(x)) - Math.log(Math.abs(r))) < Math.abs(Math.log(Math.abs(RATES[best])) - Math.log(Math.abs(r))) && Math.sign(x) === Math.sign(r)) best = i; });
    this.rateIndex = best;
    this.app.clock.paused = false;
    this._setRate();
  }

  _bindSettings() {
    const app = this.app;
    const syncPopover = () => document.body.classList.toggle('popover-open', !this.$('settings').hidden || !this.$('help').hidden);
    this._syncPopover = syncPopover;
    const pop = (btn, id, other) => this.$(btn).addEventListener('click', () => {
      this.$(id).hidden = !this.$(id).hidden;
      this.$(other).hidden = true;
      // on narrow screens the popover and the body list share the space
      if (!this.$(id).hidden && window.innerWidth < 720) this.$('bodies').classList.add('closed');
      syncPopover();
    });
    pop('btn-settings', 'settings', 'help');
    pop('btn-help', 'help', 'settings');
    const chk = (id, fn) => { const el = this.$(id); el.addEventListener('change', () => fn(el.checked)); fn(el.checked); };
    chk('s-orbits', (v) => { app.orbits.visible = v; });
    chk('s-labels', (v) => { this.showLabels = v; });
    chk('s-const', (v) => { if (app.sky.constellations) app.sky.constellations.visible = v; app.settings.constellations = v; });
    chk('s-mw', (v) => { if (app.sky.milkyWay) app.sky.milkyWay.visible = v; app.settings.milkyWay = v; });
    chk('s-shadows', (v) => { if (app.shadows) app.shadows.enabled = v; });
    chk('s-lock', (v) => { app.controller.autoLock = v; if (!v) app.controller._switchFrame(false); });
    const sld = (id, out, fmt, fn) => {
      const el = this.$(id);
      const upd = () => { const v = parseFloat(el.value); this.$(out).textContent = fmt(v); fn(v); };
      el.addEventListener('input', upd); upd();
    };
    sld('s-ev', 'o-ev', (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`, (v) => { app.settings.ev = v; });
    sld('s-amb', 'o-amb', (v) => (v === 0 ? 'off' : v.toFixed(2)), (v) => { app.settings.ambient = v; });
    sld('s-stars', 'o-stars', (v) => v.toFixed(1), (v) => { app.sky.brightness = v; });
    sld('s-bloom', 'o-bloom', (v) => v.toFixed(2), (v) => { if (app.bloom) app.bloom.strength = v; app.settings.bloom = v; });
    const mouse = this.$('s-mouse');
    try { const m = parseFloat(localStorage.getItem('solar.mouse')); if (m > 0) mouse.value = m; } catch { /* storage unavailable */ }
    sld('s-mouse', 'o-mouse', (v) => `${v.toFixed(2)}×`, (v) => {
      app.controller.sensitivity = v;
      try { localStorage.setItem('solar.mouse', String(v)); } catch { /* storage unavailable */ }
    });
    sld('s-lod', 'o-lod', (v) => v.toFixed(1), (v) => app.setDetail(v));
    sld('s-res', 'o-res', (v) => `${Math.round(v * 100)}%`, (v) => app.setResolution(v));
  }

  updateTime() {
    const d = this.app.clock.date();
    const iso = d.toISOString();
    this.$('date').textContent = `${iso.slice(0, 10)}  ${iso.slice(11, 19)} UTC`;
  }

  _typeText(b, parent) {
    if (b.type === 'star') return 'Star';
    if (b.type === 'moon') return `Moon of ${parent.name}`;
    if (b.type === 'dwarf') return 'Dwarf planet';
    if (b.type === 'asteroid') {
      const o = osculatingElements(b, parent);
      const cls = o.a < AU ? (o.Q > 0.983 * AU ? 'Aten' : 'Atira') : o.q < 1.017 * AU ? 'Apollo' : o.q < 1.3 * AU ? 'Amor' : 'main-belt';
      return `Near-Earth asteroid · ${cls}`;
    }
    return 'Planet';
  }

  updateHUD() {
    const c = this.app.controller;
    const b = c.focus;
    if (!b) return;
    const parent = b.parent ? this.app.ephem.byId[b.parent] : null;
    this.$('focus-sub').textContent = this._typeText(b, parent);
    const alt = c.altitude ?? 0;
    const label = b.surface.kind === 'gas' ? 'above cloud tops' : b.type === 'star' ? 'above photosphere' : 'altitude';
    this.$('focus-alt').textContent = `${formatDistance(alt)} ${label}${c.locked ? ' · co-rotating' : ''}`;
  }

  updateInfo(now) {
    if (now - this._lastInfo < 500) return;
    this._lastInfo = now;
    const b = this.app.controller.fly?.body || this.app.controller.focus;
    if (!b) return;
    const eph = this.app.ephem;
    const parent = b.parent ? eph.byId[b.parent] : null;
    // mean (volume-equivalent) radius: given, or from the triaxial shape
    const R = (b.meanRadius || (b.shape ? Math.cbrt(b.shape[0] * b.shape[1] * b.shape[2]) : b.radius)) * KM;
    const g = (b.GM * 1e9) / (R * R);
    const vesc = Math.sqrt((2 * b.GM * 1e9) / R) / 1000;
    const density = b.mass / ((4 / 3) * Math.PI * R ** 3) / 1000;
    const earth = eph.byId.earth;
    const dSun = b.state.pos.length();
    const dEarth = b.id === 'earth' ? 0 : b.state.pos.clone().sub(earth.state.pos).length();
    const rows = [];
    rows.push(['Radius', b.polarRadius ? `${b.radius.toLocaleString()} × ${b.polarRadius.toLocaleString()} km` : b.shape ? `${b.shape.join(' × ')} km` : `${b.radius.toLocaleString()} km`]);
    rows.push(['Mass', sci(b.mass, 'kg')]);
    rows.push(['Mean density', `${density.toFixed(2)} g/cm³`]);
    rows.push(['Surface gravity', g < 0.01 ? `${(g * 1000).toPrecision(2)} mm/s²` : `${g.toFixed(g < 1 ? 3 : 2)} m/s²`]);
    rows.push(['Escape velocity', vesc < 0.1 ? `${(vesc * 1000).toPrecision(2)} m/s` : `${vesc.toFixed(vesc < 1 ? 3 : 2)} km/s`]);
    rows.push(['Rotation', b.info?.rotation || '—']);
    if (parent) rows.push([parent.type === 'star' ? 'Orbital period' : `Period around ${parent.name}`, formatDuration(orbitalPeriodDays(b, parent))]);
    if (b.type !== 'star') rows.push(['Distance to Sun', formatDistance(dSun)]);
    if (b.type === 'moon') rows.push([`Distance to ${parent.name}`, formatDistance(b.state.rel.length())]);
    if (b.id !== 'earth') rows.push(['Distance to Earth', formatDistance(dEarth)]);
    if (b.id !== 'earth') rows.push(['Light time from Earth', formatDuration(dEarth / C_LIGHT / 86400)]);
    rows.push(['Temperature', b.info?.temp || '—']);
    let extra = '';
    if (b.type === 'asteroid') extra = this._asteroidInfo(b, parent, dEarth, rows);
    const typeText = b.type === 'star' ? 'G2V star' : this._typeText(b, parent);
    this.$('info').innerHTML = `<h2>${b.fullName || b.name}</h2><div class="type">${typeText}</div><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>${extra}<p>${b.info?.description || ''}</p>`;
  }

  /** Orbit, photometry and close approaches of an asteroid (adds rows, returns extra HTML). */
  _asteroidInfo(b, parent, dEarth, rows) {
    const o = osculatingElements(b, parent);
    const i = b.info;
    const ld = 384400e3;
    // apparent magnitude (IAU H, G system)
    const r = b.state.pos.length() / AU, d = dEarth / AU;
    const toSun = b.state.pos.clone().negate().normalize();
    const toEarth = this.app.ephem.byId.earth.state.pos.clone().sub(b.state.pos).normalize();
    const alpha = Math.acos(Math.max(-1, Math.min(1, toSun.dot(toEarth))));
    const t = Math.tan(alpha / 2);
    const phi1 = Math.exp(-3.33 * t ** 0.63), phi2 = Math.exp(-1.87 * t ** 1.22);
    const V = i.H + 5 * Math.log10(r * d) - 2.5 * Math.log10((1 - i.G) * phi1 + i.G * phi2);
    rows.splice(rows.findIndex((x) => x[0] === 'Temperature'), 0,
      ['Brightness from Earth', `mag ${V.toFixed(1)} (phase ${(alpha * 180 / Math.PI).toFixed(0)}°)`],
      ['Absolute magnitude H', `${i.H} · albedo ${b.albedo} · ${i.spectral}-type`]);
    const orbit = [
      ['Semi-major axis a', `${(o.a / AU).toFixed(4)} AU`],
      ['Eccentricity e', o.e.toFixed(4)],
      ['Inclination i', `${o.i.toFixed(3)}°`],
      ['Perihelion q · aphelion Q', `${(o.q / AU).toFixed(4)} · ${(o.Q / AU).toFixed(4)} AU`],
      ['Node Ω · perihelion ω', `${o.node.toFixed(2)}° · ${o.peri.toFixed(2)}°`],
      ['Earth MOID (2024)', `${i.moid} AU (${formatDistance(i.moid * AU)})`],
    ];
    let html = `<h3>Osculating orbit (J2000 ecliptic)</h3><table>${orbit.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    const cas = b.ephem.meta?.closeApproaches;
    if (cas) {
      const now = this.app.clock.ut + 2451545;
      const next = cas.filter((c) => c.jd > now - 1).slice(0, 4);
      if (next.length) {
        html += `<h3>Close approaches to Earth</h3><table>${next.map((c) => {
          const dist = c.dist_km * 1000;
          const far = dist > 0.01 * AU ? `${(dist / AU).toFixed(4)} AU` : `${Math.round(c.dist_km).toLocaleString('en-US')} km`;
          return `<tr><td>${c.utc} UTC</td><td>${far} · ${(dist / ld).toFixed(dist < ld ? 2 : 1)} LD · ${c.v_rel} km/s</td></tr>`;
        }).join('')}</table>`;
      }
      if (now < 2462240.4) html += '<button class="flyby" data-flyby="1">Watch the 13 April 2029 flyby ▸</button>';
    }
    return html;
  }
}
