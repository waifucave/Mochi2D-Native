// fdlibm, as V8 ships it (the code behind Node's Math functions), vendored
// so that Mochi2D Native computes transcendental functions exactly as
// Mochi2D does under Node, and identically on every platform. sqrt stays std::sqrt: IEEE sqrt is exact.
#pragma once

namespace mochi2d {
namespace fdlibm {

double acos(double x);
double acosh(double x);
double asin(double x);
double asinh(double x);
double atan(double x);
double atan2(double y, double x);
double cos(double x);
double sin(double x);
double tan(double x);
double exp(double x);
double expm1(double x);
double atanh(double x);
double log(double x);
double log1p(double x);
double log2(double x);
double log10(double x);
double cbrt(double x);
double pow(double x, double y);
double cosh(double x);
double sinh(double x);
double tanh(double x);

}  // namespace fdlibm
}  // namespace mochi2d
