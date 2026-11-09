# Building Solace 0.2 without installing Emscripten

`emsdk` is the normal way to build this project (see
[`../../docs/BUILD.md`](../../docs/BUILD.md)). This folder is the fallback for
machines where that is not possible — no root, no apt, a phone, or a sandbox
that only allows npm traffic. It makes the npm packages
`@ai-ecoverse/wasm-emscripten` (Emscripten 6.0.9, clang 24, binaryen 132,
themselves compiled to WebAssembly) behave like a real compiler driver so that
`scripts/build.sh` can run unchanged.

```sh
mkdir -p ~/emtool && cd ~/emtool
npm install @ai-ecoverse/wasm-emscripten@6.0.9-31
python3 /path/to/0.2/tools/toolchain/setup-toolchain.py --dir .

. ./env.sh                                  # EM_CONFIG, EM_CACHE, PATH
cd /path/to/0.2 && EMXX=em++ ./scripts/build.sh
```

## What has to be fixed, and why

**1. The tools have an in-memory filesystem.** Each packaged tool is an
Emscripten module, so it cannot see the host unless a `NODEFS` mount is added to
its startup code. The mount has to go *over* the directories the runtime has
already created (`FS.mount(NODEFS, …)`), not as a symlink: a symlink onto a
non-empty directory throws, and the tool is left with an empty filesystem and
reports that it "cannot open" every input file.
`setup-toolchain.py` patches the mount into every packaged tool and writes
`binwrap/` launchers plus an `emconfig.py`.

**2. The clang driver cannot fork.** Emscripten's driver normally spawns itself
for `-E` and `-cc1as` steps. `clang-wrap.py` does those steps in-process
instead. The detail that matters: `-cc1as` defaults to *assembly* output, so the
wrapper must pass `-filetype obj`. Without it every `.S` file in the system
libraries "compiles" into a text file, `libc-mt.a` ends up without
`__set_thread_state`, and any `-pthread` link fails with

```
wasm-ld: error: undefined symbol: __set_thread_state
```

If a cached build predates that fix, delete
`emcache/sysroot/lib/wasm32-emscripten/libc-mt.a` (and `libclang_rt.builtins-mt.a`)
and rebuild — the first `em++` run regenerates them, which takes about an hour,
or patch the affected objects in with `emar r` as was done here.

**3. Binaryen tools are patched too**, for the same filesystem reason:
`wasm-opt` / `wasm-metadce` cannot read the `.wasm` that `wasm-ld` just wrote
without the mount, and the link then fails at the very last step.

## What this is not

This is a workaround for one packaging of Emscripten, pinned to the version
above. It is not part of the engine and it is not required for the committed
`engine/` build to be reproducible with a normal `emsdk` — `scripts/build.sh`
and the flags in `docs/BUILD.md` are the whole recipe.
