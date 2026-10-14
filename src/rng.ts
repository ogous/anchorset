import { sha256Hex } from './identity.ts';

/** A PRNG returning floats in [0, 1). */
export type Rng = () => number;

function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be an integer in [0, 2^32 - 1], got ${seed}`);
  }
}

/** mulberry32: the one seeded PRNG in this library. */
export function mulberry32(seed: number): Rng {
  assertSeed(seed);
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives a uint32 seed from a string: the first 4 bytes (big-endian) of its sha256. Refuses what sha256Hex refuses. */
export function seedFromString(s: string): number {
  return Number.parseInt(sha256Hex(s).slice(0, 8), 16);
}

/** Integer in [0, n). */
export function randomInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Fisher–Yates shuffle; returns a new array and never mutates the input. */
export function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const out = arr.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
