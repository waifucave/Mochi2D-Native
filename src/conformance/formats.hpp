// Sequence and animation scenarios (port of Mochi2D's
// src/conformance/formats.ts): their formats, runners and results.
#pragma once

#include <string_view>

#include "conformance/scenario.hpp"

namespace mochi2d::conformance {

/** Runs a `mochi2d-sequence/0` scenario into a `mochi2d-sequence-result/0` result. */
json::Value run_sequence_json(const json::Value& json, std::string_view id, ModelCache& models, std::string_view producer);
/** Runs a `mochi2d-anim-scenario/0` scenario into a `mochi2d-anim-result/0` result. */
json::Value run_animation_json(const json::Value& json, std::string_view id, ModelCache& models, std::string_view producer);

}  // namespace mochi2d::conformance
