// A main for the fuzz targets without libFuzzer: runs each file or folder
// given on the command line through LLVMFuzzerTestOneInput once (corpus
// replay, for compilers without -fsanitize=fuzzer and for the unit tests).
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);

namespace fs = std::filesystem;

static void run(const fs::path& p, std::size_t& n) {
  std::ifstream f(p, std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  LLVMFuzzerTestOneInput(bytes.data(), bytes.size());
  n++;
}

int main(int argc, char** argv) {
  std::size_t n = 0;
  for (int i = 1; i < argc; i++) {
    const fs::path p = argv[i];
    if (fs::is_directory(p)) {
      for (const auto& e : fs::recursive_directory_iterator(p))
        if (e.is_regular_file()) run(e.path(), n);
    } else {
      run(p, n);
    }
  }
  std::printf("%zu inputs ran\n", n);
  return 0;
}
