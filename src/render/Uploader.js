// Progressive GPU upload of large data textures: a few MB per frame instead of one long
// stall (a 4096 x 2048 RG float DEM is 64 MB). Textures are handed out only once complete.
const BYTES_PER_FRAME = 6 * 1024 * 1024;
const queue = [];
let renderer = null;

export function setUploadRenderer(r) { renderer = r; }

/**
 * Upload `tex` (a THREE.DataTexture whose image.data is filled) over several frames.
 * Resolves with the texture once all rows are on the GPU.
 */
export function uploadProgressive(tex) {
  return new Promise((resolve) => {
    const { width: W, height: H, data } = tex.image;
    const rowBytes = (data.byteLength / H) | 0;
    if (!renderer || data.byteLength <= BYTES_PER_FRAME) {
      // small: upload right away (or lazily on first use when there is no renderer)
      tex.needsUpdate = true;
      if (renderer) renderer.initTexture(tex);
      resolve(tex);
      return;
    }
    queue.push({ tex, W, H, row: 0, rowsPerFrame: Math.max(1, Math.floor(BYTES_PER_FRAME / rowBytes)), resolve });
  });
}

/** Call once per frame. */
export function pumpUploads() {
  const job = queue[0];
  if (!job || !renderer) return;
  const { tex, W, H } = job;
  const end = Math.min(H, job.row + job.rowsPerFrame);
  // three's update ranges are in units of 4 components; express them per row (start = pixel * 4)
  tex.clearUpdateRanges();
  for (let y = job.row; y < end; y++) tex.addUpdateRange(y * W * 4, W * 4);
  const last = end >= H;
  // (mipmaps, if any, are regenerated on the GPU after each slice: cheap next to the upload;
  // toggling generateMipmaps would change three's cache key and reallocate the texture)
  tex.needsUpdate = true;
  renderer.initTexture(tex);
  job.row = end;
  if (last) {
    queue.shift();
    tex.clearUpdateRanges();
    job.resolve(tex);
  }
}

export const isUploading = () => queue.length > 0;
