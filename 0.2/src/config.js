/**
 * Solace 0.2 — build-time constants shared by the loader, the tests and the UI.
 */

/** Name announced in UCI (`id name Solace 0.2`). */
export const ENGINE_NAME = 'Solace 0.2';

/**
 * The NNUE network Stockfish 19 evaluates with. It is not stored in this
 * repository (98 MB); `node build/fetch-net.mjs` downloads and verifies it.
 */
export const NET_NAME = 'nn-1a298aa575a0.nnue';
export const NET_SIZE = 98511183;
export const NET_SHA256 = '1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2';
