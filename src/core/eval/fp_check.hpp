#pragma once

namespace mochi2d::eval {

/** a·b + c as the core computes it (contracted only if the build contracts). */
float fp_probe_f32(float a, float b, float c);
double fp_probe_f64(double a, double b, double c);

/** True when the core was built without floating-point contraction (required). */
bool fp_contraction_off();

}  // namespace mochi2d::eval
