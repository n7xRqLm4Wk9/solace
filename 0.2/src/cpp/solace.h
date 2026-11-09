/*
  Solace 0.2 — tuning layer (part of Solace, not upstream Stockfish).

  Solace is free software: you can redistribute it and/or modify it under the
  terms of the GNU General Public License as published by the Free Software
  Foundation, either version 3 of the License, or (at your option) any later
  version. See ../../Copying.txt and ../../docs/GPL.md.

  The search and evaluation parameters below live in number tables buried in
  search.cpp and evaluate.cpp, tuned by the Stockfish project for long time
  controls on desktop hardware. Solace runs in a browser at roughly 1 s/move,
  which is a very different regime, so the same tables can be re-weighted at
  runtime and the preset chosen by self-play (see docs/TUNING.md).

  All values are percentages: 100 reproduces the Stockfish 19 behaviour
  exactly, so `Solace Tuning = Stockfish 19` is bit-for-bit the upstream engine.
*/

#ifndef SOLACE_H_INCLUDED
#define SOLACE_H_INCLUDED

#include <string>
#include <string_view>

namespace Stockfish::Solace {

struct Params {
    // Scales the late-move-reduction amount (search.cpp: Worker::reduction()).
    int lmrScale = 100;
    // Scales futility margins and SEE-based pruning thresholds.
    int pruningScale = 100;
    // Scales the history divisor that turns history into extra LMR depth.
    int historyScale = 100;
    // Scales the time-dependent optimism fed into the evaluation.
    int optimismScale = 100;
};

extern Params params;

// Presets. `apply` resets every parameter and then applies the preset.
enum class Preset { Stockfish19, Solace02 };
void apply(Preset);

// The preset Solace uses unless the user selects another one.
Preset default_preset();

// Parses a preset name ("stockfish19", "solace02"); returns false if unknown.
bool parse_preset(std::string_view name, Preset& out);

// A short human readable list of the active parameters, for `uci`/`d`.
std::string describe();

}  // namespace Stockfish::Solace

#endif  // SOLACE_H_INCLUDED
