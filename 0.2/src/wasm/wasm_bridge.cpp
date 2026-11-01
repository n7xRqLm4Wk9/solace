/*
  Solace 0.2 — WebAssembly bridge (part of Solace, not upstream Stockfish).

  Solace is free software: you can redistribute it and/or modify it under the
  terms of the GNU General Public License as published by the Free Software
  Foundation, either version 3 of the License, or (at your option) any later
  version. See ../../Copying.txt and ../../docs/GPL.md.

  In a browser there is no blocking stdin to run the usual UCI loop, so main()
  initialises the engine and returns, and the page feeds command lines through
  solace_command(). Everything the engine prints still goes to stdout, which the
  Emscripten glue forwards to the JavaScript `print` callback.
*/

#include "wasm_bridge.h"

#include <string>

#include "uci.h"

namespace Stockfish::WasmBridge {

namespace {
UCIEngine* theEngine = nullptr;
}  // namespace

void       install(UCIEngine* engine) { theEngine = engine; }
UCIEngine* instance() { return theEngine; }

}  // namespace Stockfish::WasmBridge

extern "C" {

// Executes one UCI command line (without the trailing newline).
void solace_command(const char* line) {
    if (auto* engine = Stockfish::WasmBridge::instance())
        engine->command(line ? std::string(line) : std::string());
}

// True once the engine object exists (main() has finished initialising).
int solace_ready() {
    return Stockfish::WasmBridge::instance() ? 1 : 0;
}

}  // extern "C"
