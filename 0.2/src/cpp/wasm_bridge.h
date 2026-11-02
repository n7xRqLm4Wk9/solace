/*
  Solace 0.2 — WebAssembly bridge (part of Solace, not upstream Stockfish).

  Solace is free software: you can redistribute it and/or modify it under the
  terms of the GNU General Public License as published by the Free Software
  Foundation, either version 3 of the License, or (at your option) any later
  version. See ../../Copying.txt and ../../docs/GPL.md.
*/

#ifndef WASM_BRIDGE_H_INCLUDED
#define WASM_BRIDGE_H_INCLUDED

namespace Stockfish {

class UCIEngine;

// Keeps a pointer to the engine instance created by main(), so the exported
// C functions below can reach it from JavaScript.
namespace WasmBridge {
void       install(UCIEngine* engine);
UCIEngine* instance();
}  // namespace WasmBridge

}  // namespace Stockfish

#endif  // WASM_BRIDGE_H_INCLUDED
