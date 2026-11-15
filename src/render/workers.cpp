#include "render/workers.hpp"

#include <new>

#include "util/alloc.hpp"

#ifndef MOCHI2D_NO_THREADS
#include <atomic>
#include <cfenv>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <thread>
#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <process.h>
#include <windows.h>
#else
#include <pthread.h>
#endif
#if defined(__i386__) || defined(__x86_64__) || defined(_M_IX86) || defined(_M_X64)
#include <emmintrin.h>
#define MOCHI2D_PAUSE() _mm_pause()
#elif defined(__aarch64__) || defined(__arm__)
#define MOCHI2D_PAUSE() __asm__ __volatile__("yield")
#else
#define MOCHI2D_PAUSE() ((void)0)
#endif
#endif

namespace mochi2d::render {

#ifdef MOCHI2D_NO_THREADS

struct Workers::Shared {};
Workers::~Workers() = default;
void Workers::start(int) {}
void Workers::stop() {}
void Workers::run(int count, void (*job)(void*, int), void* context) {
  for (int i = 0; i < count; i++) job(context, i);
}
int Workers::hardware() { return 1; }

#else

namespace {

constexpr int kMaxThreads = 64;
/**
 * How long a worker waits for the next job, in pause instructions, before
 * it sleeps (the draws of a frame follow one another closely), and how long
 * the caller spins for the last band before it yields.
 */
constexpr int kSpins = 1 << 13;

#if defined(_WIN32)
using Thread = HANDLE;
#else
using Thread = pthread_t;
#endif

}  // namespace

/**
 * What the workers share with the caller. `word` holds the job's generation
 * (above the low 8 bits) and its band count (the low 8 bits): a worker
 * without a band in a job reads nothing else, so the caller may set the
 * next job as soon as the workers with bands are done.
 */
struct Workers::Shared {
  struct Start {
    Shared* shared = nullptr;
    int index = 0;
  };
  std::atomic<uint64_t> word{0};
  std::atomic<int> pending{0};
  std::atomic<int> sleepers{0};
  std::atomic<bool> stopping{false};
  void (*job)(void*, int) = nullptr;
  void* context = nullptr;
  std::fenv_t env{};
  std::mutex mutex;
  std::condition_variable wake;
  Thread threads[kMaxThreads];
  Start starts[kMaxThreads];
  int started = 0;

  void loop(int index);
};

namespace {

#if defined(_WIN32)
unsigned __stdcall thread_entry(void* p) {
  auto* s = static_cast<Workers::Shared::Start*>(p);
  s->shared->loop(s->index);
  return 0;
}
#else
void* thread_entry(void* p) {
  auto* s = static_cast<Workers::Shared::Start*>(p);
  s->shared->loop(s->index);
  return nullptr;
}
#endif

}  // namespace

void Workers::Shared::loop(int index) {
  uint64_t seen = 0;
  for (;;) {
    uint64_t w = word.load(std::memory_order_acquire);
    int spins = 0;
    while ((w >> 8) == seen) {
      if (stopping.load(std::memory_order_relaxed)) return;
      if (++spins < kSpins) {
        MOCHI2D_PAUSE();
      } else {
        std::unique_lock<std::mutex> lock(mutex);
        sleepers.fetch_add(1);
        wake.wait(lock, [&] { return (word.load() >> 8) != seen || stopping.load(); });
        sleepers.fetch_sub(1);
        spins = 0;
      }
      w = word.load(std::memory_order_acquire);
    }
    seen = w >> 8;
    if (index < static_cast<int>(w & 0xff)) {
      std::fenv_t e = env;
      std::fesetenv(&e);
      job(context, index);
      pending.fetch_sub(1, std::memory_order_acq_rel);
    }
  }
}

Workers::~Workers() { stop(); }

void Workers::start(int n) {
  n = n < 1 ? 1 : n > kMaxThreads ? kMaxThreads : n;
  if (n == n_) return;
  stop();
  if (n == 1) return;
  void* p = allocate_bytes(sizeof(Shared), alignof(Shared));
  if (!p) return;
  Shared* s = new (p) Shared();
  for (int i = 1; i < n; i++) {
    Shared::Start& st = s->starts[i];
    st.shared = s;
    st.index = i;
#if defined(_WIN32)
    const uintptr_t h = _beginthreadex(nullptr, 0, &thread_entry, &st, 0, nullptr);
    if (h == 0) break;
    s->threads[s->started] = reinterpret_cast<HANDLE>(h);
#else
    if (pthread_create(&s->threads[s->started], nullptr, &thread_entry, &st) != 0) break;
#endif
    s->started++;
  }
  if (s->started == 0) {
    s->~Shared();
    deallocate_bytes(s);
    return;
  }
  shared_ = s;
  n_ = 1 + s->started;
}

void Workers::stop() {
  if (!shared_) return;
  Shared& s = *shared_;
  s.stopping.store(true);
  { std::lock_guard<std::mutex> lock(s.mutex); }
  s.wake.notify_all();
  for (int i = 0; i < s.started; i++) {
#if defined(_WIN32)
    WaitForSingleObject(s.threads[i], INFINITE);
    CloseHandle(s.threads[i]);
#else
    pthread_join(s.threads[i], nullptr);
#endif
  }
  s.~Shared();
  deallocate_bytes(&s);
  shared_ = nullptr;
  n_ = 1;
}

int Workers::hardware() {
  const unsigned n = std::thread::hardware_concurrency();
  return n == 0 ? 1 : n > static_cast<unsigned>(kMaxThreads) ? kMaxThreads : static_cast<int>(n);
}

void Workers::run(int count, void (*job)(void*, int), void* context) {
  const int bands = count < n_ ? count : n_;
  if (!shared_ || bands <= 1) {
    for (int i = 0; i < count; i++) job(context, i);
    return;
  }
  Shared& s = *shared_;
  s.job = job;
  s.context = context;
  std::fegetenv(&s.env);
  s.pending.store(bands - 1, std::memory_order_relaxed);
  const uint64_t generation = (s.word.load(std::memory_order_relaxed) >> 8) + 1;
  // Sequentially consistent with the sleepers' count: a worker either sees
  // this job before it sleeps, or is counted here and woken.
  s.word.store(generation << 8 | static_cast<uint64_t>(bands));
  if (s.sleepers.load() > 0) {
    { std::lock_guard<std::mutex> lock(s.mutex); }
    s.wake.notify_all();
  }
  job(context, 0);
  for (int i = bands; i < count; i++) job(context, i);
  int spins = 0;
  while (s.pending.load(std::memory_order_acquire) != 0) {
    if (++spins < kSpins)
      MOCHI2D_PAUSE();
    else
      std::this_thread::yield();
  }
}

#endif

}  // namespace mochi2d::render
