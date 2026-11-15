#include "support/image_compare.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <vector>

#include "conformance/render.hpp"

namespace fs = std::filesystem;

namespace mochi2d::test {

bool read_file(const fs::path& p, String& out) {
  std::FILE* f = std::fopen(p.u8string().c_str(), "rb");
  if (!f) return false;
  char buf[65536];
  std::size_t n;
  out.clear();
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  std::fclose(f);
  return true;
}

int compare_folders(const std::string& folder_a, const std::string& folder_b, double max_rms, double max_diff) {
  const fs::path da = fs::u8path(folder_a), db = fs::u8path(folder_b);
  std::vector<fs::path> names;
  std::error_code ec;
  for (const auto& e : fs::directory_iterator(da, ec))
    if (e.path().extension() == ".png") names.push_back(e.path().filename());
  std::sort(names.begin(), names.end());
  int failed = 0;
  double worst_rms = 0;
  int worst_diff = 0;
  for (const auto& name : names) {
    String ba, bb, why;
    Vector<uint8_t> pa, pb;
    int wa = 0, ha = 0, wb = 0, hb = 0;
    if (!read_file(da / name, ba) || !read_file(db / name, bb) || !conformance::decode_png(ba, wa, ha, pa, why) ||
        !conformance::decode_png(bb, wb, hb, pb, why) || wa != wb || ha != hb) {
      std::cout << "MISSING " << name.u8string() << "\n";
      failed++;
      continue;
    }
    // decode_png gives straight RGBA from the stored bytes; the stored bytes are premultiplied, compared as they are.
    double sum = 0;
    int diff = 0;
    std::size_t over = 0;
    for (std::size_t i = 0; i < pa.size(); i++) {
      const int d = std::abs(static_cast<int>(pa[i]) - static_cast<int>(pb[i]));
      sum += static_cast<double>(d) * d;
      diff = std::max(diff, d);
      if (d > 2) over++;
    }
    const double rms = pa.empty() ? 0 : std::sqrt(sum / static_cast<double>(pa.size()));
    const bool bad = (max_rms >= 0 && rms > max_rms) || (max_diff >= 0 && diff > max_diff);
    if (bad) failed++;
    worst_rms = std::max(worst_rms, rms);
    worst_diff = std::max(worst_diff, diff);
    char line[256];
    std::snprintf(line, sizeof line, "%s %s: RMS %.3f, largest difference %d, %.3f%% of channels off by more than 2\n",
                  bad ? "FAIL" : "ok  ", name.u8string().c_str(), rms, diff,
                  pa.empty() ? 0.0 : 100.0 * static_cast<double>(over) / static_cast<double>(pa.size()));
    std::cout << line;
  }
  std::cout << names.size() << " images, " << failed << " fail; largest RMS " << worst_rms
            << ", largest difference " << worst_diff << "\n";
  return names.empty() || failed ? 1 : 0;
}

}  // namespace mochi2d::test
