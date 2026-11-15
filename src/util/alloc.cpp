#include "util/alloc.hpp"

#include <cstdlib>
#include <cstring>

namespace mochi2d {

namespace {

thread_local const Heap* t_current = nullptr;

/**
 * Every block starts with a header that says how to free it. The header is
 * 32 bytes, so blocks stay aligned to 16 (max_align_t on the platforms
 * supported); larger alignments are padded.
 */
struct alignas(16) Header {
  void (*deallocate)(void*, std::size_t, std::size_t, void*);
  void* user;
  void* base;  // what the heap returned
  std::size_t size;  // what was asked of the heap
};
static_assert(sizeof(Header) == 32, "header size");

constexpr std::size_t kBaseAlign = 16;

}  // namespace

const Heap* current_heap() noexcept { return t_current; }

HeapScope::HeapScope(const Heap* heap) noexcept : previous_(t_current) { t_current = heap; }
HeapScope::~HeapScope() { t_current = previous_; }

void* allocate_bytes(std::size_t size, std::size_t alignment) noexcept {
  if (alignment < kBaseAlign) alignment = kBaseAlign;
  const std::size_t extra = sizeof(Header) + (alignment > kBaseAlign ? alignment : 0);
  if (size > std::numeric_limits<std::size_t>::max() - extra) return nullptr;
  const std::size_t total = size + extra;
  const Heap* h = t_current;
  void* base = h && h->allocate ? h->allocate(total, kBaseAlign, h->user) : std::malloc(total);
  if (!base) return nullptr;
  auto addr = reinterpret_cast<std::uintptr_t>(base) + sizeof(Header);
  addr = (addr + alignment - 1) & ~static_cast<std::uintptr_t>(alignment - 1);
  auto* header = reinterpret_cast<Header*>(addr - sizeof(Header));
  header->deallocate = h && h->allocate ? h->deallocate : nullptr;
  header->user = h ? h->user : nullptr;
  header->base = base;
  header->size = total;
  return reinterpret_cast<void*>(addr);
}

void deallocate_bytes(void* p) noexcept {
  if (!p) return;
  auto* header = reinterpret_cast<Header*>(static_cast<char*>(p) - sizeof(Header));
  if (header->deallocate)
    header->deallocate(header->base, header->size, kBaseAlign, header->user);
  else
    std::free(header->base);
}

void out_of_memory_failure() {
#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
  throw std::bad_alloc();
#else
  std::abort();
#endif
}

String to_str(long long x) {
  char buf[24];
  char* e = buf + sizeof buf;
  char* p = e;
  const bool neg = x < 0;
  unsigned long long u = neg ? 0ull - static_cast<unsigned long long>(x) : static_cast<unsigned long long>(x);
  do {
    *--p = static_cast<char>('0' + u % 10);
    u /= 10;
  } while (u);
  if (neg) *--p = '-';
  return String(p, static_cast<std::size_t>(e - p));
}

}  // namespace mochi2d
