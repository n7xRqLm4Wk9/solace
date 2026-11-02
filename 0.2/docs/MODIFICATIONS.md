# Changes made to Stockfish 19

Solace 0.2 is a modified version of Stockfish, as required by the GPLv3 (see
[GPL.md](GPL.md)). This file lists every difference from upstream release
`sf_19` (tag `sf_19`, commit of 2026-09-05). Upstream sources are kept
unmodified in [`../vendor/stockfish`](../vendor/stockfish); the changes live in
`patches/*.patch` and are applied by `scripts/build.sh` while building.

Upstream: <https://github.com/official-stockfish/Stockfish/tree/sf_19>

## 0001-branding.patch — the engine identifies itself as Solace

| file | change |
|---|---|
| `src/misc.cpp` | `version` changes from `"19"` to `"Solace 0.2"`, so `id name` reports `Solace 0.2` and `engine_version_info()` prints `Solace 0.2`. |
| `src/uci.h` | declares `bool UCIEngine::command(const std::string&)` |
| `src/uci.cpp` | the body of the stdin loop becomes `UCIEngine::command()`, which executes one command line and returns `false` on `quit`; `UCIEngine::loop()` now reads a line and calls it. No command changes behaviour. |

Behavioural difference: none for a normal stdin/CLI build — `loop()` still reads
stdin line by line and calls the same dispatcher.

## 0002-wasm-entrypoint.patch — let a page drive the engine

| file | change |
|---|---|
| `src/main.cpp` | with `-DSOLACE_WASM`, `main()` calls `WasmBridge::install()` with the engine object and returns instead of entering the blocking `UCIEngine::loop()`. The engine object is intentionally leaked so it lives as long as the module. |

## 0003-solace-tuning.patch — Solace's own tuning layer

| file | change |
|---|---|
| `src/engine.cpp` | registers the options `Solace Tuning` (preset), `Solace LMR Scale`, `Solace Pruning Scale`, `Solace History Scale`, `Solace Optimism Scale`; applies the default preset after the option list is built |
| `src/search.cpp` | multiplies the LMR amount, the futility and SEE pruning margins and the history divisor by the matching scale |
| `src/evaluate.cpp` | multiplies the time-dependent optimism by its scale |

Every scale is a percentage of the Stockfish 19 value, so `Solace Tuning =
Stockfish 19` restores the upstream engine exactly (verified: `bench` searches
the identical node count, 1 808 810 for `bench 1`). See
[TUNING.md](TUNING.md) for what the preset contains and how it was measured.

## 0003 in practice: what the defaults were set to

The tuning layer exists so the search can be changed without touching upstream
code, and so every change is measurable. Six scale variants were played against
`Solace Tuning=Stockfish 19` (120 games each) and **all six measured worse**, the
clearest losses being about −50 Elo (10 % less pruning, more history weight,
half the optimism). The shipped
preset therefore keeps the upstream numbers; the options are there to keep
measuring. The full table is in [TUNING.md](TUNING.md).

This is a deliberate result, not an unfinished one: it means Solace 0.2 differs
from Stockfish in what it measures and adapts (below), not in guessed constants.

## New files: `src/cpp/*.cpp` (ours, not patches, copied in by the build)

Two exported C functions:

`wasm_bridge.cpp` exports:

```c
void solace_command(const char* line);  // run one UCI command line
int  solace_ready();                    // 1 once main() created the engine
```

`solace.cpp` / `solace.h` hold the tuning layer described above.

They only forward to `UCIEngine::command()`. All engine output still goes
through `std::cout`, which Emscripten forwards to the JavaScript `print`
callback, so nothing about the protocol changes — the page speaks the same UCI
as the desktop binary.

`wasm_bridge.h` is the matching header.

## Behaviour the page adds (JavaScript, not the search)

These are the changes a player actually feels. None of them touches the
evaluation or the search; all of them are tested in `tests/web.mjs`.

| file | what it does | why |
|---|---|---|
| `web/overhead.js` | times every engine answer, keeps the worst of the last twelve, sets `Move Overhead` to 1.5× that, clamped to 50–500 ms | Stockfish's 10 ms reserve was measured for native binaries; a browser adds a task hop, a wasm boundary and garbage collection, and loses games on time without the correction |
| `web/book.js` | plays one of a handful of sane moves for the first six plies | two consecutive games should not be the same game |
| `src/config.js` | picks the relaxed-SIMD build when the runtime supports it, else the plain SIMD one | measured ~4 % faster with a bit-identical search (`tools/bench.mjs`) |

## Build-time differences (not source changes)

| what | upstream wasm build | Solace 0.2 |
|---|---|---|
| network | appended with `--preload-file`, inside the wasm | written into the virtual filesystem by `src/engine.js` before `main()` runs (`-DNNUE_EMBEDDING_OFF`), then freed |
| entry | `main()` runs the UCI loop on stdin | `-sINVOKE_RUN=0`, loader calls `callMain([])`, then injects commands |
| SIMD | one `-msimd128` build | two builds, plain SIMD and relaxed SIMD, chosen at load time |
| everything else | identical flags: `-pthread -msimd128 -DUSE_POPCNT -DUSE_SLOPPY_ATOMICS`, Syzygy off | same |

## How to apply the patches to a newer Stockfish

```sh
cd 0.2
rm -rf vendor/stockfish && cp -R /path/to/new/Stockfish vendor/stockfish
./scripts/build.sh          # fails on the first rejected hunk
```

`patch` prints the rejects; regenerate with

```sh
# after editing scripts/work/src by hand
diff -u vendor/stockfish/src/uci.cpp scripts/work/src/uci.cpp > patches/0001-branding.patch
```

The two patches touch four small regions, so they normally keep applying with
`patch -p1 --fuzz=3`; check `docs/` and the tests after an upgrade.

## What was *not* changed

The NNUE code, move generation, transposition table, time-management
algorithm and the UCI command set are untouched. With `Solace Tuning=Stockfish
19`, the same options and the same network, Solace 0.2 produces the same
analysis as Stockfish 19 — byte-identical `bench` node counts, verified on both
the native and the WebAssembly build.

What *is* different from a renamed Stockfish: the search constants are exposed
as measured scales with a preset, the browser build corrects the engine's time
reserve from measured latency, the page varies its openings, and the build ships
two SIMD variants with a measured throughput difference. Nothing here is claimed
to be stronger than Stockfish 19 at equal thinking time; the tuning runs did not
find such a change, and that result is documented rather than papered over.
