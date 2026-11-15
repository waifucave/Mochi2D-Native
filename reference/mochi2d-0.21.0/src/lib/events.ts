/** A minimal typed event emitter. */
export class Emitter<Events extends { [K in keyof Events]: unknown }> {
  private readonly listeners = new Map<keyof Events, Set<(e: never) => void>>();

  /** Adds a listener. Returns a function that removes it. */
  on<K extends keyof Events>(type: K, listener: (event: Events[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (e: never) => void);
    return () => this.off(type, listener);
  }

  /** Adds a listener that is removed after its first call. */
  once<K extends keyof Events>(type: K, listener: (event: Events[K]) => void): () => void {
    const off = this.on(type, (e) => {
      off();
      listener(e);
    });
    return off;
  }

  off<K extends keyof Events>(type: K, listener: (event: Events[K]) => void): void {
    this.listeners.get(type)?.delete(listener as (e: never) => void);
  }

  /** Whether anything listens to `type`. */
  has(type: keyof Events): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }

  /** Calls the listeners of `type`; a listener that throws does not stop the others. */
  emit<K extends keyof Events>(type: K, event: Events[K]): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) {
      try {
        (l as (e: Events[K]) => void)(event);
      } catch (e) {
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
