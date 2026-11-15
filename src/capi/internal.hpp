// Definitions shared by the C API's source files: the handles of the core
// objects and small helpers.
#pragma once

#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <string_view>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "framework/tints.hpp"
#include "mochi2d.h"
#include "util/alloc.hpp"

using namespace mochi2d;

struct m2d_model {
  Heap heap;
  std::shared_ptr<const moc::Model> model;
  Vector<Vector<float>> uvs;
  Vector<Vector<uint16_t>> indices;
  HashMap<String, int32_t> drawable_index;
  /** Each drawable's first vertex in the model's vertex layout, then the total (drawables + 1 entries). */
  Vector<int64_t> vertex_offsets;
};

struct m2d_instance {
  Heap heap;
  eval::Instance* inst = nullptr;
  /** Application tints of the drawables (draw data, not evaluated). */
  framework::Tints tints;
  ~m2d_instance();
};

namespace capi {

inline void set_error(m2d_error* e, m2d_status s, const char* code, const char* message) {
  if (!e) return;
  e->status = s;
  std::strncpy(e->code, code, sizeof e->code - 1);
  e->code[sizeof e->code - 1] = 0;
  std::strncpy(e->message, message, sizeof e->message - 1);
  e->message[sizeof e->message - 1] = 0;
}

inline void clear_error(m2d_error* e) { set_error(e, M2D_OK, "", ""); }

/** A copy of a string in the current heap, freed by m2d_free_string. */
inline char* dup_string(std::string_view s) {
  char* out = static_cast<char*>(allocate_bytes(s.size() + 1, 1));
  if (!out) return nullptr;
  std::memcpy(out, s.data(), s.size());
  out[s.size()] = 0;
  return out;
}

inline Heap heap_of(const m2d_allocator* a) {
  Heap h;
  if (a && a->allocate && a->deallocate) {
    h.allocate = a->allocate;
    h.deallocate = a->deallocate;
    h.user = a->user;
  }
  return h;
}

/** Creates an object in the current heap. */
template <class T, class... A>
T* create(A&&... args) {
  void* p = allocate_bytes(sizeof(T), alignof(T));
  return p ? new (p) T(std::forward<A>(args)...) : nullptr;
}

template <class T>
void destroy(T* p) {
  if (!p) return;
  p->~T();
  deallocate_bytes(p);
}

inline bool in(int32_t i, std::size_t n) { return i >= 0 && static_cast<std::size_t>(i) < n; }

/** A model handle for a loaded model, created in the current heap (which becomes the handle's). */
m2d_model* wrap_model(std::shared_ptr<const moc::Model> model, const Heap& heap);

inline const moc::Model* M(const m2d_model* m) { return m && m->model ? m->model.get() : nullptr; }
inline const eval::Instance* I(const m2d_instance* i) { return i && i->inst ? i->inst : nullptr; }
inline eval::Instance* Im(m2d_instance* i) { return i && i->inst ? i->inst : nullptr; }

}  // namespace capi


using namespace capi;
