// Fuzz target: a whole model folder through the C API (Mochi2D 0.16.0's
// `model` target, which found the physics hang): the synthetic folder of
// tests/support/model_folder.hpp with one file replaced by the input (its
// first byte picks the file), opened with m2d_package_open, then an
// animator with its physics, pose and motion sync, an expression by name,
// a group motion with its sound, and a few frames evaluated. With bit 0x40
// of the first byte the package opens within caps (and its source tells
// sizes), so that some files pass the total: the limit paths run too. Every
// path must refuse bad files with an error, never crash, read out of bounds
// or hang.
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "mochi2d.h"
#include "support/model_folder.hpp"

namespace {

struct Folder {
  std::vector<std::pair<std::string, std::string>> files;
};

int32_t read(const char* path, const void** data, size_t* size, void* user) {
  const auto* f = static_cast<const Folder*>(user);
  for (const auto& [name, bytes] : f->files)
    if (name == path) {
      *data = bytes.data();
      *size = bytes.size();
      return 1;
    }
  return 0;
}

int32_t file_size(const char* path, uint64_t* out, void* user) {
  for (const auto& [name, bytes] : static_cast<const Folder*>(user)->files)
    if (name == path) {
      *out = bytes.size();
      return 1;
    }
  return 0;
}

int32_t list(void (*add)(const char*, void*), void* context, void* user) {
  for (const auto& [name, bytes] : static_cast<const Folder*>(user)->files) add(name.c_str(), context);
  return 1;
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  static const auto base = mochi2d::testing::model_folder();
  if (size == 0) return 0;
  Folder folder{base};
  folder.files[data[0] % folder.files.size()].second.assign(reinterpret_cast<const char*>(data + 1), size - 1);
  m2d_file_source source{};
  source.label = "fuzz";
  source.read = read;
  source.list = list;
  source.user = &folder;
  m2d_error err;
  m2d_package* package = nullptr;
  m2d_package_limits limits;
  m2d_package_limits_default(&limits);
  if (data[0] & 0x40) {
    // Caps that leave the folder some 64-byte steps short of all of it.
    uint64_t all = 0;
    for (const auto& f : folder.files) all += f.second.size();
    limits.max_total_bytes = all - std::min<uint64_t>(all, 64u * (data[0] & 0x3f));
    source.size = file_size;
  }
  // Half the inputs name the settings file, the others let the package find it.
  if (m2d_package_open_with_limits(&source, (data[0] & 0x80) ? nullptr : "m.model3.json", 0, &limits, nullptr,
                                   &package, &err) != M2D_OK)
    return 0;
  m2d_model* model = m2d_package_model(package);
  m2d_animator* animator = nullptr;
  if (m2d_animator_create(model, m2d_package_settings(package), m2d_package_physics(package),
                          m2d_package_pose(package), nullptr, &animator, &err) == M2D_OK) {
    if (const m2d_motion_sync* sync = m2d_package_motion_sync(package)) {
      m2d_motion_sync_options options;
      m2d_motion_sync_options_default(&options);
      m2d_animator_set_motion_sync(animator, sync, &options);
    }
    const m2d_expression* expression = nullptr;
    if (m2d_package_named_expression(package, "e", &expression, &err) == M2D_OK && expression)
      m2d_animator_start_expression(animator, expression);
    int32_t accepted = 0;
    m2d_package_start_motion(package, animator, "Tap", 0, nullptr, nullptr, nullptr, &accepted, &err);
    m2d_instance* instance = nullptr;
    if (m2d_instance_create(model, &instance, &err) == M2D_OK) {
      m2d_frame frame;
      for (int k = 0; k < 5; k++) m2d_animator_update(animator, instance, 1.0 / 30, &frame, &err);
      m2d_instance_destroy(instance);
    }
    m2d_animator_destroy(animator);
  }
  m2d_package_destroy(package);
  return 0;
}
