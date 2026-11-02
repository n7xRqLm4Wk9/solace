# Licence and GPL compliance

Solace 0.2 is a fork of **Stockfish**, which is licensed under the
**GNU General Public License version 3** (GPLv3). Modifying Stockfish and
distributing the result is allowed, provided the licence and the sources are
kept and the changes are stated.

## What this means for Solace 0.2

1. **The licence text ships with the engine.**
   [`../vendor/stockfish/Copying.txt`](../vendor/stockfish/Copying.txt) is the
   original GPLv3 text from Stockfish, unmodified.

2. **The authors are credited.**
   [`../vendor/stockfish/AUTHORS`](../vendor/stockfish/AUTHORS) lists the
   Stockfish developers; the browser UI and README name Stockfish 19 as the
   origin of the engine.

3. **The sources are published.**
   This repository contains the complete corresponding source code:

   * the pristine upstream sources in `vendor/stockfish`,
   * every change as a patch in `patches/`,
   * the extra source files we add (`src/cpp/wasm_bridge.cpp`,
     `src/cpp/solace.cpp` and its header),
   * the JavaScript glue, the page and the build script.

   Building the engine produces `engine/solace.js` + `engine/solace.wasm` and
   `engine/solace-relaxed.js` + `engine/solace-relaxed.wasm`. Those are the
   "object code" this repository distributes; `scripts/build.sh` is the script
   that turns the sources above into them, and the exact toolchain used for the
   committed build is described in [`BUILD.md`](BUILD.md).

4. **The changes are stated.**
   [`MODIFICATIONS.md`](MODIFICATIONS.md) lists them one by one, which is what
   GPLv3 § 5(a) asks for.

5. **Solace 0.2 stays under the GPL.** The engine built from this folder is
   GPLv3-or-later. The JavaScript loader that talks to it over UCI is a separate
   work (UCI is a documented interface), and the board model reused by the page
   comes from the MIT-licensed 0.1.5 code in `../0.1.5`.

6. **No warranty**, as in the GPL: the engine comes with none.

## Source for a prebuilt copy

If you received `engine/solace.wasm` without the repository, the corresponding
source is the upstream Stockfish 19 release plus the patches in `patches/`:

* <https://github.com/official-stockfish/Stockfish/releases/tag/sf_19>
* `patches/0001-branding.patch`, `patches/0002-wasm-entrypoint.patch`,
  `patches/0003-solace-tuning.patch`
* `src/cpp/wasm_bridge.{cpp,h}`, `src/cpp/solace.{cpp,h}`, `scripts/build.sh`,
  `src/*.js`, `web/*`, `tools/toolchain/*`

## The neural network

`assets/nn-1a298aa575a0.nnue` is the network published by the Stockfish project
(`official-stockfish/networks`) for Stockfish 19. It is not part of this
repository; `scripts/fetch-net.mjs` downloads it and verifies its SHA-256. It is
distributed by upstream under the same project licence.
