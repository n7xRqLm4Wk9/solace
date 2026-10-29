# Running SOLACE on Android

SOLACE is plain JavaScript with **zero dependencies**, so it runs anywhere a
JavaScript engine runs: Node.js (including Termux), a Chromium-based browser, or
any static web host. There is nothing to compile and nothing to download except
the repository itself.

Below are three ways to use it on a phone, from "no terminal at all" to the full
developer setup.

---

## 1. No terminal, no Node: use the browser build

The `web/` folder is a complete, mobile-first chess app. The engine runs in a Web
Worker (so the board never freezes), and it includes a FEN loader, an evaluation
bar, undo, a hint button and a perft self-test.

### Option 1a: put it on a static host (recommended)

Browsers refuse to load ES modules from `file://`, so the page needs to be served
over HTTP. The cheapest reliable way is a free static host:

1. Fork/upload this repository to GitHub.
2. In the repository, open *Settings → Pages*, choose "Deploy from a branch" and
   select the branch you pushed with the root (or `/docs`) folder.
3. Open `https://<your-user>.github.io/<repo>/web/` in Chrome on the phone.
4. Chrome menu → **Add to Home screen** so the board is one tap away.

Any other static host (Netlify drop, Cloudflare Pages, an S3 bucket) works the
same way: upload the repository and open `/web/index.html`.

### Option 1b: serve the files from the phone

Install a small static-server app from the Play Store (search for "HTTP server",
for example *Simple HTTP Server* or *NetShare*), point it at the repository
folder, and open `http://127.0.0.1:8080/web/` in the phone's browser.

If you *do* have Node in Termux (section 2), the repository ships its own server:

```sh
node tools/serve.js 3000     # then open http://127.0.0.1:3000 in Chrome
```

### Option 1c: no host at all, only the phone's file manager

Browsers block `file://` module imports, but they do allow single-file HTML.
If you cannot serve anything, use the CLI/test route in Termux instead - it is
honestly the better experience for engine work.

---

## 2. Full setup with Termux (terminal, Node.js, engine, tests)

Termux is a free terminal emulator that runs a real Linux userland on Android.
It is the only app you need.

1. Install **Termux** from F-Droid (the Play Store version is outdated):
   <https://f-droid.org/packages/com.termux/>
2. Open Termux and install Node.js and git:

   ```sh
   pkg update && pkg upgrade -y
   pkg install -y nodejs git
   node --version          # anything >= 18 is fine
   ```

3. Get the code (either clone, or copy the folder from your phone's Downloads):

   ```sh
   git clone https://github.com/<your-user>/<your-repo>.git solace
   cd solace
   ```

4. Run the automated tests. This is the first thing to do on a new device:

   ```sh
   node tests/run.js          # 136 tests, a few seconds
   node tests/run.js movegen  # one suite: movegen, fen, eval, draw, search, uci, tools, web
   ```

5. Check that the engine is fast enough on your phone:

   ```sh
   node cli.js perft 4        # must print 197281
   node cli.js bench 4        # prints nodes, time and nps for 12 positions
   ```

   A modern mid-range phone is usually 2-4x slower than a laptop. If `bench 4`
   takes more than a few seconds, use depth 3 or a fixed time instead.

6. Play:

   ```sh
   node cli.js play
   ```

   Commands inside the board (`help` lists them all):

   ```
   play e2e4        play a move in UCI notation
   go 1000          let SOLACE think for 1000 ms
   depth 4          let SOLACE think to a fixed depth (faster, weaker)
   undo             take back the last two plies
   eval  fen  d  moves  quiet  quit
   ```

7. Use it from any GUI that speaks UCI (DroidFish, for example, has a "UCI
   engine" setting):

   ```sh
   node cli.js           # speaks UCI on stdin/stdout
   ```

   In DroidFish: *Settings → Engine settings → Add engine*, point it at
   `termux` with the arguments `node /data/data/com.termux/files/home/solace/cli.js`
   (DroidFish runs the binary directly, so a small wrapper script in `$PREFIX/bin`
   is the least painful way; the README of your GUI will show the exact path).

### Phone-friendly settings

| setting | value | why |
| --- | --- | --- |
| `Hash` | 16-64 MB | keeps the process small; a phone may kill large processes |
| `Move Overhead` | 100-300 ms | Android scheduling is jittery; extra headroom prevents time forfeits |
| search type | fixed depth 4-6 or `movetime 500-2000` | predictable battery/heat |
| `VerifyMoves` | off | it makes the engine ~20x slower; use it only when debugging |

Inside the browser build the hash is 16 MB and the maximum thinking time is
selected in the UI (default 1 s per move).

---

## 3. Editing the code on the phone

* **Termux + nano/vim**: `pkg install nano`, then `nano src/search/search.js`.
  `node tests/run.js` after every change; the whole suite takes seconds.
* **Acode** (Play Store, free): a code editor with a built-in terminal, useful
  for editing in a nicer UI and still running `node`.
* **GitHub web editor**: edit files in the browser, commit, then `git pull` in
  Termux. Good for small fixes when you do not want to type on a phone keyboard.

Practical tips:

* Use `git diff` before committing; the test suite is fast enough to run before
  every commit.
* Keep a copy of a known-good benchmark output (`node cli.js bench 4`) so you can
  tell whether a change helped on *your* phone.
* If the phone gets hot, prefer fixed-depth searches over fixed time.

---

## 4. What to expect in terms of speed

Search speed depends mostly on the JavaScript engine's JIT. On the development
machine (x86-64, Node 22) a full search runs at roughly 0.4-1.5 million nodes per
second. Termux on a mid-range phone (e.g. a 2021 mid-tier Snapdragon) typically
reaches 100-300k nodes per second, which is enough for depth 5-7 in the
middlegame with the default settings. The browser build uses the same code and is
slightly slower than Node, but it never blocks the UI because it runs in a
Worker.

The engine deliberately has no threads and does not use `SharedArrayBuffer`: a
single-threaded search is easier to verify, works in every browser without
cross-origin isolation, and cannot be killed mid-move by Android's scheduler.
