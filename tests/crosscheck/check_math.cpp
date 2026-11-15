// Compares the vendored fdlibm with Node's Math bit for bit on the vectors
// of math.mjs. usage: mochi2d_check_math <vectors file>
#include <cinttypes>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>

#include "fdlibm.hpp"

namespace f = mochi2d::fdlibm;

static double from_hex(const char* s) {
  const uint64_t u = std::strtoull(s, nullptr, 16);
  double d;
  std::memcpy(&d, &u, 8);
  return d;
}

static bool same(double a, double b) {
  if (std::isnan(a) && std::isnan(b)) return true;  // any NaN is the one NaN of JavaScript
  return std::memcmp(&a, &b, 8) == 0;
}

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  std::FILE* in = std::fopen(argv[1], "r");
  if (!in) return 2;
  std::map<std::string, double (*)(double)> unary = {
      {"sin", f::sin},     {"cos", f::cos},     {"tan", f::tan},     {"atan", f::atan},   {"asin", f::asin},
      {"acos", f::acos},   {"exp", f::exp},     {"expm1", f::expm1}, {"log", f::log},     {"log1p", f::log1p},
      {"log2", f::log2},   {"log10", f::log10}, {"cbrt", f::cbrt},   {"sinh", f::sinh},   {"cosh", f::cosh},
      {"tanh", f::tanh},   {"asinh", f::asinh}, {"acosh", f::acosh}, {"atanh", f::atanh}};
  std::map<std::string, std::pair<long, long>> stats;  // name → (cases, different)
  char name[16], a[24], b[24], r[24];
  long shown = 0;
  while (std::fscanf(in, "%15s %23s %23s %23s", name, a, b, r) == 4) {
    const double x = from_hex(a), y = from_hex(b), want = from_hex(r);
    double got;
    if (!std::strcmp(name, "atan2"))
      got = f::atan2(x, y);
    else if (!std::strcmp(name, "pow"))
      got = f::pow(x, y);
    else
      got = unary.at(name)(x);
    auto& st = stats[name];
    st.first++;
    if (!same(want, got)) {
      st.second++;
      if (shown++ < 10) std::printf("  %s(%.17g, %.17g): Node %.17g, fdlibm %.17g\n", name, x, y, want, got);
    }
  }
  std::fclose(in);
  long total = 0, bad = 0;
  for (const auto& [n, st] : stats) {
    std::printf("%-6s %8ld cases, %ld different\n", n.c_str(), st.first, st.second);
    total += st.first;
    bad += st.second;
  }
  std::printf("math: %ld cases, %ld different from Node\n", total, bad);
  return bad ? 1 : 0;
}
