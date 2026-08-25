/**
 * Just enough PNG decoding to check that a screenshot actually rendered.
 *
 * The visual harness had no way to tell a good capture from a broken one, so a
 * software-rasteriser failure that left most of the viewport at pure black got
 * reported as four successful screenshots and was read as a bug in the scene.
 * A capture that is 60% #000000 is not evidence of anything, and the harness
 * should say so rather than write the file and exit zero.
 *
 * Handles the 8-bit RGB/RGBA non-interlaced output that `Page.captureScreenshot`
 * produces, and nothing else, on purpose.
 */
import { inflateSync } from 'node:zlib';

export function decode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[src++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(row, 0, src, src + stride);
    src += stride;
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          row[x] = (row[x] + a) & 255;
          break;
        case 2:
          row[x] = (row[x] + b) & 255;
          break;
        case 3:
          row[x] = (row[x] + ((a + b) >> 1)) & 255;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default:
          throw new Error(`unknown filter ${filter}`);
      }
    }
  }
  return { w, h, ch, data: out };
}

/**
 * Fraction of the image that is exactly #000000.
 *
 * Exactly zero is the tell. The night palette is dark but the sky, the fog and
 * the ambient term all keep real pixels off the floor, so a run of true zeros
 * means those pixels were never written rather than shaded dark. Sampled on a
 * grid because a full scan of a 1600x900 frame is wasted work for a threshold
 * test, and dropped tiles are hundreds of pixels across.
 */
export function blackFraction(img, step = 4) {
  let black = 0;
  let total = 0;
  for (let y = 0; y < img.h; y += step) {
    for (let x = 0; x < img.w; x += step) {
      const i = y * img.w * img.ch + x * img.ch;
      total++;
      if (img.data[i] === 0 && img.data[i + 1] === 0 && img.data[i + 2] === 0) black++;
    }
  }
  return black / total;
}
