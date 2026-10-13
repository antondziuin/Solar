# Solar

A physically based, infinitely detailed Solar System viewer for the web browser (WebGL 2, three.js).

Everything is at true scale and in its true place for any date: fly from a view of the whole
Solar System down to a boulder on the Moon, stand in an Alpine valley under a blue sky, skim
Saturn's rings until individual ring particles appear, or watch Io's shadow cross Jupiter.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (deployable anywhere, e.g. GitHub Pages)
```

## What "physically right" means here

**Positions and time**
- Sun, planets, Pluto and the Moon: [Astronomy Engine](https://github.com/cosinekitty/astronomy)
  (VSOP87 / truncated ELP / TOP2013), accurate to about an arcminute over millennia.
- Galilean moons: E. Lieske's L1.2 theory (via Astronomy Engine).
- All other moons: JPL mean orbital elements (epoch J2000, local Laplace planes) with the
  node and periapsis precessing at the rate set by the parent's J2 oblateness.
- Pluto and Charon orbit their common barycentre, which lies outside Pluto.
- The near-Earth asteroid (99942) Apophis follows a numerically integrated orbit (1950–2120):
  JPL solution 220 for 2028–2031, including the 13 April 2029 flyby 38 000 km from the Earth,
  extended backwards and forwards with the Sun, the planets and the Moon, general relativity and
  the measured Yarkovsky drift. The integration reproduces JPL's close approaches (1990, 1998,
  2051, 2102) to a few minutes and ~0.0001 AU. Its info card shows the osculating orbit (it turns
  from an Aten into an Apollo asteroid in 2029), its brightness as seen from Earth and the coming
  close approaches, with a button to watch the 2029 flyby.
- The simulation clock runs in real time by default and can go from −1 year/s to +1 year/s.

**Size, shape and orientation**
- True radii, including oblate giants (Saturn is 10 % flatter at the poles) and triaxial
  small moons (Phobos, Deimos, Amalthea, Hyperion, Proteus).
- IAU WGCCRE rotation models (pole, prime meridian, retrograde spins, Uranus on its side);
  tidally locked moons keep the same face towards their planet, Hyperion tumbles, and Apophis
  tumbles in its measured non-principal-axis spin state (264 h spin, 27.4 h precession).

**Light**
- A single point of truth for light: the Sun's irradiance falls off as 1/r², with auto
  exposure keyed to the body you are looking at (adjustable in *Settings*).
- Eclipses: every body receives penumbral shadows from its parent and sibling moons, from the
  exact overlap of the solar disc (solar eclipses on Earth, Io's shadow on Jupiter). In the
  Earth's umbra the Moon is lit only by sunlight refracted through the Earth's atmosphere:
  ~10^-4 of full sunlight, deep red at the centre, orange towards the edge with the turquoise
  ozone fringe. The eyes adapt (up to ~9 stops) to an eclipsed Moon or to a landscape under
  totality. The Earth's and the Moon's info cards list the next solar and lunar eclipses
  (Astronomy Engine) with a button to watch them.
- Cast shadows of the relief on the body you are at, at every scale: three cascaded shadow
  maps rendered from the Sun with the terrain's own vertex shader (mountains, crater walls,
  large boulders - including casters off screen), plus a short ray march towards the Sun
  through the finer fragment-level octaves (crater rims, small boulders). Penumbrae follow the
  Sun's angular size and the distance to the occluder. *Settings → Relief shadows* toggles them.
- Planetshine (earthshine on the Moon's night side).
- Airless bodies use a Lommel–Seeliger/Lambert regolith BRDF with an opposition surge;
  gas giants use Minnaert limb darkening; the Sun has wavelength-dependent limb darkening.
- Rayleigh + Mie + absorbing-layer (ozone, methane, haze) single scattering with a
  multiple-scattering estimate, for Earth, Mars, Venus, Titan, Triton, Pluto and the giants:
  blue skies, red sunsets, aerial perspective, Mars' butterscotch sky, Titan's orange haze.
- Saturn's rings: radial optical-depth profile of the D, C, B, A, F and G rings with the
  Cassini Division, Encke and Keeler gaps; lit and unlit faces behave differently; the planet
  shadows the rings and the rings shadow the planet. Uranus' dark rings, Jupiter's and
  Neptune's faint rings are included.
- Sky: 41 000 real stars (to magnitude 8) with colours from their B–V index, the Milky Way
  from isophote maps, optional constellation lines.

## Nuclear test

Press the trefoil button (or `X`), pick a yield (from the 20 t Davy Crockett to the 50 Mt Tsar
Bomba) and an airburst or a surface burst, then click the surface of a planet or moon. Ground zero
is the point drawn under the cursor (read from the depth buffer, so real elevation included).
The explosion follows the empirical scaling laws of Glasstone & Dolan, *The Effects of Nuclear
Weapons* (1977), with the damage radii cross-checked against NUKEMAP:

- **Flash and fireball.** The first pulse, the breakaway minimum and the second thermal maximum
  (t ≈ 0.042 s·W^0.44, W in kt) carry ~35 % of the yield as heat. The fireball (max radius
  ≈ 66 m·W^0.4) glows as the black body of its effective temperature from the Stefan–Boltzmann
  law: blue-white, then yellow, orange and a dull red core that lingers inside the cloud. It is a
  real light source: it lights the ground, the clouds and, through Rayleigh and Mie scattering,
  the air around it, and the eyes adapt to it (the scene goes dark for a moment, then recovers).
- **Blast wave.** A Sedov–Taylor point explosion turning into a sound wave; in humid air a Wilson
  condensation shell flashes behind the front, and it raises a rolling wall of dust along the
  ground (a white base surge over water). When it reaches the camera the view shakes and, at
  real-time speed, you hear the crack and the rumble with the right delay.
- **Mushroom cloud.** The hot gas rises as a buoyant vortex ring (the toroidal circulation rolls
  the cloud) and stabilises after ~10 minutes at the heights measured in the atmospheric tests
  (22 km for 1 Mt, 64 km for 50 Mt); the stem of dust and debris is drawn up by the afterwinds,
  the cloud is browned by nitrogen dioxide at first and whitened by condensing water later, the
  wind bends it, and it spreads and disperses over the following hour. It is ray-marched as a
  volume lit by the Sun (with self-shadowing and the sunlight that is left at its height, so a
  cloud top can still be lit after sunset), by the sky and by its own hot core, with the aerial
  perspective of the atmosphere in front of it.
- **On the ground** the thermal pulse chars the land within the third-degree-burn radius and sets
  fires that glow at night for hours; the heat clears the cloud deck above ground zero.
- **Other worlds.** Mars and Titan get clouds of their own dust in their own air. On airless
  bodies (the Moon, Mercury, the icy moons) there is no fireball cloud and no blast wave: a
  short-lived glowing vapour plume, a crater and a ballistic ejecta curtain — an inverted cone
  that rises and falls back in the body's gravity for minutes, laying down a bright, rayed
  ejecta blanket.

The clock is set to real time when you detonate; speed it up to watch the cloud stabilise.

## What "infinitely detailed" means here

Surfaces are not limited by texture resolution. Each body is a cube-sphere quadtree whose
chunks are generated entirely on the GPU:

- **Camera-relative precision.** Every chunk is anchored relative to the camera in double
  precision on the CPU. Noise is evaluated on a lattice with period 289, so the CPU can pass
  `(camera · 2^k / λ₀) mod 289` for every octave *k* and the GPU only adds small, exact offsets.
  32-bit floats therefore stay exact at any zoom — the terrain keeps adding octaves down to
  centimetres (and the quadtree keeps splitting to ~15 cm chunks).
- **Octaves follow the viewer.** Geometry receives the octaves the mesh can resolve; the
  fragment shader adds the remaining octaves down to the pixel footprint as analytic normals.
- **Self-similar craters.** Airless bodies get a crater field at every scale (bowls, rims,
  central peaks and flat floors above the simple-to-complex transition that scales with gravity,
  plus bright fresh ejecta), so the Moon looks like the Moon from orbit and from a rover.
- **Real elevation for the Earth.** The shape of the Earth's land and sea floor is real:
  a global 4096 × 2048 elevation map (~10 km) ships with the app, and around the camera a
  clipmap of eight nested windows (3.5 km down to ~27 m per texel) is streamed at runtime
  from the [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM, GMTED2010,
  ETOPO1, GEBCO, NED, …). The Terrarium tiles contain bedrock under the ice sheets, so the
  Antarctic and Greenland ice surface is restored from NASA's shaded-relief map (calibrated
  against Vostok, Dome A, the South Pole and Summit Camp to within ~3 %). The fractal only
  adds detail *below* the resolution of the data actually in use at each point, so Mont Blanc
  and Everest are where they should be, and the coastline turns fractal only below ~30 m.
  Streaming falls back to the built-in map when offline.
- **Real imagery.** NASA Blue Marble Next Generation land colour (8192 × 4096, ~5 km, cloud-free)
  and city lights. Coastlines and lakes come from Natural Earth 1:10m vectors baked into a signed
  distance field (smooth shores at any zoom, no texel steps); lakes lie flat at their real surface
  level (Great Lakes, Caspian −28 m, Titicaca, …) even where the elevation data carry lake-floor
  bathymetry. Below the map's resolution the shoreline turns fractal; near the camera the
  fine elevation data draw it. Shallow-water colour follows a smooth (B-spline) depth field.
- **Live weather.** Earth's clouds are computed on the GPU as a time-dependent map, following
  curl-noise flow (Bridson et al. 2007) as used for global cloud cover in J. Wedekind's
  [sfsim](https://github.com/wedesoft/sfsim): the wind is divergence-free — zonal jets (trades,
  westerlies up to ~25 m/s), evolving eddies and tracked cyclones — and each point traces its
  air back 12 hours to read an ever-changing cloud pattern, so clouds drift, stretch and wind
  up into swirls and filaments. Clouds gather where the air is humid and cyclonic; around the
  systems, broken cloud forms a thin, calm veil continuing their edges. The season sets a gentle
  climate (ITCZ clusters, dry subtropics and deserts, storm tracks, marine stratocumulus,
  afternoon cumulus over land). Small cumulus fields renew within hours, large systems over days;
  extratropical and, in season, tropical cyclones (dense core, spiral bands, eye) follow
  deterministic tracks, so any date always shows the same weather. Keyframes every 30 minutes
  of simulated time are blended; the ground gets the clouds' shadows.
- **Real shapes and surfaces of other worlds.** Global elevation models from spacecraft
  altimetry and stereo are baked from the USGS Astrogeology archive and loaded when a body
  first appears: the Moon (Kaguya LALT / LRO LOLA), Mars (MGS MOLA), Mercury (MESSENGER),
  Pluto and Charon (New Horizons, encounter hemispheres), Enceladus (Cassini shape model) and
  Phobos, whose real, lumpy shape comes from the Mars Express HRSC model. The irregular moons
  Amalthea, Proteus (Stooke, Voyager/Galileo), Hyperion (Thomas et al., Cassini) and Deimos
  (Ernst et al. 2023) use real plate shape models, ray-cast into radius maps; Amalthea also
  gets its Galileo map through the model's own texture coordinates. Apophis uses its radar shape
  model (Goldstone/Arecibo 2012–2013) and is covered with self-similar boulders like a rubble pile. Global maps from
  Clementine, MESSENGER, Galileo, Voyager, Cassini, New Horizons and Viking give the Moon,
  Mercury, Mars, Phobos, the Galilean moons, Jupiter, Saturn, its icy moons, Titan,
  the Uranian moons, Triton, Pluto and Charon their real appearance, scaled to each body's
  measured albedo; single-band mosaics (e.g. Europa's Galileo/Voyager mosaic) are coloured with
  the body's measured colours. Other moons use their IAU triaxial shapes. Where data are missing (e.g. the
  hemispheres Voyager and New Horizons never saw), the procedural surface takes over. The Moon
  uses a lunar albedo map for its maria. Named landmarks are modelled geometrically:
  Olympus Mons and the Tharsis volcanoes, Valles Marineris, Hellas, the Martian dichotomy,
  South Pole–Aitken, Imbrium, Orientale, Tycho, Copernicus, Caloris, Herschel on Mimas,
  Odysseus and Ithaca Chasma on Tethys, Valhalla on Callisto, Iapetus' two-tone surface and
  equatorial ridge, Enceladus' tiger stripes, Pluto's heart and more.
- Gas giant cloud decks, the Sun's granulation, Earth's clouds and Saturn's ringlets use the
  same scheme, so they too keep revealing structure as you zoom.

## Controls

| Input | Action |
|---|---|
| Drag | Orbit / move over the surface (speed: *Settings → Mouse speed*) |
| Right-drag, Shift-drag | Look around (tilt up to the horizon) |
| Wheel, pinch, `+` `−` | Zoom (altitude above the terrain) |
| Double-click, label, list | Fly to a body |
| Arrows · `W A S D` | Move · look |
| `Space` · `[` `]` · `N` | Pause · time rate · jump to now |
| `B` · `H` | Body list · help |
| `X`, then click a surface | Nuclear test (detonate under the cursor) |

Focus Apophis and press *Watch the 13 April 2029 flyby* in its info card to see it pass the Earth.

Near a surface the camera co-rotates with the body, so you stay above the same place.
You can link to a body with a hash, e.g. `…/#saturn`.

## Project layout

```
src/core/       ephemeris, time, camera controller, terrain model (CPU mirror of the GPU height function)
src/data/       physical, orbital and surface parameters of every body
src/render/     quadtree renderer, shaders (terrain, atmosphere, rings), sky, orbits, point markers
src/ui/         panels, labels, time controls
scripts/        asset preprocessing (star catalogue, Milky Way map, textures)
public/         runtime assets produced by scripts/build_assets.py
```

## Data sources and licences

- Star catalogue, Milky Way outlines, constellation lines: [d3-celestial](https://github.com/ofrohn/d3-celestial) (BSD-3-Clause), derived from the HYG database.
- Earth elevation: [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (Mapzen/Tilezen
  Terrarium) — contains SRTM, GMTED2010 and NED (USGS), ETOPO1 (NOAA), GEBCO, and other sources;
  see the [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
  The bundled base map is rebuilt with `python3 scripts/build_earth_dem.py`.
- Earth imagery (NASA Blue Marble / Black Marble, topography, clouds): NASA
  Visible Earth (public domain), as packaged in [three-globe](https://github.com/vasturiano/three-globe) (MIT).
  The day map is rebuilt from the NASA Blue Marble Next Generation tile pyramid (Modest Maps, on
  Amazon S3) with `python3 scripts/build_earth_day.py`.
- Coastlines and lakes: [Natural Earth](https://www.naturalearthdata.com/) 1:10m (public domain);
  rebuild with `python3 scripts/build_earth_coast.py` (needs `rasterio`, SciPy).
- Planetary elevation models and mosaics: [USGS Astrogeology Science Center](https://astrogeology.usgs.gov/)
  map products (public domain, from NASA/JAXA/ESA mission data: LRO, Kaguya, MGS, MESSENGER,
  New Horizons, Cassini, Mars Express, Galileo, Voyager, Clementine). Rebuild with
  `python3 scripts/build_body_maps.py` (needs `rasterio`; only the needed scanlines are fetched).
- Shape models of Amalthea and Proteus (P. Stooke, Small Body Shape Models, NASA PDS), Hyperion
  (Thomas, Joseph & Ansty, Saturn Small Moon Shape Models V1.0, NASA PDS, CC0), Deimos
  (Ernst et al. 2023, Earth Planets Space, CC-BY-4.0) and the Amalthea map (ItzImcool, CC-BY-4.0),
  as distributed with [CelestiaContent](https://github.com/CelestiaProject/CelestiaContent).
  Rebuild with `python3 scripts/build_shape_models.py`.
- Apophis: radar shape model (Lawrence & Benner 2026, NASA PDS, CC0; after Brozović et al. 2018),
  spin state (Lee et al. 2022), 2028–2031 trajectory of JPL orbit solution 220 (via CelestiaContent),
  physical data and close approaches from the JPL Small-Body Database. The orbit table is rebuilt
  with `python3 scripts/build_apophis.py` (needs `astronomy-engine`, SciPy).
- Saturn and its moons Mimas (DLR), Enceladus, Tethys, Dione, Rhea and Iapetus: Cassini ISS global
  basemaps from the USGS Astrogeology map server (NASA/JPL/Space Science Institute).
- Global maps of other moons: [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources) (public domain).
- Lunar albedo map (fallback): [CesiumJS](https://github.com/CesiumGS/cesium) (Apache-2.0).
- Ephemerides: [Astronomy Engine](https://github.com/cosinekitty/astronomy) (MIT).
- Orbital elements: JPL Solar System Dynamics, planetary satellite mean elements.

Regenerate `public/` with `python3 scripts/build_assets.py` (needs Pillow, NumPy, SciPy).
