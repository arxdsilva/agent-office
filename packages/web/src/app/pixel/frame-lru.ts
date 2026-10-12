// A least-recently-used cache that never evicts an entry used in the current frame. The 2D
// character cache bakes one set of canvases per agent look; zoomed out, more looks than the cap
// can be on screen at once, and a plain LRU would then rebuild every look every frame.

export class FrameLru<V> {
  private entries = new Map<string, { value: V; frame: number }>()
  private frame = 0

  constructor(
    private readonly cap: number,
    private readonly onEvict: (key: string, value: V) => void = () => {},
  ) {}

  /**
   * Call once per rendered frame, before the frame's `get`s. Trims the oldest entries past the cap,
   * but never one the finished frame used (they are about to be drawn again).
   */
  nextFrame(): void {
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.cap || e.frame === this.frame) break
      this.entries.delete(k)
      this.onEvict(k, e.value)
    }
    this.frame++
  }

  get size(): number {
    return this.entries.size
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** The value for `key` (built with `make` when missing), marked as used this frame. */
  get(key: string, make: () => V): V {
    let e = this.entries.get(key)
    if (e) this.entries.delete(key)
    else e = { value: make(), frame: this.frame }
    e.frame = this.frame
    this.entries.set(key, e)
    return e.value
  }

  forEach(fn: (value: V, key: string) => void): void {
    for (const [k, e] of this.entries) fn(e.value, k)
  }

  clear(): void {
    for (const [k, e] of this.entries) this.onEvict(k, e.value)
    this.entries.clear()
  }
}
