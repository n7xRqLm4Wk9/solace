# Changes made to Stockfish 19

Solace 0.2 is a modified version of Stockfish, as required by the GPLv3 (see
[GPL.md](GPL.md)). This file lists every difference from upstream release
`sf_19` (tag `sf_19`, commit of 2026-09-05). Upstream sources are kept
unmodified in [`../vendor/stockfish`](../vendor/stockfish); the changes live in
`patches/*.patch` and are applied by `build/build.sh` while building.

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

## New file: `src/wasm/wasm_bridge.cpp` (not a patch, added by the build)

Two exported C functions:

```c
void solace_command(const char* line);  // run one UCI command line
int  solace_ready();                    // 1 once main() created the engine
```

They only forward to `UCIEngine::command()`. All engine output still goes
through `std::cout`, which Emscripten forwards to the JavaScript `print`
callback, so nothing about the protocol changes — the page speaks the same UCI
as the desktop binary.

`src/wasm/wasm_bridge.h` is the matching header.

## Build-time differences (not source changes)

| what | upstream wasm build | Solace 0.2 |
|---|---|---|
| network | appended with `--preload-file`, inside the wasm | written into the virtual filesystem by `src/engine.js` before `main()` runs (`-DNNUE_EMBEDDING_OFF`), then freed |
| entry | `main()` runs the UCI loop on stdin | `-sINVOKE_RUN=0`, loader calls `callMain([])`, then injects commands |
| everything else | identical flags: `-pthread -msimd128 -DUSE_POPCNT -DUSE_SLOPPY_ATOMICS`, Syzygy off | same |

## How to apply the patches to a newer Stockfish

```sh
cd 0.2
rm -rf vendor/stockfish && cp -R /path/to/new/Stockfish vendor/stockfish
./build/build.sh          # fails on the first rejected hunk
```

`patch` prints the rejects; regenerate with

```sh
# after editing build/work/src by hand
diff -u vendor/stockfish/src/uci.cpp build/work/src/uci.cpp > patches/0001-branding.patch
```

The two patches touch four small regions, so they normally keep applying with
`patch -p1 --fuzz=3`; check `docs/` and the tests after an upgrade.

## What was *not* changed

The search, evaluation, NNUE code, move generation, transposition table, time
management, tuning and the UCI option set are untouched. Solace 0.2 with the
same options and the same network produces the same analysis as Stockfish 19.
