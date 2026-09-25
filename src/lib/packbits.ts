/**
 * PackBits run-length coding for quantized frames. Frames are overwhelmingly
 * byte 0 (no rain, no smoke) with smooth runs elsewhere, so this shrinks a
 * 1.9 MB frame to a few percent of that, and decoding is a handful of
 * `fill`/`set` calls — about a millisecond per frame, cheap enough to run
 * synchronously when a frame is about to be drawn.
 *
 * Format: a control byte c < 128 is followed by c + 1 literal bytes; c >= 128
 * is followed by one byte repeated c - 126 times (2..129).
 */

const MAX_LITERAL = 128;
const MAX_RUN = 129;

/**
 * Worst-case output buffer, kept between calls: frames are all the same size,
 * and only the exact-length copy returned needs a fresh allocation.
 */
let scratch = new Uint8Array(0);

export function packBits(src: Uint8Array): Uint8Array<ArrayBuffer> {
  // Every literal but the first either hits the length cap or follows a run
  // of 3+ (which saved at least a byte), so the worst case adds one control
  // byte per 128, plus one.
  const bound = src.length + Math.ceil(src.length / MAX_LITERAL) + 1;
  if (scratch.length < bound) scratch = new Uint8Array(bound);
  const out = scratch;
  const n = src.length;
  let o = 0;
  let i = 0;
  while (i < n) {
    const v = src[i]!;
    let run = 1;
    while (i + run < n && run < MAX_RUN && src[i + run] === v) run++;
    if (run >= 2) {
      out[o++] = run + 126;
      out[o++] = v;
      i += run;
      continue;
    }
    // Literal span, up to the next run of 3+. A pair costs the same inside a
    // literal as out of it, but breaking out would cost a control byte.
    const start = i;
    let len = 0;
    while (i < n && len < MAX_LITERAL && !(i + 2 < n && src[i + 1] === src[i] && src[i + 2] === src[i])) {
      i++;
      len++;
    }
    out[o++] = len - 1;
    out.set(src.subarray(start, start + len), o);
    o += len;
  }
  return out.slice(0, o);
}

/** Decode into `dst`, which must be exactly the original length. */
export function unpackBits(src: Uint8Array, dst: Uint8Array): void {
  const n = src.length;
  let i = 0;
  let o = 0;
  while (i < n) {
    const c = src[i++]!;
    if (c < MAX_LITERAL) {
      const len = c + 1;
      if (i + len > n || o + len > dst.length) throw new RangeError("PackBits literal overruns its buffer");
      dst.set(src.subarray(i, i + len), o);
      i += len;
      o += len;
    } else {
      const run = c - 126;
      if (i >= n || o + run > dst.length) throw new RangeError("PackBits run overruns its buffer");
      dst.fill(src[i++]!, o, o + run);
      o += run;
    }
  }
  if (o !== dst.length) throw new RangeError(`PackBits decoded ${o} bytes, expected ${dst.length}`);
}
