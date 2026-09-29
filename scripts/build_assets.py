#!/usr/bin/env python3
"""Preprocess third-party data into compact runtime assets under public/.

Sources (installed as devDependencies, see README "Data sources"):
  * d3-celestial  (BSD-3)  : star catalogue to mag 8 (HYG-derived) + Milky Way outlines
  * three-globe   (MIT)    : NASA Blue Marble, Black Marble, topography, water mask, clouds
  * scripts/src/moonSmall.jpg (CesiumJS, Apache-2.0): low-res lunar albedo map

Run:  python3 scripts/build_assets.py   (needs Pillow + numpy + scipy)
"""
import json
import os
import struct

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NM = os.path.join(ROOT, "node_modules")
OUT = os.path.join(ROOT, "public")
os.makedirs(os.path.join(OUT, "data"), exist_ok=True)
os.makedirs(os.path.join(OUT, "textures"), exist_ok=True)


def build_stars():
    src = json.load(open(os.path.join(NM, "d3-celestial/data/stars.8.json")))
    rows = []
    for f in src["features"]:
        ra, dec = f["geometry"]["coordinates"]
        ra = ra % 360.0
        mag = f["properties"]["mag"]
        try:
            bv = float(f["properties"]["bv"])
        except (TypeError, ValueError):
            bv = 0.6
        rows.append((ra, dec, mag, bv))
    rows.sort(key=lambda r: r[2])  # brightest first
    buf = bytearray()
    buf += struct.pack("<I", len(rows))
    for ra, dec, mag, bv in rows:
        buf += struct.pack(
            "<HHhh",
            int(round(ra / 360.0 * 65535)) % 65536,
            int(round((dec + 90.0) / 180.0 * 65535)),
            int(round(mag * 1000)),
            int(round(max(-0.5, min(2.5, bv)) * 1000)),
        )
    open(os.path.join(OUT, "data/stars.bin"), "wb").write(buf)
    print("stars:", len(rows), len(buf), "bytes")


def build_milky_way():
    """Rasterise the 5 nested Milky Way isophotes into an equirectangular
    (RA 0..360 left->right, Dec +90..-90 top->bottom) brightness map.
    Rings are filled with the even-odd rule; rings that wrap all the way
    around in RA (the band edges) are closed through the south pole."""
    W, H = 2048, 1024
    src = json.load(open(os.path.join(NM, "d3-celestial/data/mw.json")))
    acc = np.zeros((H, W), np.float32)
    for feat in src["features"]:
        level = np.zeros((H, W), bool)
        for poly in feat["geometry"]["coordinates"]:
            for ring in poly:
                pts = [(ring[0][0] % 360.0, ring[0][1])]
                for ra, dec in ring[1:]:
                    px = pts[-1][0]
                    ra = ra % 360.0
                    while ra - px > 180:
                        ra -= 360
                    while px - ra > 180:
                        ra += 360
                    pts.append((ra, dec))
                span = pts[-1][0] - pts[0][0]
                if abs(span) > 180:  # wraps around the sky: close via the south pole
                    pts += [(pts[-1][0], -90.0), (pts[0][0], -90.0)]
                layer = Image.new("1", (W, H), 0)
                d = ImageDraw.Draw(layer)
                xy = [(x / 360.0 * W, (90.0 - y) / 180.0 * H) for x, y in pts]
                for off in (-2 * W, -W, 0, W, 2 * W):
                    d.polygon([(x + off, y) for x, y in xy], fill=1)
                level ^= np.asarray(layer, bool)
        acc += level.astype(np.float32)
    acc = gaussian_filter(acc, sigma=2.5, mode="wrap") + 0.6 * gaussian_filter(acc, sigma=14, mode="wrap")
    acc = acc / acc.max()
    img = Image.fromarray((np.clip(acc, 0, 1) ** 0.8 * 255).astype(np.uint8), "L")
    img.save(os.path.join(OUT, "textures/milkyway.png"), optimize=True)
    print("milky way done")


def build_constellations():
    src = json.load(open(os.path.join(NM, "d3-celestial/data/constellations.lines.json")))
    lines = []
    for f in src["features"]:
        for line in f["geometry"]["coordinates"]:
            lines.append([[round(ra % 360.0, 3), round(dec, 3)] for ra, dec in line])
    json.dump(lines, open(os.path.join(OUT, "data/constellations.json"), "w"), separators=(",", ":"))
    print("constellations:", len(lines))


def build_earth():
    img = os.path.join(NM, "three-globe/example/img")
    Image.open(os.path.join(img, "earth-blue-marble.jpg")).convert("RGB").save(
        os.path.join(OUT, "textures/earth_day.jpg"), quality=88)
    # City lights: keep the warm light, drop the blue ocean tint of the source image.
    n = np.asarray(Image.open(os.path.join(img, "earth-night.jpg")).convert("RGB"), np.float32) / 255.0
    lights = np.clip((np.minimum(n[..., 0], n[..., 1]) - 0.10) / 0.45, 0, 1)
    Image.fromarray((lights * 255).astype(np.uint8), "L").save(
        os.path.join(OUT, "textures/earth_lights.jpg"), quality=90)
    # coastlines and lakes: scripts/build_earth_coast.py
    clouds = Image.open(os.path.join(NM, "three-globe/example/clouds/clouds.png")).convert("RGBA")
    a = clouds.getchannel("A")
    a.save(os.path.join(OUT, "textures/earth_clouds.jpg"), quality=85)
    print("earth done")


def build_moon():
    m = np.asarray(Image.open(os.path.join(ROOT, "scripts/src/moonSmall.jpg")).convert("L"), np.float32)
    m = gaussian_filter(m, 0.6, mode="wrap")
    m = (m - m.mean()) / m.std()
    Image.fromarray(np.clip(128 + m * 45, 0, 255).astype(np.uint8), "L").resize(
        (512, 256), Image.BICUBIC).save(os.path.join(OUT, "textures/moon_albedo.png"), optimize=True)
    print("moon done")


if __name__ == "__main__":
    build_stars()
    build_milky_way()
    build_constellations()
    build_earth()
    build_moon()
