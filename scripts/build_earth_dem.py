#!/usr/bin/env python3
"""Bake a global equirectangular elevation map of the Earth from the AWS Open Data
"Terrain Tiles" (Mapzen/Tilezen Terrarium: SRTM, GMTED2010, ETOPO1, GEBCO and others).

The Terrarium tiles contain *bedrock* under the Antarctic and Greenland ice sheets. The ice
surface is restored from the NASA shaded-relief map shipped with three-globe, whose grey level
is proportional to ice-surface elevation (surface ~= 6400 m x value; checked against Vostok,
Dome A, Dome C, South Pole, Summit Camp, Byrd, Siple, Law Dome to within ~3 %).

Output: public/textures/earth_dem.png  (4096 x 2048, RGB8, value = R*256 + G - 32768 metres,
        rows run from +90 (top) to -90 (bottom), columns from -180 to +180).

Run:  python3 scripts/build_earth_dem.py   (needs Pillow, numpy; downloads ~100 MB)
"""
import io
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "terrarium")
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
Z = 5
W, H = 4096, 2048


def fetch(z, x, y):
    path = os.path.join(CACHE, str(z), str(x), f"{y}.png")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        for attempt in range(4):
            try:
                data = urllib.request.urlopen(URL.format(z=z, x=x, y=y), timeout=60).read()
                break
            except Exception:
                if attempt == 3:
                    raise
        with open(path, "wb") as f:
            f.write(data)
    a = np.asarray(Image.open(path).convert("RGB"), np.float32)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def fix_ice_and_poles(out):
    img = os.path.join(ROOT, "node_modules", "three-globe", "example", "img")
    rs = lambda im: np.asarray(im.resize((W, H), Image.BILINEAR), np.float32) / 255
    bump = rs(Image.open(os.path.join(img, "earth-topology.png")).convert("L"))
    water = rs(Image.open(os.path.join(img, "earth-water.png")).convert("L"))
    day = rs(Image.open(os.path.join(img, "earth-blue-marble.jpg")).convert("RGB"))
    lat = (90 - (np.arange(H) + 0.5) / H * 180)[:, None] * np.ones((1, W))
    lon = (-180 + (np.arange(W) + 0.5) / W * 360)[None, :] * np.ones((H, 1))
    lum = day.mean(-1)
    sat = day.max(-1) - day.min(-1)
    white = (lum > 0.5) & (sat < 0.18)
    greenland = (lat > 59.5) & (lon > -74) & (lon < -11) & ~((lat < 67.5) & (lon > -25.5))
    antarctica = lat < -60
    ice = (greenland | antarctica) & (water < 0.5) & (white | antarctica)
    surf = 6400.0 * bump
    out = np.where(ice, np.maximum(out, surf), out)
    # beyond the Mercator limit (|lat| > 85.05): Antarctic plateau from the relief map,
    # Arctic Ocean from the mean of the last covered row
    south = lat < -85.0
    out = np.where(south, 6400.0 * bump, out)
    north_rows = np.where(lat[:, 0] > 85.0)[0]
    if len(north_rows):
        edge = out[north_rows.max() + 1]
        for r in north_rows:
            t = (lat[r, 0] - 85.0) / 5.0
            out[r] = edge * (1 - t) + edge.mean() * t
    return out


def main():
    n = 2 ** Z
    tiles = [(x, y) for x in range(n) for y in range(n)]
    with ThreadPoolExecutor(16) as ex:
        res = list(ex.map(lambda t: fetch(Z, *t), tiles))
    merc = np.zeros((n * 256, n * 256), np.float32)
    for (x, y), a in zip(tiles, res):
        merc[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = a
    print("mosaic", merc.shape, merc.min(), merc.max(), file=sys.stderr)

    # resample Web Mercator -> equirectangular (2x2 supersampling, bilinear)
    N = merc.shape[0]
    out = np.zeros((H, W), np.float64)
    for sy in (0.25, 0.75):
        for sx in (0.25, 0.75):
            lat = 90 - (np.arange(H) + sy) / H * 180
            lon = -180 + (np.arange(W) + sx) / W * 360
            latc = np.clip(lat, -85.05112878, 85.05112878) * np.pi / 180
            my = (1 - np.log(np.tan(latc) + 1 / np.cos(latc)) / np.pi) / 2 * N - 0.5
            mx = (lon + 180) / 360 * N - 0.5
            y0 = np.clip(np.floor(my).astype(int), 0, N - 2)
            fy = np.clip(my - y0, 0, 1)[:, None]
            x0 = np.floor(mx).astype(int)
            fx = (mx - x0)[None, :]
            x0m, x1m = x0 % N, (x0 + 1) % N
            a = merc[y0][:, x0m] * (1 - fx) + merc[y0][:, x1m] * fx
            b = merc[y0 + 1][:, x0m] * (1 - fx) + merc[y0 + 1][:, x1m] * fx
            out += (a * (1 - fy) + b * fy) / 4
    out = fix_ice_and_poles(out)
    v = np.clip(np.round(out) + 32768, 0, 65535).astype(np.uint32)
    rgb = np.stack([(v >> 8) & 255, v & 255, np.zeros_like(v)], -1).astype(np.uint8)
    dst = os.path.join(ROOT, "public", "textures", "earth_dem.png")
    Image.fromarray(rgb, "RGB").save(dst, optimize=True)
    print("wrote", dst, os.path.getsize(dst), "bytes; range", out.min(), out.max(), file=sys.stderr)


if __name__ == "__main__":
    main()
