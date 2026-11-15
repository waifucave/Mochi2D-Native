// Memory allocation through the allocator of the object being worked on.
//
// An allocator (Heap) is given when an object is created: a model is loaded
// with one, an instance inherits its model's, a settings file is parsed with
// one. While the libraries work on an object, a HeapScope makes its heap the
// current one; every allocation of the libraries (arrays, strings, the
// objects themselves) goes to the current heap, or to malloc and free when
// none is set. Each block records the heap it came from, so it is always
// freed by the allocator that made it, whatever scope is current then.
//
// The rule that follows for threads: objects with different allocators never
// share memory; an object's allocator must be usable from whichever thread
// uses the object. The current heap is per thread, so different threads
// work on different objects independently.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <limits>
#include <new>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace mochi2d {

/** A host allocator. NULL hooks mean malloc and free. */
struct Heap {
  /** `size` bytes aligned to `alignment` (a power of two), or nullptr. */
  void* (*allocate)(std::size_t size, std::size_t alignment, void* user) = nullptr;
  /** Frees memory from `allocate` (size and alignment as allocated). */
  void (*deallocate)(void* p, std::size_t size, std::size_t alignment, void* user) = nullptr;
  void* user = nullptr;
};

/** The heap allocations go to on this thread now (nullptr: malloc and free). */
const Heap* current_heap() noexcept;

/** Makes `heap` the current one for its lifetime (nullptr: malloc and free). */
class HeapScope {
 public:
  explicit HeapScope(const Heap* heap) noexcept;
  ~HeapScope();
  HeapScope(const HeapScope&) = delete;
  HeapScope& operator=(const HeapScope&) = delete;

 private:
  const Heap* previous_;
};

/** Allocates from the current heap; nullptr when it fails. */
void* allocate_bytes(std::size_t size, std::size_t alignment) noexcept;
/** Frees a block from allocate_bytes (into the heap it came from). */
void deallocate_bytes(void* p) noexcept;

template <class T>
struct Allocator {
  using value_type = T;
  Allocator() noexcept = default;
  template <class U>
  Allocator(const Allocator<U>&) noexcept {}
  T* allocate(std::size_t n) {
    void* p = n <= std::numeric_limits<std::size_t>::max() / sizeof(T) ? allocate_bytes(n * sizeof(T), alignof(T)) : nullptr;
    if (!p) out_of_memory();
    return static_cast<T*>(p);
  }
  void deallocate(T* p, std::size_t) noexcept { deallocate_bytes(p); }
  template <class U>
  bool operator==(const Allocator<U>&) const noexcept { return true; }
  template <class U>
  bool operator!=(const Allocator<U>&) const noexcept { return false; }

 private:
  [[noreturn]] static void out_of_memory();
};

/** Called when an allocator returns nullptr: std::bad_alloc, or std::abort without exceptions. */
[[noreturn]] void out_of_memory_failure();

template <class T>
void Allocator<T>::out_of_memory() {
  out_of_memory_failure();
}

/** The libraries' vector and string. */
template <class T>
using Vector = std::vector<T, Allocator<T>>;
using String = std::basic_string<char, std::char_traits<char>, Allocator<char>>;

/** Hash for String keys. */
struct StringHash {
  std::size_t operator()(const String& s) const noexcept { return std::hash<std::string_view>()(std::string_view(s)); }
};

template <class K>
struct DefaultHash : std::hash<K> {};
template <>
struct DefaultHash<String> : StringHash {};

/** The libraries' hash map. */
template <class K, class V, class H = DefaultHash<K>>
using HashMap = std::unordered_map<K, V, H, std::equal_to<K>, Allocator<std::pair<const K, V>>>;

/** The libraries' hash set. */
template <class K, class H = DefaultHash<K>>
using HashSet = std::unordered_set<K, H, std::equal_to<K>, Allocator<K>>;

/**
 * A stable sort whose scratch space comes from the current heap
 * (std::stable_sort takes its buffer from operator new).
 */
template <class T, class Less>
void stable_sort(Vector<T>& v, Less less) {
  const std::size_t n = v.size();
  if (n < 2) return;
  Vector<T> tmp(v.begin(), v.end());
  Vector<T>* src = &v;
  Vector<T>* dst = &tmp;
  for (std::size_t width = 1; width < n; width *= 2) {
    for (std::size_t lo = 0; lo < n; lo += 2 * width) {
      const std::size_t mid = lo + width < n ? lo + width : n;
      const std::size_t hi = lo + 2 * width < n ? lo + 2 * width : n;
      std::size_t a = lo, b = mid, k = lo;
      while (a < mid && b < hi) (*dst)[k++] = less((*src)[b], (*src)[a]) ? (*src)[b++] : (*src)[a++];
      while (a < mid) (*dst)[k++] = (*src)[a++];
      while (b < hi) (*dst)[k++] = (*src)[b++];
    }
    Vector<T>* t = src;
    src = dst;
    dst = t;
  }
  if (src != &v) v.swap(*src);
}

/** Decimal text of an integer (std::to_string for String). */
String to_str(long long x);
inline String to_str(int x) { return to_str(static_cast<long long>(x)); }
inline String to_str(long x) { return to_str(static_cast<long long>(x)); }
inline String to_str(unsigned x) { return to_str(static_cast<long long>(x)); }
inline String to_str(unsigned long x) { return to_str(static_cast<long long>(x)); }
inline String to_str(unsigned long long x) { return to_str(static_cast<long long>(x)); }

/** Conversions at the boundary with code that uses std::string. */
inline String to_lib(std::string_view s) { return String(s.data(), s.size()); }
inline std::string to_std(std::string_view s) { return std::string(s.data(), s.size()); }

}  // namespace mochi2d
