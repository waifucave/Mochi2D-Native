// Test support for the GPU backends' tools: files and the comparison of two
// folders of PNGs (per image the RMS over all channels and the largest
// channel difference, on the stored premultiplied bytes).
#pragma once

#include <filesystem>
#include <string>

#include "util/alloc.hpp"

namespace mochi2d::test {

bool read_file(const std::filesystem::path& p, String& out);
/** Prints a line per image; 1 when an image is missing or beyond a bound (negative: none), or none exists. */
int compare_folders(const std::string& folder_a, const std::string& folder_b, double max_rms, double max_diff);

}  // namespace mochi2d::test
