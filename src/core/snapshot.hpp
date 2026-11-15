// Evaluation results in the shape of the conformance result contract (port
// of Mochi2D's src/core/model/snapshot.ts).
#pragma once

#include <string>
#include <utility>
#include <vector>

#include "core/eval/instance.hpp"
#include "util/json.hpp"

namespace mochi2d {

/** Parameter values and part opacities by ID, in request order. */
struct EvaluationRequest {
  Vector<std::pair<String, double>> parameters;
  Vector<std::pair<String, double>> part_opacities;
};

/**
 * Resets the instance's inputs to the loaded state, then applies the request.
 * Unknown IDs give warnings ("unknown parameter X", "unknown part X").
 */
Vector<String> apply_request(eval::Instance& inst, const EvaluationRequest& request);

/**
 * The instance's outputs as result members, in order: canvas, parameters,
 * parts, drawables and (version 6) offscreens.
 */
void snapshot_into(const eval::Instance& inst, json::Value& out);

}  // namespace mochi2d
