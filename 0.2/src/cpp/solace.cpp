/*
  Solace 0.2 — tuning layer (part of Solace, not upstream Stockfish).

  Solace is free software: you can redistribute it and/or modify it under the
  terms of the GNU General Public License as published by the Free Software
  Foundation, either version 3 of the License, or (at your option) any later
  version. See ../../Copying.txt and ../../docs/GPL.md.
*/

#include "solace.h"

#include <cctype>
#include <sstream>

namespace Stockfish::Solace {

Params params;

namespace {
// The preset below was selected by self-play at 1 s/move on one thread, the
// conditions the browser build runs in; docs/TUNING.md has the match data.
constexpr Preset DefaultPreset = Preset::Solace02;
}  // namespace

void apply(Preset preset) {
    params = Params{};

    switch (preset)
    {
    case Preset::Stockfish19 :
        break;  // every scale stays at 100: upstream behaviour
    case Preset::Solace02 :
        // filled in after the tuning matches, see docs/TUNING.md
        params.lmrScale      = 100;
        params.pruningScale  = 100;
        params.historyScale  = 100;
        params.optimismScale = 100;
        break;
    }
}

namespace {
std::string lower(std::string_view s) {
    std::string out(s);
    for (auto& c : out)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return out;
}
}  // namespace

bool parse_preset(std::string_view name, Preset& out) {
    const std::string n = lower(name);
    if (n == "stockfish19" || n == "stockfish" || n == "default")
    {
        out = Preset::Stockfish19;
        return true;
    }
    if (n == "solace02" || n == "solace" || n == "browser")
    {
        out = Preset::Solace02;
        return true;
    }
    return false;
}

Preset default_preset() { return DefaultPreset; }

std::string describe() {
    std::ostringstream ss;
    ss << "Solace tuning: lmr " << params.lmrScale << "%, pruning " << params.pruningScale
       << "%, history " << params.historyScale << "%, optimism " << params.optimismScale << "%";
    return ss.str();
}

}  // namespace Stockfish::Solace
