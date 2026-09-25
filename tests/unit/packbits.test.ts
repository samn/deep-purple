import { describe, expect, it } from "vitest";
import { packBits, unpackBits } from "../../src/lib/packbits.ts";

function roundTrip(src: Uint8Array): Uint8Array {
  const packed = packBits(src);
  const out = new Uint8Array(src.length);
  unpackBits(packed, out);
  expect(out).toEqual(src);
  return packed;
}

/** Deterministic pseudo-random bytes (no repeats to speak of). */
function noise(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe("PackBits", () => {
  it("round-trips edge cases", () => {
    roundTrip(new Uint8Array(0));
    roundTrip(Uint8Array.of(7));
    roundTrip(Uint8Array.of(7, 7));
    roundTrip(Uint8Array.of(1, 2));
    roundTrip(Uint8Array.of(1, 2, 2, 3, 3, 3, 4));
    // Runs and literals right at and past their length limits.
    for (const n of [127, 128, 129, 130, 257, 258, 1000]) {
      roundTrip(new Uint8Array(n).fill(5));
      roundTrip(noise(n, n));
    }
  });

  it("round-trips a frame-like field", () => {
    // Mostly zero, with a smooth blob and a noisy patch, like rain over CONUS.
    const nx = 1799;
    const ny = 50;
    const f = new Uint8Array(nx * ny);
    for (let r = 0; r < ny; r++) {
      for (let c = 600; c < 900; c++) f[r * nx + c] = 1 + Math.floor((c - 600) / 12);
    }
    f.set(noise(3000, 9), 20 * nx + 1200);
    const packed = roundTrip(f);
    expect(packed.length).toBeLessThan(f.length * 0.1);
  });

  it("costs at most one control byte per 128 on incompressible data", () => {
    const src = noise(128 * 100);
    expect(roundTrip(src).length).toBeLessThanOrEqual(src.length + 101);
    // Pairs scattered through the noise mustn't break literals up.
    for (let i = 0; i < src.length - 1; i += 7) src[i + 1] = src[i]!;
    expect(roundTrip(src).length).toBeLessThanOrEqual(src.length + 101);
  });

  it("rejects data that doesn't decode to the expected length", () => {
    const packed = packBits(new Uint8Array(100).fill(3));
    expect(() => unpackBits(packed, new Uint8Array(99))).toThrow(RangeError);
    expect(() => unpackBits(packed, new Uint8Array(101))).toThrow(RangeError);
    expect(() => unpackBits(Uint8Array.of(4, 1, 2), new Uint8Array(5))).toThrow(RangeError);
  });
});
