// A small pool of worker threads for the renderer, which splits a draw's
// rows into bands, one per thread. The threads are the platform's own
// (POSIX or Windows threads), so nothing goes to the global operator new;
// the pool's state comes from the current heap. Built without threads
// (MOCHI2D_NO_THREADS) the pool has no workers and runs every band on the
// calling thread.
#pragma once

namespace mochi2d::render {

class Workers {
 public:
  Workers() = default;
  ~Workers();
  Workers(const Workers&) = delete;
  Workers& operator=(const Workers&) = delete;

  /**
   * Makes the pool run up to `n` bands at once: n − 1 worker threads and
   * the calling thread (fewer if threads cannot be started; at most 64).
   * Stops the current workers first if their number differs.
   */
  void start(int n);
  /** Stops the workers (bands then run on the calling thread). */
  void stop();
  /** The bands that can run at once, the calling thread included. */
  int size() const { return n_; }

  /**
   * Runs job(context, i) for every i in [0, count) (count ≤ size()), the
   * calling thread taking i = 0, and returns when all are done. The workers
   * run under the caller's floating-point environment. Jobs must not
   * allocate (the worker threads have no current heap).
   */
  void run(int count, void (*job)(void*, int), void* context);

  /** The hardware's concurrency (1 when unknown or without threads; at most 64). */
  static int hardware();

  /** The state shared with the threads (workers.cpp). */
  struct Shared;

 private:
  int n_ = 1;
  Shared* shared_ = nullptr;
};

}  // namespace mochi2d::render
