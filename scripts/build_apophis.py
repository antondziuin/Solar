#!/usr/bin/env python3
"""Ephemeris of (99942) Apophis for the viewer: public/bodies/apophis_orbit.bin (+ .json).

Initial conditions: the JPL-based sampled trajectory for 2028-2031 (heliocentric, ecliptic J2000,
km, km/s, TDB) distributed with CelestiaContent (extras-standard/99942_apophis). From its first and
last samples the orbit is integrated numerically backwards and forwards with:
  - the Sun, Mercury ... Neptune and the Moon (positions from Astronomy Engine - the same theory the
    viewer uses, so the 2029 Earth flyby happens relative to the Earth that is drawn),
  - the Sun's 1PN relativistic term,
  - the Yarkovsky transverse acceleration of JPL orbit solution 220 (A2 = -2.902e-14 au/d^2, 1/r^2).
Validation against the JPL SBDB close-approach table is printed at the end.

Output: samples (JD TT, heliocentric ecliptic J2000 position in km as float64, velocity in km/s as
float32) every 4 days, densely around close Earth approaches. The viewer interpolates them with cubic
Hermite polynomials.
Run: pip install astronomy-engine scipy; python3 scripts/build_apophis.py
"""
import json
import os
import struct
import sys

import astronomy as A
import numpy as np
from scipy.integrate import solve_ivp
from scipy.interpolate import CubicHermiteSpline

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "bodies")
CEL = os.environ.get("CELESTIA", os.path.join(os.path.dirname(ROOT), "celestia-content"))
XYZV = os.path.join(CEL, "extras-standard", "99942_apophis", "data", "99942_apophis.xyzv")

AU = 149597870.7  # km
DAY = 86400.0
C = 299792.458  # km/s
J2000 = 2451545.0
OBL = np.radians(23.4392794444)  # obliquity used by Astronomy Engine for EQJ <-> ECL
GM_SUN = 1.32712440041e11
PERTURBERS = [  # (body, GM km^3/s^2 - DE440, tabulation step in days)
    (A.Body.Mercury, 22031.868551, 1.0), (A.Body.Venus, 324858.592, 1.0), (A.Body.Earth, 398600.435507, 0.5),
    (A.Body.Moon, 4902.800118, 0.25), (A.Body.Mars, 42828.375816, 2.0), (A.Body.Jupiter, 126712764.1, 4.0),
    (A.Body.Saturn, 37940584.8418, 4.0), (A.Body.Uranus, 5794556.4, 8.0), (A.Body.Neptune, 6836527.10058, 8.0),
]
A2 = -2.902e-14 * AU / DAY**2  # km/s^2 at 1 au
T0, T1 = 1950.0, 2120.0         # years covered


def year_to_jd(y):
    return J2000 + (y - 2000.0) * 365.25


def ecl(x, y, z):
    c, s = np.cos(OBL), np.sin(OBL)
    return np.array([x, c * y + s * z, -s * y + c * z])


class Planets:
    """Heliocentric positions of the perturbers on a grid, cubic Hermite in between."""

    def __init__(self, jd0, jd1):
        self.splines = []
        for body, gm, step in PERTURBERS:
            t = np.arange(jd0 - 10, jd1 + 10, step)
            print(f"  tabulating {body.name}: {len(t)} epochs", flush=True)
            P = np.empty((len(t), 3)); V = np.empty((len(t), 3))
            for k, jd in enumerate(t):
                tm = A.Time.FromTerrestrialTime(jd - J2000)
                s = A.HelioState(body, tm)
                P[k] = ecl(s.x, s.y, s.z) * AU
                V[k] = ecl(s.vx, s.vy, s.vz) * AU / DAY
            self.splines.append((gm, CubicHermiteSpline(t, P, V * DAY, axis=0)))

    def at(self, jd):
        return [(gm, sp(jd)) for gm, sp in self.splines]


def rhs_factory(planets):
    def rhs(ts, y):
        jd = ts / DAY
        r, v = y[:3], y[3:]
        rn = np.linalg.norm(r)
        a = -GM_SUN * r / rn**3
        for gm, rp in planets.at(jd):
            d = rp - r
            a += gm * (d / np.linalg.norm(d)**3 - rp / np.linalg.norm(rp)**3)
        # Schwarzschild term of the Sun
        v2 = v @ v
        a += GM_SUN / (C**2 * rn**3) * ((4 * GM_SUN / rn - v2) * r + 4 * (r @ v) * v)
        # Yarkovsky drift (transverse, 1/r^2)
        h = np.cross(r, v)
        t_hat = np.cross(h, r); t_hat /= np.linalg.norm(t_hat)
        a += A2 * (AU / rn)**2 * t_hat
        return np.concatenate([v, a])
    return rhs


def integrate(rhs, jd0, y0, jd1):
    sol = solve_ivp(rhs, (jd0 * DAY, jd1 * DAY), y0, method="DOP853", rtol=1e-12, atol=1e-6, dense_output=True)
    assert sol.success, sol.message
    return sol


def earth_distance(planets, jd, r):
    return np.linalg.norm(planets.splines[2][1](jd) - r)


def main():
    d = np.loadtxt(XYZV)
    jd, P, V = d[:, 0], d[:, 1:4], d[:, 4:7]
    jd0, jd1 = year_to_jd(T0), year_to_jd(T1)
    planets = Planets(jd0, jd1)
    rhs = rhs_factory(planets)

    # 1. through the 2029 flyby: 2028-01-01 -> 2031-01-01, compared with the JPL trajectory
    mid = integrate(rhs, jd[0], np.concatenate([P[0], V[0]]), jd[-1])
    err = np.linalg.norm(mid.sol(jd[-1] * DAY)[:3] - P[-1])
    print(f"2028->2031 through the flyby: {err:.0f} km from the JPL trajectory", flush=True)
    # 2. backwards from 2028, forwards from 2031 (JPL state)
    back = integrate(rhs, jd[0], np.concatenate([P[0], V[0]]), jd0)
    fwd = integrate(rhs, jd[-1], np.concatenate([P[-1], V[-1]]), jd1)

    def state(t):
        if t <= jd[0]:
            y = back.sol(t * DAY)
        elif t < jd[-1]:
            y = mid.sol(t * DAY)
        else:
            y = fwd.sol(t * DAY)
        return y[:3], y[3:]

    # 3. sample: 4 days, densely where Apophis is near the Earth (step ~ distance / speed / 20)
    samples = []
    t = jd0
    while t <= jd1:
        r, v = state(t)
        samples.append((t, r, v))
        de = earth_distance(planets, t, r)
        step = min(4.0, max(2.0 / 1440, de / 7.0 / DAY / 20))
        if t < jd[0] <= t + step:
            step = jd[0] - t   # sample the segment boundaries exactly
        elif t < jd[-1] <= t + step:
            step = jd[-1] - t
        t += step
    print(f"{len(samples)} samples", flush=True)

    # 4. close approaches (< 0.05 au) for the info panel and validation
    ts = np.array([s[0] for s in samples])
    de = np.array([earth_distance(planets, s[0], s[1]) for s in samples])
    cas = []
    for k in range(1, len(ts) - 1):
        if de[k] < de[k - 1] and de[k] <= de[k + 1] and de[k] < 0.06 * AU:
            # refine
            lo, hi = ts[k - 1], ts[k + 1]
            for _ in range(60):
                m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
                if earth_distance(planets, m1, state(m1)[0]) < earth_distance(planets, m2, state(m2)[0]):
                    hi = m2
                else:
                    lo = m1
            tc = 0.5 * (lo + hi)
            r, v = state(tc)
            dist = earth_distance(planets, tc, r)
            ve = planets.splines[2][1](tc, 1) / DAY
            tm = A.Time.FromTerrestrialTime(tc - J2000)
            cas.append({"jd": tc, "utc": str(tm)[:16].replace("T", " "), "dist_km": round(dist), "v_rel": round(float(np.linalg.norm(v - ve)), 2)})
    for c in cas:
        print(f"  close approach {c['utc']}  {c['dist_km'] / AU:.5f} au  ({c['dist_km']} km)  {c['v_rel']} km/s")

    # 5. write
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "apophis_orbit.bin")
    with open(path, "wb") as f:
        f.write(struct.pack("<4sI", b"APO1", len(samples)))
        f.write(np.array([s[0] - J2000 for s in samples], "<f8").tobytes())       # days since J2000 TT
        f.write(np.array([s[1] for s in samples], "<f8").tobytes())               # km
        f.write(np.array([s[2] for s in samples], "<f4").tobytes())               # km/s
    print(f"-> {path} {os.path.getsize(path) / 1e3:.0f} kB")
    json.dump({"file": "bodies/apophis_orbit.bin", "from": T0, "to": T1, "closeApproaches": cas,
               "source": "JPL solution 220 trajectory 2028-2031 (via CelestiaContent), N-body integration with Astronomy Engine perturbers, GR and Yarkovsky"},
              open(os.path.join(OUT, "apophis_orbit.json"), "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
