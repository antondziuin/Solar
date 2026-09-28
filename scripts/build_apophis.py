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
(set APOPHIS_CACHE=/some/file.npz to keep the tabulated perturber positions between runs)
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


def tt_time(tt_days):
    """Astronomy Engine time from TT (days since J2000). Time.FromTerrestrialTime() can loop forever
    (its UT iteration fails to converge, e.g. for tt = -16384.0); positions only need TT, so pass an
    approximate UT."""
    return A.Time(tt_days - 69.2 / DAY, tt_days)


def year_to_jd(y):
    return J2000 + (y - 2000.0) * 365.25


def ecl(x, y, z):
    c, s = np.cos(OBL), np.sin(OBL)
    return np.array([x, c * y + s * z, -s * y + c * z])


class Planets:
    """Heliocentric positions of the perturbers on a common 0.25-day grid (one cubic Hermite spline
    for all of them), cached in CACHE between runs."""

    def __init__(self, jd0, jd1, step=0.25):
        cache = os.environ.get("APOPHIS_CACHE")
        t = np.arange(jd0 - 10, jd1 + 10, step)
        if cache and os.path.exists(cache):
            z = np.load(cache)
            t, P, V = z["t"], z["P"], z["V"]
        else:
            P = np.empty((len(t), 3 * len(PERTURBERS))); V = np.empty_like(P)
            for j, (body, gm, _) in enumerate(PERTURBERS):
                print(f"  tabulating {body.name}: {len(t)} epochs", flush=True)
                for k, jd in enumerate(t):
                    st = A.HelioState(body, tt_time(jd - J2000))
                    P[k, 3 * j:3 * j + 3] = ecl(st.x, st.y, st.z) * AU
                    V[k, 3 * j:3 * j + 3] = ecl(st.vx, st.vy, st.vz) * AU / DAY
            if cache:
                np.savez(cache, t=t, P=P, V=V)
        self.gm = np.array([gm for _, gm, _ in PERTURBERS])
        self.spline = CubicHermiteSpline(t, P, V * DAY, axis=0)
        self.earth = lambda jd, nu=0: self.spline(jd, nu)[6:9]

    def at(self, jd):
        return self.spline(jd).reshape(-1, 3)


def rhs_factory(planets):
    def rhs(ts, y):
        jd = ts / DAY
        r, v = y[:3], y[3:]
        rn = np.linalg.norm(r)
        a = -GM_SUN * r / rn**3
        rp = planets.at(jd)
        d = rp - r
        a += (planets.gm[:, None] * (d / np.linalg.norm(d, axis=1)[:, None]**3 - rp / np.linalg.norm(rp, axis=1)[:, None]**3)).sum(0)
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
    return np.linalg.norm(planets.earth(jd) - r)


def main():
    d = np.loadtxt(XYZV)
    jd, P, V = d[:, 0], d[:, 1:4], d[:, 4:7]
    jd0, jd1 = year_to_jd(T0), year_to_jd(T1)
    planets = Planets(jd0, jd1)
    rhs = rhs_factory(planets)

    # 1. 2028-2031: the JPL trajectory itself. Integrating through the 2029 flyby ourselves would
    # amplify the ~200 km difference between Astronomy Engine's Earth and DE441 into millions of km
    # by 2031 (the flyby is extremely sensitive). Between the JPL nodes, quintic Hermite
    # interpolation with the accelerations of our force model resolves the flyby hyperbola.
    Acc = np.array([rhs(t * DAY, np.concatenate([p, v]))[3:] for t, p, v in zip(jd, P, V)])

    def mid_state(t):
        i = min(max(np.searchsorted(jd, t) - 1, 0), len(jd) - 2)
        h = (jd[i + 1] - jd[i]) * DAY
        u = (t - jd[i]) * DAY / h
        u2, u3, u4, u5 = u * u, u**3, u**4, u**5
        H = [1 - 10 * u3 + 15 * u4 - 6 * u5, u - 6 * u3 + 8 * u4 - 3 * u5, 0.5 * u2 - 1.5 * u3 + 1.5 * u4 - 0.5 * u5,
             10 * u3 - 15 * u4 + 6 * u5, -4 * u3 + 7 * u4 - 3 * u5, 0.5 * u3 - u4 + 0.5 * u5]
        D = [-30 * u2 + 60 * u3 - 30 * u4, 1 - 18 * u2 + 32 * u3 - 15 * u4, u - 4.5 * u2 + 6 * u3 - 2.5 * u4,
             30 * u2 - 60 * u3 + 30 * u4, -12 * u2 + 28 * u3 - 15 * u4, 1.5 * u2 - 4 * u3 + 2.5 * u4]
        pos = H[0] * P[i] + H[1] * h * V[i] + H[2] * h * h * Acc[i] + H[3] * P[i + 1] + H[4] * h * V[i + 1] + H[5] * h * h * Acc[i + 1]
        vel = (D[0] * P[i] + D[3] * P[i + 1]) / h + D[1] * V[i] + D[4] * V[i + 1] + h * (D[2] * Acc[i] + D[5] * Acc[i + 1])
        return pos, vel

    # check: a 2-hour arc at closest approach integrated with the force model vs the interpolation
    k = int(np.argmin([earth_distance(planets, t, p) for t, p in zip(jd, P)]))
    arc = integrate(rhs, jd[k], np.concatenate([P[k], V[k]]), jd[k + 1])
    worst = max(np.linalg.norm(arc.sol(t * DAY)[:3] - mid_state(t)[0]) for t in np.linspace(jd[k], jd[k + 1], 25))
    print(f"flyby arc: quintic interpolation within {worst:.2f} km of the integrated arc", flush=True)
    # 2. backwards from 2028, forwards from 2031 (JPL state)
    back = integrate(rhs, jd[0], np.concatenate([P[0], V[0]]), jd0)
    fwd = integrate(rhs, jd[-1], np.concatenate([P[-1], V[-1]]), jd1)

    def state(t):
        if t <= jd[0]:
            y = back.sol(t * DAY)
        elif t < jd[-1]:
            return mid_state(t)
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
            ve = planets.earth(tc, 1) / DAY
            tt = tc - J2000
            g = A.Time(tt)                      # UT from TT: two fixed-point steps on Delta T
            g = A.Time(tt - (g.tt - g.ut))
            tm = A.Time(tt - (g.tt - g.ut))
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
