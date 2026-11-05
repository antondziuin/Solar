// Off-main-thread fetch + decode + conversion of image assets (body DEMs and maps, Earth
// terrain tiles), so that streaming data never blocks a frame.

async function bitmap(url, opts = {}) {
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const blob = await r.blob();
  return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none', ...opts });
}

function pixels(bmp, w = bmp.width, h = bmp.height, flip = false) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  if (flip) { g.translate(0, h); g.scale(1, -1); }
  g.drawImage(bmp, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

const jobs = {
  /** body elevation model: RG float (height m, coverage) + range */
  async dem({ url, scale }) {
    const bmp = await bitmap(url);
    const W = bmp.width, H = bmp.height;
    const px = pixels(bmp);
    bmp.close();
    const a = new Float32Array(W * H * 2);
    let min = Infinity, max = -Infinity;
    const k = scale || 1;
    for (let i = 0; i < W * H; i++) {
      const valid = px[i * 4 + 2] > 127 ? 1 : 0;
      const h = valid ? (px[i * 4] * 256 + px[i * 4 + 1] - 32768) * k : 0;
      a[i * 2] = h;
      a[i * 2 + 1] = valid;
      if (valid) { if (h < min) min = h; if (h > max) max = h; }
    }
    return [{ data: a, W, H, min, max }, [a.buffer]];
  },

  /** surface colour map: RGBA8 rows bottom-up (texture v = 0 first) + photometric stats */
  async map({ url }) {
    const bmp = await bitmap(url);
    const W = bmp.width, H = bmp.height;
    const data = new Uint8Array(pixels(bmp, W, H, true).buffer);
    const d = pixels(bmp, 256, 128);
    bmp.close();
    let s = 0, n = 0, sat = 0;
    const all = [];
    for (let i = 0; i < d.length; i += 4) {
      sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      const r = lin(d[i]), g = lin(d[i + 1]), b = lin(d[i + 2]);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (l > 0.0006) { s += l; n++; all.push(Math.max(r, g, b)); }
    }
    all.sort((x, y) => x - y);
    const p99 = all.length ? all[Math.floor(all.length * 0.99)] : 1;
    const gray = sat / (d.length / 4) < 1.5;
    return [{ data, W, H, mean: n ? s / n : 0.5, p99, gray }, [data.buffer]];
  },

  /** Earth base elevation (Terrarium-style 16-bit in RG) */
  async elev16({ url }) {
    const bmp = await bitmap(url);
    const W = bmp.width, H = bmp.height;
    const px = pixels(bmp);
    bmp.close();
    const a = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) a[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768;
    return [{ data: a, W, H }, [a.buffer]];
  },

  /** 256 x 256 Terrarium terrain tile */
  async tile({ url }) {
    const bmp = await bitmap(url);
    const px = pixels(bmp, 256, 256);
    bmp.close();
    const a = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) a[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    return [{ data: a }, [a.buffer]];
  },
};

self.onmessage = async (e) => {
  const { id, type, args } = e.data;
  try {
    const [result, transfer] = await jobs[type](args);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
