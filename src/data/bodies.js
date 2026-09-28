// Physical and orbital data for the bodies in the viewer.
//
// Sources: IAU WGCCRE 2015 (radii, rotation, via astronomy-engine), JPL SSD planetary
// physical parameters, JPL "Planetary Satellite Mean Elements" (epoch J2000, Laplace plane),
// Saturn/Uranus/Jupiter/Neptune ring radii from the Planetary Rings Node.
//
// Units: radius in km, GM in km^3/s^2, mass in kg, angles in degrees, `a` in km.
// Colours are sRGB hex and are linearised at load time.
// surface.amp is the RMS-ish relief (m) of the fractal terrain at a 10 km wavelength.

/**
 * Kepler mean elements of a satellite:
 *  a (km), e, i (deg), node (deg), peri = argument of periapsis w (deg), M (mean anomaly at J2000, deg)
 *  Reference plane: `plane` = { ra, dec } pole of the Laplace plane (ICRF) or 'equator' of the parent.
 *  Node and periapsis precess according to the parent's J2 (computed at runtime).
 */

export const BODIES = [
  // ───────────────────────────── Sun ─────────────────────────────
  {
    id: 'sun', name: 'Sun', type: 'star', parent: null,
    radius: 695700, GM: 1.32712440018e11, mass: 1.9885e30,
    ephem: { kind: 'sun' }, rotation: { kind: 'iau', body: 'Sun' },
    surface: { kind: 'sun' },
    info: { rotation: '25.4 d (equator)', temp: '5772 K (photosphere)', description: 'A G2V main-sequence star holding 99.86% of the Solar System’s mass.' },
  },

  // ─────────────────────────── Mercury ───────────────────────────
  {
    id: 'mercury', name: 'Mercury', type: 'planet', parent: 'sun',
    radius: 2439.4, GM: 22031.868551, mass: 3.3011e23, albedo: 0.142,
    ephem: { kind: 'astro', body: 'Mercury' }, rotation: { kind: 'iau', body: 'Mercury' },
    surface: {
      kind: 'rock', amp: 300, hurst: 0.85, ridge: 0.2, crater: 1.0, craterStart: 380e3,
      c0: '#6f6a64', c1: '#a8a39b', albedoNoise: 0.35, seed: 11,
      features: [
        { type: 'basin', lat: 30.5, lon: -170.2, radius: 780, depth: 2.5 }, // Caloris
      ],
    },
    info: { rotation: '58.646 d', temp: '100–700 K', description: 'Smallest planet; a heavily cratered world locked in a 3:2 spin–orbit resonance.' },
  },

  // ──────────────────────────── Venus ────────────────────────────
  {
    id: 'venus', name: 'Venus', type: 'planet', parent: 'sun',
    radius: 6051.8, GM: 324858.592, mass: 4.8675e24, albedo: 0.689,
    renderRadiusOffset: 65, // cloud tops ~65 km above the surface
    ephem: { kind: 'astro', body: 'Venus' }, rotation: { kind: 'iau', body: 'Venus' },
    surface: {
      kind: 'gas', seed: 3, turbulence: 0.35, contrast: 0.12, bandScale: 1.0, windShear: 0.6,
      bands: [[-90, '#d9cfb4'], [-60, '#e1d4b0'], [-30, '#ead9b0'], [0, '#eedcb3'], [30, '#e9d8b0'], [60, '#e0d3b2'], [90, '#d8ceb6']],
    },
    atmosphere: { ms: 0.1, height: 120, rayleigh: [12e-3, 13e-3, 14e-3], rayleighH: 16, mie: 6e-3, mieExt: 7e-3, mieH: 12, g: 0.75, absorb: [0.2e-3, 1.0e-3, 4.5e-3], absorbH: 20 },
    info: { rotation: '−243.02 d (retrograde)', temp: '737 K (surface)', description: 'Shrouded in sulfuric-acid clouds over a 92-bar CO₂ atmosphere; the hottest planetary surface.' },
  },

  // ──────────────────────────── Earth ────────────────────────────
  {
    id: 'earth', name: 'Earth', type: 'planet', parent: 'sun',
    radius: 6378.137, polarRadius: 6356.752, GM: 398600.4418, mass: 5.97217e24, albedo: 0.306,
    ephem: { kind: 'astro', body: 'Earth' }, rotation: { kind: 'iau', body: 'Earth' },
    surface: {
      kind: 'rock', special: 'earth', amp: 650, hurst: 0.75, ridge: 0.55, crater: 0.0,
      c0: '#6b5a44', c1: '#9c8a6c', albedoNoise: 0.2, seed: 1,
    },
    clouds: { altitude: 7, texture: 'earth_clouds' },
    atmosphere: { ms: 0.04,
      height: 100, rayleigh: [5.802e-3, 13.558e-3, 33.1e-3], rayleighH: 8,
      mie: 0.021, mieExt: 0.0233, mieH: 1.2, g: 0.78,
      absorb: [0.650e-3, 1.881e-3, 0.085e-3], absorbCenter: 25, absorbWidth: 15, // ozone
    },
    info: { rotation: '23.934 h', temp: '184–330 K', description: 'The only known world with liquid surface oceans and life.' },
  },
  {
    id: 'moon', name: 'Moon', type: 'moon', parent: 'earth',
    radius: 1737.4, GM: 4902.800066, mass: 7.342e22, albedo: 0.12,
    ephem: { kind: 'astro', body: 'Moon' }, rotation: { kind: 'iau', body: 'Moon' },
    surface: {
      kind: 'rock', special: 'moon', amp: 260, hurst: 0.9, ridge: 0.1, crater: 1.0, craterStart: 400e3,
      c0: '#5a5753', c1: '#a19d95', albedoNoise: 0.18, seed: 7, albedoTexture: 'moon_albedo',
      features: [
        { type: 'basin', lat: -53, lon: -169, radius: 1250, depth: 6.0 }, // South Pole–Aitken
        { type: 'basin', lat: 32.8, lon: -15.6, radius: 580, depth: 3.0 }, // Imbrium
        { type: 'basin', lat: -19.4, lon: -94.7, radius: 460, depth: 3.5, rings: true }, // Orientale
        { type: 'basin', lat: 17.0, lon: 59.1, radius: 280, depth: 2.5 }, // Crisium
        { type: 'basin', lat: 26.0, lon: 17.5, radius: 330, depth: 2.0 }, // Serenitatis
        { type: 'crater', lat: -43.31, lon: -11.36, radius: 42.9, depth: 4.7 }, // Tycho
        { type: 'crater', lat: 9.62, lon: -20.08, radius: 46.5, depth: 3.8 }, // Copernicus
      ],
    },
    info: { rotation: '27.32 d (synchronous)', temp: '100–390 K', description: 'Earth’s only natural satellite, probably formed from a giant impact 4.5 Gyr ago.' },
  },

  // ───────────────────────────── Mars ────────────────────────────
  {
    id: 'mars', name: 'Mars', type: 'planet', parent: 'sun',
    radius: 3396.19, polarRadius: 3376.2, GM: 42828.37362, mass: 6.4171e23, albedo: 0.17, J2: 1.9555e-3,
    ephem: { kind: 'astro', body: 'Mars' }, rotation: { kind: 'iau', body: 'Mars' },
    surface: {
      kind: 'rock', special: 'mars', amp: 380, hurst: 0.85, ridge: 0.35, crater: 0.55, craterStart: 300e3,
      c0: '#6b3620', c1: '#c07a4a', albedoNoise: 0.55, seed: 4,
      polarCap: { lat: 80, color: '#f2efe8' },
      features: [
        { type: 'dome', lat: 1.0, lon: -100, radius: 2500, height: 5.5 }, // Tharsis rise
        { type: 'volcano', lat: 18.65, lon: -133.8, radius: 300, height: 21.9 }, // Olympus Mons
        { type: 'volcano', lat: 11.9, lon: -104.5, radius: 230, height: 14.0 }, // Ascraeus Mons
        { type: 'volcano', lat: 0.8, lon: -112.8, radius: 190, height: 11.0 }, // Pavonis Mons
        { type: 'volcano', lat: -8.35, lon: -120.1, radius: 220, height: 13.0 }, // Arsia Mons
        { type: 'volcano', lat: 24.8, lon: 146.9, radius: 170, height: 10.0 }, // Elysium Mons
        { type: 'basin', lat: -42.4, lon: 70.5, radius: 1150, depth: 7.5 }, // Hellas Planitia
        { type: 'basin', lat: -49.7, lon: -43.0, radius: 450, depth: 4.5 }, // Argyre
        { type: 'basin', lat: 13, lon: 87, radius: 1100, depth: 2.5 }, // Isidis/Utopia lowlands
        { type: 'trough', lat: -8, lon: -95, lat2: -12, lon2: -40, radius: 90, depth: 7.0 }, // Valles Marineris
        { type: 'dichotomy', depth: 3.0 },
      ],
    },
    atmosphere: { ms: 0.06,
      height: 90, rayleigh: [19.918e-3 * 0.12, 13.57e-3 * 0.12, 5.75e-3 * 0.12], rayleighH: 11,
      mie: 0.012, mieExt: 0.016, mieH: 11, g: 0.76, mieColor: [1.0, 0.72, 0.5],
    },
    info: { rotation: '24.623 h', temp: '130–308 K', description: 'A cold desert world with the largest volcano and canyon system in the Solar System.' },
  },
  {
    id: 'phobos', name: 'Phobos', type: 'moon', parent: 'mars',
    radius: 11.08, shape: [13.0, 11.4, 9.1], GM: 7.087e-4, mass: 1.0659e16, albedo: 0.071,
    ephem: { kind: 'kepler', a: 9376, e: 0.0151, i: 1.075, node: 207.784, peri: 150.057, M: 91.059, plane: { ra: 317.671, dec: 52.893 } },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 160, hurst: 0.95, ridge: 0.0, crater: 1.3, craterStart: 6e3, c0: '#3d3834', c1: '#5a524b', albedoNoise: 0.15, seed: 21, lumpy: 0.12,
      features: [{ type: 'crater', lat: 1, lon: -45, radius: 4.5, depth: 1.2 }] }, // Stickney
    info: { rotation: 'synchronous', temp: '~233 K', description: 'Mars’ larger moon, spiralling inward; it will break up within ~50 Myr.' },
  },
  {
    id: 'deimos', name: 'Deimos', type: 'moon', parent: 'mars',
    radius: 6.2, shape: [7.8, 6.0, 5.1], GM: 9.62e-5, mass: 1.4762e15, albedo: 0.068,
    ephem: { kind: 'kepler', a: 23458, e: 0.0002, i: 1.788, node: 24.525, peri: 260.729, M: 325.329, plane: { ra: 316.657, dec: 53.529 } },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 90, hurst: 0.95, ridge: 0.0, crater: 0.8, craterStart: 3e3, c0: '#4a423a', c1: '#6b6158', albedoNoise: 0.15, seed: 22, lumpy: 0.1 },
    info: { rotation: 'synchronous', temp: '~233 K', description: 'Mars’ small outer moon, smoothed by a thick regolith blanket.' },
  },

  // ─────────────────────────── Jupiter ───────────────────────────
  {
    id: 'jupiter', name: 'Jupiter', type: 'planet', parent: 'sun',
    radius: 71492, polarRadius: 66854, GM: 126686534, mass: 1.8982e27, albedo: 0.538, J2: 14.696e-3,
    ephem: { kind: 'astro', body: 'Jupiter' }, rotation: { kind: 'iau', body: 'Jupiter' },
    surface: {
      kind: 'gas', special: 'jupiter', seed: 5, turbulence: 1.0, contrast: 1.0, bandScale: 1.0, windShear: 1.0,
      bands: [
        [-90, '#7d7a70'], [-66, '#8c8577'], [-60, '#a39a88'], [-52, '#9a8a74'], [-45, '#b9ad96'], [-40, '#a38e72'],
        [-35, '#c9bda3'], [-30, '#a8896a'], [-26, '#d8ccb3'], [-20, '#e3d6bc'], [-18, '#b17f5a'], [-12, '#9e6b49'],
        [-8, '#c79e7c'], [-6, '#e8dcc3'], [0, '#ece0c4'], [5, '#e2d0b0'], [7, '#8a7d77'], [9, '#a07252'],
        [14, '#96674a'], [18, '#c8a585'], [20, '#e3d7be'], [24, '#d7c7a8'], [26, '#9f7c5c'], [30, '#b5987a'],
        [32, '#ddd0b6'], [36, '#b39b7c'], [40, '#cabda3'], [45, '#a8977c'], [52, '#b8ab94'], [60, '#9d9485'], [70, '#86817a'], [90, '#78756f'],
      ],
      storms: [
        // longitudes are east-positive in the body frame (System III west longitude negated)
        { lat: -22.3, lon: -55, rx: 8.0, ry: 5.0, color: '#c0643a', strength: 1.0 }, // Great Red Spot (~55 deg W, drifts)
        { lat: -33.5, lon: -150, rx: 2.4, ry: 1.9, color: '#efe8dc', strength: 0.7 }, // Oval BA
        { lat: -41, lon: -250, rx: 1.4, ry: 1.1, color: '#f0eadf', strength: 0.6 },
        { lat: -41, lon: -290, rx: 1.3, ry: 1.0, color: '#f0eadf', strength: 0.6 },
      ],
    },
    atmosphere: { ms: 0.05, height: 1200, rayleigh: [2.0e-3, 4.6e-3, 11e-3], rayleighH: 27, mie: 0.5e-3, mieExt: 0.6e-3, mieH: 27, g: 0.7 },
    rings: {
      color: '#8a7a68', albedo: 0.05, bands: [
        [92000, 122500, 0.002], // halo
        [122500, 129000, 0.02], // main ring
        [129000, 182000, 0.0015], // gossamer
      ],
    },
    info: { rotation: '9.925 h', temp: '165 K (1 bar)', description: 'The largest planet, a gas giant with a storm larger than Earth that has raged for centuries.' },
  },
  {
    id: 'io', name: 'Io', type: 'moon', parent: 'jupiter',
    radius: 1821.6, GM: 5959.916, mass: 8.9319e22, albedo: 0.63,
    ephem: { kind: 'jupiterMoon', index: 0 }, rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'io', amp: 280, hurst: 0.8, ridge: 0.4, crater: 0.0, c0: '#b9a24a', c1: '#efe29a', albedoNoise: 0.7, seed: 31 },
    info: { rotation: 'synchronous', temp: '~110 K', description: 'The most volcanically active body known, heated by tidal flexing.' },
  },
  {
    id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter',
    radius: 1560.8, GM: 3202.739, mass: 4.7998e22, albedo: 0.67,
    ephem: { kind: 'jupiterMoon', index: 1 }, rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'europa', amp: 70, hurst: 0.9, ridge: 0.6, crater: 0.08, craterStart: 30e3, c0: '#9c7b5c', c1: '#e8e2d6', albedoNoise: 0.5, seed: 32 },
    info: { rotation: 'synchronous', temp: '~102 K', description: 'An ice shell over a global salt-water ocean; crossed by reddish lineae.' },
  },
  {
    id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter',
    radius: 2634.1, GM: 9887.834, mass: 1.4819e23, albedo: 0.43,
    ephem: { kind: 'jupiterMoon', index: 2 }, rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'ganymede', amp: 220, hurst: 0.85, ridge: 0.5, crater: 0.6, craterStart: 150e3, c0: '#5c5247', c1: '#b3a998', albedoNoise: 0.8, seed: 33, polarCap: { lat: 55, color: '#d6d4d0', soft: 20 } },
    info: { rotation: 'synchronous', temp: '~110 K', description: 'The largest moon in the Solar System, bigger than Mercury, with its own magnetic field.' },
  },
  {
    id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter',
    radius: 2410.3, GM: 7179.289, mass: 1.0759e23, albedo: 0.22,
    ephem: { kind: 'jupiterMoon', index: 3 }, rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 220, hurst: 0.9, ridge: 0.1, crater: 1.1, craterStart: 300e3, c0: '#3f3a33', c1: '#8c8272', albedoNoise: 0.35, seed: 34,
      features: [{ type: 'basin', lat: 14.7, lon: -56, radius: 1900, depth: 1.2, rings: true }] }, // Valhalla
    info: { rotation: 'synchronous', temp: '~134 K', description: 'The most heavily cratered surface known; ancient and geologically dead.' },
  },
  {
    id: 'amalthea', name: 'Amalthea', type: 'moon', parent: 'jupiter',
    radius: 83.5, shape: [125, 73, 64], GM: 0.138, mass: 2.08e18, albedo: 0.09,
    ephem: { kind: 'kepler', a: 181366, e: 0.0032, i: 0.374, node: 108.946, peri: 155.873, M: 185.194, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 700, hurst: 0.95, ridge: 0.1, crater: 1.0, craterStart: 40e3, c0: '#6b3a26', c1: '#9c5e40', albedoNoise: 0.3, seed: 35, lumpy: 0.15 },
    info: { rotation: 'synchronous', temp: '~120 K', description: 'The reddest object in the Solar System; a rubble pile inside Jupiter’s gossamer ring.' },
  },

  // ─────────────────────────── Saturn ────────────────────────────
  {
    id: 'saturn', name: 'Saturn', type: 'planet', parent: 'sun',
    radius: 60268, polarRadius: 54364, GM: 37931207.7, mass: 5.6834e26, albedo: 0.499, J2: 16.2907e-3,
    ephem: { kind: 'astro', body: 'Saturn' }, rotation: { kind: 'iau', body: 'Saturn' },
    surface: {
      kind: 'gas', special: 'saturn', seed: 6, turbulence: 0.45, contrast: 0.55, bandScale: 1.0, windShear: 0.8,
      bands: [
        [-90, '#8e8a78'], [-75, '#a39a7e'], [-60, '#b8a784'], [-48, '#cdb88f'], [-40, '#c2ab82'], [-30, '#d6c197'],
        [-22, '#cbb285'], [-15, '#dcc79a'], [-8, '#e3cf9f'], [0, '#e8d4a4'], [8, '#e0cb9b'], [15, '#d5bd8d'],
        [22, '#dcc697'], [30, '#cdb68a'], [40, '#d1bd92'], [50, '#bda983'], [62, '#aea086'], [72, '#8f9190'], [78, '#7f8a91'], [90, '#737e86'],
      ],
    },
    atmosphere: { ms: 0.05, height: 1500, rayleigh: [1.5e-3, 3.4e-3, 8e-3], rayleighH: 60, mie: 0.6e-3, mieExt: 0.7e-3, mieH: 60, g: 0.7 },
    rings: {
      color: '#cdbb9b', albedo: 0.5, bands: [
        [66900, 74490, 0.002, '#8a8074'], // D ring
        [74490, 91980, 0.10, '#a0917e'], // C ring
        [91980, 117580, 1.8, '#d9c7a5'], // B ring
        [117580, 122170, 0.12, '#8e8578'], // Cassini Division
        [122170, 133423, 0.55, '#c9b79a'], // A ring (inner)
        [133423, 133745, 0.0, '#000000'], // Encke Gap
        [133745, 136487, 0.45, '#c4b397'], // A ring (outer)
        [136487, 136522, 0.0, '#000000'], // Keeler Gap
        [136522, 136775, 0.35, '#c4b397'],
        [140180 - 25, 140180 + 25, 0.5, '#d4c8b0'], // F ring
        [166000, 175000, 0.0008, '#9a9086'], // G ring
      ],
    },
    info: { rotation: '10.656 h', temp: '134 K (1 bar)', description: 'The ringed jewel of the Solar System; less dense than water.' },
  },
  {
    id: 'mimas', name: 'Mimas', type: 'moon', parent: 'saturn',
    radius: 198.2, GM: 2.503, mass: 3.75e19, albedo: 0.96,
    ephem: { kind: 'kepler', a: 185539, e: 0.0196, i: 1.574, node: 173.027, peri: 332.499, M: 14.848, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 320, hurst: 0.9, ridge: 0.1, crater: 1.2, craterStart: 60e3, c0: '#a9a7a3', c1: '#e3e1dc', albedoNoise: 0.1, seed: 41,
      features: [{ type: 'crater', lat: -1.7, lon: -104, radius: 69.5, depth: 10, peak: true }] }, // Herschel
    info: { rotation: 'synchronous', temp: '~64 K', description: 'Famous for the giant crater Herschel; may hide a young internal ocean.' },
  },
  {
    id: 'enceladus', name: 'Enceladus', type: 'moon', parent: 'saturn',
    radius: 252.1, GM: 7.211, mass: 1.08e20, albedo: 1.38,
    ephem: { kind: 'kepler', a: 238042, e: 0.0047, i: 0.003, node: 342.507, peri: 0.076, M: 199.686, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'enceladus', amp: 160, hurst: 0.85, ridge: 0.6, crater: 0.45, craterStart: 25e3, c0: '#d9dde2', c1: '#fbfcfd', albedoNoise: 0.08, seed: 42 },
    info: { rotation: 'synchronous', temp: '~75 K', description: 'Brightest body in the Solar System; geysers erupt from “tiger stripes” at its south pole.' },
  },
  {
    id: 'tethys', name: 'Tethys', type: 'moon', parent: 'saturn',
    radius: 531.1, GM: 41.21, mass: 6.174e20, albedo: 1.229,
    ephem: { kind: 'kepler', a: 294672, e: 0.0001, i: 1.091, node: 259.842, peri: 45.202, M: 243.367, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 300, hurst: 0.9, ridge: 0.2, crater: 1.0, craterStart: 120e3, c0: '#bdbab4', c1: '#eeebe6', albedoNoise: 0.12, seed: 43,
      features: [{ type: 'basin', lat: 32.3, lon: -128, radius: 225, depth: 5, peak: true }, // Odysseus
        { type: 'trough', lat: 60, lon: 10, lat2: -60, lon2: -40, radius: 50, depth: 3 }] }, // Ithaca Chasma
    info: { rotation: 'synchronous', temp: '~86 K', description: 'An icy moon split by the 2000-km canyon Ithaca Chasma.' },
  },
  {
    id: 'dione', name: 'Dione', type: 'moon', parent: 'saturn',
    radius: 561.4, GM: 73.116, mass: 1.095e21, albedo: 0.998,
    ephem: { kind: 'kepler', a: 377415, e: 0.0022, i: 0.028, node: 290.415, peri: 284.315, M: 322.232, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'dione', amp: 300, hurst: 0.9, ridge: 0.3, crater: 0.9, craterStart: 100e3, c0: '#8f8b85', c1: '#e6e3dd', albedoNoise: 0.3, seed: 44 },
    info: { rotation: 'synchronous', temp: '~87 K', description: 'Its trailing hemisphere is laced with bright ice cliffs (“wispy terrain”).' },
  },
  {
    id: 'rhea', name: 'Rhea', type: 'moon', parent: 'saturn',
    radius: 763.8, GM: 153.94, mass: 2.307e21, albedo: 0.949,
    ephem: { kind: 'kepler', a: 527068, e: 0.0002, i: 0.333, node: 351.042, peri: 241.619, M: 179.781, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'dione', amp: 300, hurst: 0.9, ridge: 0.2, crater: 1.1, craterStart: 150e3, c0: '#8d8983', c1: '#dedbd5', albedoNoise: 0.25, seed: 45 },
    info: { rotation: 'synchronous', temp: '~76 K', description: 'Saturn’s second-largest moon: a dirty snowball saturated with craters.' },
  },
  {
    id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn',
    radius: 2574.73, GM: 8978.14, mass: 1.3452e23, albedo: 0.22,
    ephem: { kind: 'kepler', a: 1221865, e: 0.0288, i: 0.306, node: 28.060, peri: 180.532, M: 163.310, plane: { ra: 36.213, dec: 83.469 } },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'titan', amp: 160, hurst: 0.8, ridge: 0.3, crater: 0.05, craterStart: 60e3, c0: '#4a3a26', c1: '#9d8a64', albedoNoise: 0.9, seed: 46 },
    atmosphere: { ms: 0.1,
      height: 700, rayleigh: [3.0e-3, 5.5e-3, 9e-3], rayleighH: 45,
      mie: 0.05, mieExt: 0.052, mieH: 60, g: 0.6, mieColor: [1.0, 0.6, 0.25],
    },
    info: { rotation: 'synchronous', temp: '94 K', description: 'The only moon with a dense atmosphere; methane rain fills lakes and seas at its poles.' },
  },
  {
    id: 'hyperion', name: 'Hyperion', type: 'moon', parent: 'saturn',
    radius: 135, shape: [180, 133, 103], GM: 0.3727, mass: 5.62e18, albedo: 0.3,
    ephem: { kind: 'kepler', a: 1500933, e: 0.0232, i: 0.615, node: 263.847, peri: 303.178, M: 86.342, plane: { ra: 40.6, dec: 83.5 } },
    rotation: { kind: 'chaotic', period: 13 },
    surface: { kind: 'rock', amp: 900, hurst: 0.95, ridge: 0.0, crater: 1.6, craterStart: 70e3, c0: '#5b4b3b', c1: '#b2a48f', albedoNoise: 0.3, seed: 47, lumpy: 0.12 },
    info: { rotation: 'chaotic', temp: '~93 K', description: 'A porous, sponge-like moon that tumbles chaotically.' },
  },
  {
    id: 'iapetus', name: 'Iapetus', type: 'moon', parent: 'saturn',
    radius: 734.5, GM: 120.5, mass: 1.806e21, albedo: 0.6,
    ephem: { kind: 'kepler', a: 3560854, e: 0.0293, i: 8.298, node: 81.105, peri: 271.606, M: 201.789, plane: { ra: 284.715, dec: 78.707 } },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'iapetus', amp: 380, hurst: 0.9, ridge: 0.2, crater: 1.0, craterStart: 200e3, c0: '#2a2016', c1: '#e8e3d8', albedoNoise: 0.2, seed: 48,
      features: [{ type: 'ridge', height: 13, width: 70 }] }, // equatorial ridge
    info: { rotation: 'synchronous', temp: '~110 K', description: 'Two-toned: a coal-dark leading hemisphere and a snow-bright trailing one, with a 13-km equatorial ridge.' },
  },

  // ─────────────────────────── Uranus ────────────────────────────
  {
    id: 'uranus', name: 'Uranus', type: 'planet', parent: 'sun',
    radius: 25559, polarRadius: 24973, GM: 5793951.3, mass: 8.681e25, albedo: 0.488, J2: 3.5107e-3,
    ephem: { kind: 'astro', body: 'Uranus' }, rotation: { kind: 'iau', body: 'Uranus' },
    surface: {
      kind: 'gas', special: 'uranus', seed: 8, turbulence: 0.15, contrast: 0.12, bandScale: 1.0, windShear: 0.5,
      bands: [[-90, '#b2dde2'], [-60, '#a9d6dd'], [-30, '#a3d1da'], [0, '#9dccd8'], [30, '#a2d2da'], [55, '#b7dfe2'], [65, '#cfe8e8'], [90, '#d8eceb']],
    },
    atmosphere: { ms: 0.06, height: 700, rayleigh: [2.5e-3, 5.9e-3, 13e-3], rayleighH: 40, mie: 0.3e-3, mieExt: 0.35e-3, mieH: 40, g: 0.7, absorb: [0.8e-3, 0.1e-3, 0.05e-3], absorbH: 60 },
    rings: {
      color: '#3a3836', albedo: 0.03, bands: [
        [41837 - 1, 41837 + 1, 0.3], [42234 - 1, 42234 + 1, 0.4], [42571 - 1, 42571 + 1, 0.4],
        [44718 - 5, 44718 + 5, 0.4], [45661 - 5, 45661 + 5, 0.3], [47175 - 1, 47175 + 1, 0.2],
        [47627 - 2, 47627 + 2, 0.8], [48300 - 3, 48300 + 3, 0.4], [50023 - 1, 50023 + 1, 0.1],
        [51149 - 30, 51149 + 30, 1.2], // epsilon ring
        [86000, 103000, 0.00002], // mu ring
      ],
    },
    info: { rotation: '−17.24 h (retrograde)', temp: '76 K (1 bar)', description: 'An ice giant tipped on its side (97.8° obliquity) with faint dark rings.' },
  },
  {
    id: 'miranda', name: 'Miranda', type: 'moon', parent: 'uranus',
    radius: 235.8, GM: 4.4, mass: 6.4e19, albedo: 0.32,
    ephem: { kind: 'kepler', a: 129900, e: 0.0013, i: 4.338, node: 326.438, peri: 68.312, M: 311.330, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'miranda', amp: 550, hurst: 0.9, ridge: 0.7, crater: 0.7, craterStart: 40e3, c0: '#7f7d7a', c1: '#bdbab5', albedoNoise: 0.6, seed: 51,
      features: [{ type: 'trough', lat: -30, lon: 20, lat2: -60, lon2: -80, radius: 20, depth: 10 }] }, // Verona Rupes region
    info: { rotation: 'synchronous', temp: '~60 K', description: 'A patchwork moon with coronae and Verona Rupes, the tallest cliff known (~10 km).' },
  },
  {
    id: 'ariel', name: 'Ariel', type: 'moon', parent: 'uranus',
    radius: 578.9, GM: 83.43, mass: 1.251e21, albedo: 0.53,
    ephem: { kind: 'kepler', a: 190900, e: 0.0012, i: 0.041, node: 22.394, peri: 115.349, M: 39.481, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 320, hurst: 0.85, ridge: 0.6, crater: 0.6, craterStart: 60e3, c0: '#8a8680', c1: '#cfcbc4', albedoNoise: 0.2, seed: 52 },
    info: { rotation: 'synchronous', temp: '~60 K', description: 'The brightest Uranian moon, cut by long fault valleys.' },
  },
  {
    id: 'umbriel', name: 'Umbriel', type: 'moon', parent: 'uranus',
    radius: 584.7, GM: 85.4, mass: 1.275e21, albedo: 0.26,
    ephem: { kind: 'kepler', a: 266000, e: 0.0039, i: 0.128, node: 33.485, peri: 84.709, M: 12.469, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 260, hurst: 0.9, ridge: 0.1, crater: 1.0, craterStart: 100e3, c0: '#3d3b39', c1: '#6e6b67', albedoNoise: 0.1, seed: 53 },
    info: { rotation: 'synchronous', temp: '~75 K', description: 'The darkest of Uranus’ large moons.' },
  },
  {
    id: 'titania', name: 'Titania', type: 'moon', parent: 'uranus',
    radius: 788.4, GM: 228.2, mass: 3.4e21, albedo: 0.35,
    ephem: { kind: 'kepler', a: 436300, e: 0.0011, i: 0.079, node: 99.771, peri: 284.400, M: 24.614, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 320, hurst: 0.88, ridge: 0.5, crater: 0.8, craterStart: 120e3, c0: '#6b6560', c1: '#a8a19a', albedoNoise: 0.2, seed: 54 },
    info: { rotation: 'synchronous', temp: '~70 K', description: 'Uranus’ largest moon, marked by huge canyons such as Messina Chasma.' },
  },
  {
    id: 'oberon', name: 'Oberon', type: 'moon', parent: 'uranus',
    radius: 761.4, GM: 192.4, mass: 3.076e21, albedo: 0.31,
    ephem: { kind: 'kepler', a: 583500, e: 0.0014, i: 0.068, node: 279.771, peri: 104.400, M: 283.088, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 320, hurst: 0.9, ridge: 0.2, crater: 1.0, craterStart: 150e3, c0: '#5e5752', c1: '#9a918a', albedoNoise: 0.25, seed: 55 },
    info: { rotation: 'synchronous', temp: '~75 K', description: 'An old, heavily cratered moon with dark-floored craters.' },
  },

  // ─────────────────────────── Neptune ───────────────────────────
  {
    id: 'neptune', name: 'Neptune', type: 'planet', parent: 'sun',
    radius: 24764, polarRadius: 24341, GM: 6835099.5, mass: 1.02413e26, albedo: 0.442, J2: 3.5294e-3,
    ephem: { kind: 'astro', body: 'Neptune' }, rotation: { kind: 'iau', body: 'Neptune' },
    surface: {
      kind: 'gas', special: 'neptune', seed: 9, turbulence: 0.5, contrast: 0.45, bandScale: 1.0, windShear: 1.0,
      bands: [[-90, '#4b6fb0'], [-70, '#3c63ad'], [-55, '#5b7fbf'], [-45, '#3f66b0'], [-30, '#4a6fb6'], [-20, '#3a5fae'], [0, '#3d62b0'], [20, '#4368b3'], [40, '#4a6fb5'], [60, '#4f73b4'], [90, '#5475b0']],
      storms: [
        { lat: -22, lon: 120, rx: 9, ry: 5, color: '#1f3677', strength: 0.8 }, // dark spot
        { lat: -26, lon: 118, rx: 5, ry: 1.2, color: '#eef3fb', strength: 0.9 }, // companion cloud
      ],
    },
    atmosphere: { ms: 0.06, height: 700, rayleigh: [2.5e-3, 5.9e-3, 13e-3], rayleighH: 40, mie: 0.3e-3, mieExt: 0.35e-3, mieH: 40, g: 0.7, absorb: [1.2e-3, 0.15e-3, 0.05e-3], absorbH: 60 },
    rings: {
      color: '#5a5550', albedo: 0.04, bands: [
        [41000, 43000, 0.0001], [53200 - 50, 53200 + 50, 0.002], [53200, 57200, 0.00005], [62932 - 25, 62932 + 25, 0.01],
      ],
    },
    info: { rotation: '16.11 h', temp: '72 K (1 bar)', description: 'The windiest planet (up to 2100 km/h), coloured deep blue by methane.' },
  },
  {
    id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune',
    radius: 1353.4, GM: 1427.6, mass: 2.139e22, albedo: 0.76,
    ephem: { kind: 'kepler', a: 354759, e: 0.0000, i: 156.865, node: 177.608, peri: 0, M: 358.0, plane: { ra: 299.456, dec: 43.414 } },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'triton', amp: 160, hurst: 0.85, ridge: 0.4, crater: 0.15, craterStart: 30e3, c0: '#9d8c83', c1: '#e8dcd5', albedoNoise: 0.6, seed: 61 },
    atmosphere: { ms: 0.04, height: 60, rayleigh: [0.05e-3, 0.12e-3, 0.28e-3], rayleighH: 14, mie: 0.02e-3, mieExt: 0.025e-3, mieH: 10, g: 0.7 },
    info: { rotation: 'synchronous', temp: '38 K', description: 'A captured Kuiper-belt object on a retrograde orbit, with nitrogen geysers and “cantaloupe” terrain.' },
  },
  {
    id: 'proteus', name: 'Proteus', type: 'moon', parent: 'neptune',
    radius: 210, shape: [220, 208, 202], GM: 3.36, mass: 4.4e19, albedo: 0.096,
    ephem: { kind: 'kepler', a: 117647, e: 0.0005, i: 0.524, node: 162.4, peri: 301.7, M: 320.0, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', amp: 550, hurst: 0.95, ridge: 0.1, crater: 1.1, craterStart: 60e3, c0: '#35322f', c1: '#5c5854', albedoNoise: 0.1, seed: 62, lumpy: 0.06 },
    info: { rotation: 'synchronous', temp: '~51 K', description: 'Nearly as large as a body can be without pulling itself round.' },
  },
  {
    id: 'nereid', name: 'Nereid', type: 'moon', parent: 'neptune',
    radius: 170, GM: 2.06, mass: 3.1e19, albedo: 0.155,
    ephem: { kind: 'kepler', a: 5513818, e: 0.7507, i: 7.090, node: 335.570, peri: 296.8, M: 358.3, plane: { ra: 270.0, dec: 66.56 } },
    rotation: { kind: 'spin', period: 11.5 / 24 },
    surface: { kind: 'rock', amp: 320, hurst: 0.9, ridge: 0.1, crater: 1.0, craterStart: 60e3, c0: '#5a5854', c1: '#8c8984', albedoNoise: 0.1, seed: 63, lumpy: 0.05 },
    info: { rotation: '11.5 h', temp: '~50 K', description: 'Has one of the most eccentric orbits of any moon.' },
  },

  // ───────────────────────────── Pluto ───────────────────────────
  {
    id: 'pluto', name: 'Pluto', type: 'dwarf', parent: 'sun',
    radius: 1188.3, GM: 869.6, mass: 1.303e22, albedo: 0.52,
    ephem: { kind: 'astro', body: 'Pluto', barycentricPartner: 'charon' }, rotation: { kind: 'iau', body: 'Pluto' },
    surface: { kind: 'rock', special: 'pluto', amp: 380, hurst: 0.85, ridge: 0.5, crater: 0.5, craterStart: 80e3, c0: '#6b4a36', c1: '#e3d6c6', albedoNoise: 0.7, seed: 71 },
    atmosphere: { ms: 0.05, height: 250, rayleigh: [0.25e-3, 0.6e-3, 1.4e-3], rayleighH: 40, mie: 0.02e-3, mieExt: 0.03e-3, mieH: 30, g: 0.6 },
    info: { rotation: '−6.387 d (retrograde)', temp: '~44 K', description: 'A dwarf planet with a nitrogen-ice glacier (Sputnik Planitia) forming its “heart”.' },
  },
  {
    id: 'charon', name: 'Charon', type: 'moon', parent: 'pluto',
    radius: 606.0, GM: 105.88, mass: 1.586e21, albedo: 0.38,
    ephem: { kind: 'kepler', a: 19591, e: 0.00005, i: 0.080, node: 223.046, peri: 0, M: 147.8, plane: 'equator' },
    rotation: { kind: 'locked' },
    surface: { kind: 'rock', special: 'charon', amp: 380, hurst: 0.85, ridge: 0.5, crater: 0.6, craterStart: 80e3, c0: '#6d6a67', c1: '#b5b1ac', albedoNoise: 0.3, seed: 72 },
    info: { rotation: 'synchronous (mutually locked)', temp: '~53 K', description: 'So large relative to Pluto that the pair orbit a point in empty space between them.' },
  },
];

export const BODY_BY_ID = Object.fromEntries(BODIES.map((b) => [b.id, b]));
