#!/usr/bin/env python3
"""Rebuild the npm-hosted Emscripten toolchain used to build Solace 0.2.

The @ai-ecoverse packages ship clang/binaryen compiled to WebAssembly and run
them under Node with an in-memory filesystem. Two things have to be fixed up
before they behave like a normal compiler driver:

  1. the host filesystem has to be visible (NODEFS mounted at /host) and the
     working directory preserved, otherwise the compiler cannot read inputs,
  2. the clang driver may not fork, so .S/.s inputs are assembled in-process by
     a wrapper script (tools/clang-wrap.py). That wrapper also has to pass
     `-filetype obj` to `-cc1as`: without it the assembler writes assembly text
     instead of an object file, which builds a libc-mt.a that is missing
     `__set_thread_state` and every pthread build then fails to link.

Run:  python3 setup-toolchain.py [--dir /tmp/emtool]
(after `npm install @ai-ecoverse/wasm-emscripten@6.0.9-31` in that directory)
"""

import argparse
import glob
import os
import shutil
import sys

REL = 'node_modules/@ai-ecoverse'
MARKER = "Module['onRuntimeInitialized'] = function sliccNodeMain() {"

MOUNT_SNIPPET = r"""
  // mounted by setup-toolchain.py — the host filesystem has to be visible
  try {
    if (!FS.analyzePath('/host').exists) {
      FS.mkdir('/host');
      FS.mount(NODEFS, { root: '/' }, '/host');
    }
  } catch (e) {
    if (typeof printErr === 'function') printErr('mount failed: ' + e);
  }
  // Mounting NODEFS *over* an existing in-memory directory is the only form
  // that works for paths the runtime already created (symlinking fails on a
  // non-empty directory and would silently leave the tool with an empty FS).
  ['tmp', 'home', 'usr', 'etc', 'proc', 'var', 'opt', 'bin', 'sbin', 'lib',
   'lib64', 'root', 'run', 'srv', 'mnt', 'media', 'dev'].forEach(function (d) {
    try {
      var st = FS.analyzePath('/' + d);
      if (st.exists && FS.isDir(st.object.mode)) FS.mount(NODEFS, { root: '/' + d }, '/' + d);
      else if (!st.exists) FS.symlink('/host/' + d, '/' + d);
    } catch (e) {}
  });
  try { FS.chdir(process.cwd()); } catch (e) {}
"""


def patch_js_tools(bin_dir):
    patched = 0
    for path in sorted(glob.glob(os.path.join(bin_dir, '*'))):
        if not os.path.isfile(path) or path.endswith(('.wasm', '.py')):
            continue
        text = open(path, encoding='utf-8', errors='replace').read()
        if MARKER not in text or 'mounted by setup-toolchain' in text:
            continue
        synthetic = (
            text.replace(MARKER, MARKER + MOUNT_SNIPPET, 1)
            if 'mounted by setup-toolchain' not in text
            else text
        )
        synthetic = synthetic.replace(
            MOUNT_SNIPPET, "\n  // mounted by setup-toolchain\n" + MOUNT_SNIPPET, 1
        )
        open(path, 'w', encoding='utf-8').write(synthetic)
        patched += 1
    return patched


def shell(path, body):
    with open(path, 'w') as fh:
        fh.write('#!/bin/sh\n' + body)
    os.chmod(path, 0o755)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default='/tmp/emtool')
    args = ap.parse_args()

    root = os.path.abspath(args.dir)
    ns = os.path.join(root, REL)
    if not os.path.isdir(ns):
        sys.exit('packages not installed in %s' % root)

    clang_pkg = os.path.join(ns, 'wasm-clang')
    binaryen_pkg = os.path.join(ns, 'wasm-binaryen')
    em_pkg = os.path.join(ns, 'wasm-emscripten')
    cache_pkg = os.path.join(ns, 'emscripten-cache')

    llvm_bin = os.path.join(root, 'binwrap', 'llvm')
    binwrap_binaryen = os.path.join(root, 'binwrap', 'binaryen')
    binaryen_bin = os.path.join(binwrap_binaryen, 'bin')
    binaryen_local = os.path.join(binwrap_binaryen, 'pkg')
    tools_dir = os.path.join(root, 'tools')
    for d in (llvm_bin, binaryen_bin, binaryen_local, tools_dir, os.path.join(root, 'emcache')):
        os.makedirs(d, exist_ok=True)

    n1 = patch_js_tools(os.path.join(clang_pkg, 'bin'))
    n2 = patch_js_tools(os.path.join(binaryen_pkg, 'bin'))
    print('patched clang tools: %d, binaryen tools: %d' % (n1, n2))

    for path in glob.glob(os.path.join(binaryen_pkg, 'bin', '*')):
        if os.path.isfile(path):
            shutil.copy2(path, os.path.join(binaryen_local, os.path.basename(path)))

    # llvm launchers: everything goes through the (patched) package tools
    for tool in ('wasm-ld', 'ld.lld', 'lld', 'llvm-ar', 'llvm-nm', 'llvm-objcopy',
                 'llvm-ranlib', 'llvm-strip', 'llvm-symbolizer'):
        shell(os.path.join(llvm_bin, tool),
              'exec node %s/wasm-clang/bin/%s "$@"\n' % (ns, tool))

    # the compilers are driven through the assembly-capable wrapper
    wrap_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools', 'clang-wrap.py')
    if os.path.exists(wrap_src) and os.path.abspath(os.path.dirname(wrap_src)) != os.path.abspath(tools_dir):
        shutil.copy2(wrap_src, os.path.join(tools_dir, 'clang-wrap.py'))
    shell(os.path.join(llvm_bin, 'clang.real'), 'exec node %s/wasm-clang/bin/clang "$@"\n' % ns)
    for tool in ('clang', 'clang++', 'cc', 'c++', 'gcc', 'g++'):
        shell(os.path.join(llvm_bin, tool),
              'exec python3 %s/tools/clang-wrap.py "$@"\n' % root)

    # binaryen launchers
    for tool in ('wasm-opt', 'wasm-as', 'wasm-dis', 'wasm-ctor-eval', 'wasm-metadce',
                 'wasm-reduce', 'wasm-shell', 'wasm2js', 'wasm-merge', 'wasm-split'):
        if os.path.exists(os.path.join(binaryen_local, tool)):
            shell(os.path.join(binaryen_bin, tool),
                  'exec node %s "$@"\n' % os.path.join(binaryen_local, tool))

    node = shutil.which('node') or '/usr/local/bin/node'
    with open(os.path.join(root, 'emconfig.py'), 'w') as fh:
        fh.write("LLVM_ROOT = %r\n" % llvm_bin)
        fh.write("BINARYEN_ROOT = %r\n" % binwrap_binaryen)
        fh.write("NODE_JS = %r\n" % node)
        fh.write("CACHE = %r\n" % os.path.join(root, 'emcache'))
        fh.write("EMSCRIPTEN_ROOT = %r\n" % em_pkg)

    link = os.path.join(root, 'emcache', 'sysroot')
    if not os.path.exists(link):
        os.symlink(os.path.join(cache_pkg, 'sysroot'), link)

    with open(os.path.join(root, 'env.sh'), 'w') as fh:
        fh.write('export EM_CONFIG=%s/emconfig.py\n' % root)
        fh.write('export EM_CACHE=%s/emcache\n' % root)
        fh.write('export EM_PACKAGE_ROOT=%s\n' % em_pkg)
        fh.write('export EM_CACHE_PACKAGE=%s\n' % cache_pkg)
        fh.write('export SLICC_EMCC_PLAIN=1\n')
        fh.write('export EMCC_BATCH_BUILD=0\n')
        fh.write('export PATH=%s/bin:$HOME/.local/bin:$PATH\n' % em_pkg)
    print('wrote %s/env.sh' % root)
