import type { MetricSample } from './types.js'

/**
 * Fixed-capacity circular buffer for MetricSample.
 *
 * Writes are O(1). When the buffer is full the oldest slot is overwritten.
 * This caps memory at O(capacity) regardless of ingest rate — safe for a
 * long-running process with no external TSDB dependency at MVP stage.
 */
export class RingBuffer {
  private readonly slots: Array<MetricSample | undefined>
  private head   = 0   // next write position
  private length = 0   // number of valid entries

  constructor(private readonly capacity: number) {
    if (capacity < 1 || !Number.isInteger(capacity)) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`)
    }
    this.slots = new Array(capacity)
  }

  get size(): number {
    return this.length
  }

  get isFull(): boolean {
    return this.length === this.capacity
  }

  push(sample: MetricSample): void {
    this.slots[this.head] = sample
    this.head = (this.head + 1) % this.capacity
    if (this.length < this.capacity) this.length++
  }

  /**
   * Returns all valid samples ordered oldest→newest.
   * Allocates a new array on each call; callers that need high-frequency
   * iteration should query via MetricStore instead.
   */
  toArray(): MetricSample[] {
    if (this.length === 0) return []

    // When the buffer is not yet full, valid data lives in slots[0..length-1].
    // Once full, head points to the oldest entry (it was just overwritten).
    const out: MetricSample[] = new Array(this.length)
    const oldest = this.isFull ? this.head : 0
    for (let i = 0; i < this.length; i++) {
      out[i] = this.slots[(oldest + i) % this.capacity] as MetricSample
    }
    return out
  }

  clear(): void {
    this.head   = 0
    this.length = 0
    this.slots.fill(undefined)
  }
}
