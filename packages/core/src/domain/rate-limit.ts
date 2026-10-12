/** Allows `perSec` hits per key in any rolling one-second window. */
export class RateWindow {
  private hits = new Map<string, number[]>()

  constructor(private perSec: number) {}

  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 1000)
    const ok = recent.length < this.perSec
    if (ok) recent.push(now)
    this.hits.set(key, recent)
    return ok
  }
}
