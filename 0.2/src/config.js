/**
 * Solace 0.2 — build-time constants shared by the loader, the tests and the UI.
 */

/** Name announced in UCI (`id name Solace 0.2`). */
export const ENGINE_NAME = 'Solace 0.2';

/**
 * The NNUE network Stockfish 19 evaluates with. It is not stored in this
 * repository (98 MB); `node scripts/fetch-net.mjs` downloads and verifies it.
 */
export const NET_NAME = 'nn-1a298aa575a0.nnue';
export const NET_SIZE = 98511183;
export const NET_SHA256 = '1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2';

/**
 * A one-function module that uses a relaxed-SIMD instruction
 * (`i8x16.relaxed_swizzle`). Browsers without relaxed SIMD refuse to validate
 * it, which is exactly the check the loader needs: the relaxed build is faster,
 * the plain SIMD build runs everywhere.
 */
export function hasRelaxedSimd() {
  try {
    const lanes = new Uint8Array(16);
    const body = [0x00, 0xfd, 0x0c, ...lanes, 0xfd, 0x0c, ...lanes, 0xfd, 0x80, 0x02, 0x1a, 0x0b];
    const code = [0x01, body.length, ...body];
    const module = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: () -> ()
      0x03, 0x02, 0x01, 0x00, // one function
      0x0a, code.length, ...code, // code section
    ]);
    return WebAssembly.validate(module);
  } catch {
    return false;
  }
}

/**
 * Picks the engine build to load.
 *
 * Both builds are made from the same sources; the relaxed one lets the compiler
 * fold some SIMD sequences the baseline build has to keep separate. The plain
 * build is the fallback and is always produced.
 */
export function pickVariant(requested = 'auto') {
  if (requested === 'relaxed' || requested === 'simd') return requested;
  return hasRelaxedSimd() ? 'relaxed' : 'simd';
}

/** File names of the engine build for a variant. */
export function engineFiles(variant) {
  return variant === 'relaxed'
    ? { js: 'solace-relaxed.js', wasm: 'solace-relaxed.wasm' }
    : { js: 'solace.js', wasm: 'solace.wasm' };
}

// ---------------------------------------------------------------------------
// device profile
// ---------------------------------------------------------------------------

/**
 * Picks the engine settings a device can actually afford.
 *
 * The defaults in Stockfish are desktop defaults: 16 MB of hash and a one
 * second think time. A phone with 4 GB of RAM shares it with the browser, the
 * page and the 98 MB network the engine keeps resident, so the hash has to be
 * smaller there; a device with 2 GB should not be asked to hold more than a
 * few megabytes. `navigator.deviceMemory` is a coarse, deliberately rounded
 * number (0.25, 0.5, 1, 2, 4, 8) and is `undefined` in Safari; the fallback
 * assumes a mid-range phone.
 *
 * @param {object} [nav] navigator-like object (injectable for tests)
 * @returns {{hashMB: number, threads: number, thinkTime: number, tier: string}}
 */
export function deviceProfile(nav = typeof navigator !== 'undefined' ? navigator : {}) {
  const memory = Number(nav.deviceMemory) || 0; // GB, undefined in Firefox/Safari
  const cores = Number(nav.hardwareConcurrency) || 0;

  let tier = 'mid';
  if (memory && memory <= 2) tier = 'low';
  else if (memory >= 8 && cores >= 8) tier = 'high';

  // Coarse pointers are phones and tablets: they get the mobile defaults even
  // when the browser refuses to report memory.
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  const hashMB = tier === 'low' ? 4 : tier === 'high' ? 32 : coarse ? 8 : 16;
  const thinkTime = tier === 'low' ? 500 : tier === 'high' ? 1500 : 1000;

  return {
    tier,
    hashMB,
    // One search thread: a second one competes with the page for the same cores
    // and, on a phone, for the same thermal budget.
    threads: 1,
    thinkTime,
  };
}
