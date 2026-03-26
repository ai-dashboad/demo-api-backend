import { describe, it, expect, beforeEach } from 'vitest'
import { RingBuffer } from './ring-buffer.js'
import type { MetricSample } from './types.js'

function makeSample(value: number, offsetMs = 0): MetricSample {
  return {
    metric_name: 'test.metric',
    value,
    unit: 'count',
    timestamp: new Date(1_000_000 + offsetMs),
    labels: {},
  }
}

describe('RingBuffer', () => {
  it('should reject non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError)
    expect(() => new RingBuffer(-1)).toThrow(RangeError)
    expect(() => new RingBuffer(1.5)).toThrow(RangeError)
  })

  it('should report size 0 when empty', () => {
    const buf = new RingBuffer(4)
    expect(buf.size).toBe(0)
    expect(buf.isFull).toBe(false)
    expect(buf.toArray()).toEqual([])
  })

  it('should grow size as samples are pushed until capacity', () => {
    const buf = new RingBuffer(3)
    buf.push(makeSample(1))
    expect(buf.size).toBe(1)
    buf.push(makeSample(2))
    buf.push(makeSample(3))
    expect(buf.size).toBe(3)
    expect(buf.isFull).toBe(true)
  })

  it('should preserve insertion order when buffer is not full', () => {
    const buf = new RingBuffer(5)
    buf.push(makeSample(10, 0))
    buf.push(makeSample(20, 1))
    buf.push(makeSample(30, 2))
    expect(buf.toArray().map(s => s.value)).toEqual([10, 20, 30])
  })

  it('should overwrite oldest entry when full', () => {
    const buf = new RingBuffer(3)
    buf.push(makeSample(1))
    buf.push(makeSample(2))
    buf.push(makeSample(3))
    buf.push(makeSample(4)) // overwrites value=1
    expect(buf.size).toBe(3)
    expect(buf.toArray().map(s => s.value)).toEqual([2, 3, 4])
  })

  it('should maintain oldest-first order after multiple overwrites', () => {
    const buf = new RingBuffer(3)
    for (let i = 1; i <= 7; i++) buf.push(makeSample(i))
    // After 7 pushes into capacity-3 buffer, last 3 are 5, 6, 7
    expect(buf.toArray().map(s => s.value)).toEqual([5, 6, 7])
  })

  it('should return empty array after clear', () => {
    const buf = new RingBuffer(3)
    buf.push(makeSample(1))
    buf.push(makeSample(2))
    buf.clear()
    expect(buf.size).toBe(0)
    expect(buf.toArray()).toEqual([])
  })

  it('should accept new pushes after clear', () => {
    const buf = new RingBuffer(2)
    buf.push(makeSample(1))
    buf.clear()
    buf.push(makeSample(99))
    expect(buf.toArray().map(s => s.value)).toEqual([99])
  })
})
