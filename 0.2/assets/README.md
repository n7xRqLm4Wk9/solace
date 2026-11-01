# Neural network

`nn-1a298aa575a0.nnue` lives here at runtime but is **not** stored in the
repository: it is 98 MB, and the engine only needs it once per session.

Create it with:

```sh
cd 0.2
node build/fetch-net.mjs
```

The script downloads the file published by the Stockfish project and checks it
against

```
size    98511183 bytes
sha256  1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2
```

which is the hash published in `official-stockfish/networks`. If the official
hosts cannot be reached, it extracts the identical file from the `stockfish`
npm package and verifies the hash again — a corrupted or partial download is
therefore rejected instead of producing a silently weaker engine.

Serving the page? `server.mjs` serves this folder, so the browser can fetch the
file at `/0.2/assets/nn-1a298aa575a0.nnue`.
