#!/usr/bin/env python3
"""Clang driver wrapper: assemble .S/.s inputs in-process.

The wasm clang cannot spawn children, so `-cc1as` steps are run here instead of
being forked by the driver.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REAL = os.path.join(ROOT, 'binwrap', 'llvm', 'clang.real')

FEATURES = {
    '-msimd128': 'simd128', '-mrelaxed-simd': 'relaxed-simd', '-matomics': 'atomics',
    '-mbulk-memory': 'bulk-memory', '-mmutable-globals': 'mutable-globals',
    '-mnontrapping-fptoint': 'nontrapping-fptoint', '-msign-ext': 'sign-ext',
    '-mmultivalue': 'multivalue', '-mexception-handling': 'exception-handling',
    '-mreference-types': 'reference-types', '-mtail-call': 'tail-call',
}


def run(args):
    return subprocess.run([REAL] + args).returncode


def output_arg(args):
    for i, a in enumerate(args):
        if a == '-o' and i + 1 < len(args):
            return args[i + 1], i
        if a.startswith('-o') and len(a) > 2 and not a.startswith('-objc'):
            return a[2:], i
    return None, -1


def main():
    args = sys.argv[1:]
    if args and args[0].startswith('-cc1as'):
        return run(args)

    srcs = [a for a in args if not a.startswith('-') and os.path.splitext(a)[1] in ('.S', '.s')]
    if not srcs:
        return run(args)

    out, out_index = output_arg(args)
    rc = 0
    for src in srcs:
        target = src
        if src.endswith('.S'):
            with tempfile.NamedTemporaryFile(suffix='.i', delete=False) as tf:
                target = tf.name
            skip = set()
            if out_index >= 0:
                skip = {out_index} if args[out_index] != '-o' else {out_index, out_index + 1}
            pre = [a for j, a in enumerate(args) if j not in skip and a != '-c' and a != src]
            r = run(['-E', '-o', target] + pre + [src])
            if r:
                if os.path.exists(target):
                    os.unlink(target)
                return r

        triple = 'wasm32-unknown-emscripten'
        for a in args:
            if a.startswith('--target='):
                triple = a.split('=', 1)[1]
        outfile = out or (os.path.splitext(src)[0] + '.o')
        cc1as = ['-cc1as', '-triple', triple, '-filetype', 'obj', '-o', outfile]
        for flag, feature in FEATURES.items():
            if flag in args:
                cc1as += ['-target-feature', '+' + feature]
        r = run(cc1as + [target])
        if src.endswith('.S') and os.path.exists(target):
            os.unlink(target)
        if r:
            rc = r
    return rc


if __name__ == '__main__':
    sys.exit(main())
