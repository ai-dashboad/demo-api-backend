import { describe, it, expect, beforeEach } from 'vitest'
import { MetricStore } from './store.js'

function ts(offsetMs: number): Date {
  return new Date(1_700_000_000_000 + offsetMs)
}

describe('MetricStore.record', () => {
  it('should store a sample and return it with a timestamp', () => {
    const store = new MetricStore()
    const sample = store.record({ metric_name: 'api.latency', value: 42, unit: 'ms' })
    expect(sample.metric_name).toBe('api.latency')
    expect(sample.value).toBe(42)
    expect(sample.timestamp).toBeInstanceOf(Date)
    expect(store.size).toBe(1)
  })

  it('should use provided timestamp when supplied', () => {
    const store = new MetricStore()
    const t = ts(0)
    const sample = store.record({ metric_name: 'x', value: 1, unit: 'count', timestamp: t })
    expect(sample.timestamp).toEqual(t)
  })

  it('should throw when metric_name is empty', () => {
    const store = new MetricStore()
    expect(() => store.record({ metric_name: '', value: 1, unit: 'count' })).toThrow()
  })

  it('should throw when value is NaN', () => {
    const store = new MetricStore()
    expect(() => store.record({ metric_name: 'x', value: NaN, unit: 'count' })).toThrow()
  })

  it('should throw when value is Infinity', () => {
    const store = new MetricStore()
    expect(() => store.record({ metric_name: 'x', value: Infinity, unit: 'ms' })).toThrow()
  })

  it('should throw on an unrecognised unit', () => {
    const store = new MetricStore()
    expect(() =>
      store.record({ metric_name: 'x', value: 1, unit: 'furlongs' as never })
    ).toThrow()
  })
})

describe('MetricStore.query', () => {
  let store: MetricStore

  beforeEach(() => {
    store = new MetricStore()
    store.record({ metric_name: 'cpu',     value: 10, unit: 'percent',  timestamp: ts(0),   labels: { host: 'a' } })
    store.record({ metric_name: 'cpu',     value: 20, unit: 'percent',  timestamp: ts(100), labels: { host: 'b' } })
    store.record({ metric_name: 'cpu',     value: 30, unit: 'percent',  timestamp: ts(200), labels: { host: 'a' } })
    store.record({ metric_name: 'mem',     value: 50, unit: 'bytes',    timestamp: ts(50),  labels: { host: 'a' } })
    store.record({ metric_name: 'latency', value: 99, unit: 'ms',       timestamp: ts(150), labels: { host: 'a' } })
  })

  it('should return all samples when no filter is applied', () => {
    expect(store.query()).toHaveLength(5)
  })

  it('should filter by metric_name', () => {
    const results = store.query({ metric_name: 'cpu' })
    expect(results).toHaveLength(3)
    expect(results.every(s => s.metric_name === 'cpu')).toBe(true)
  })

  it('should filter by from timestamp (inclusive)', () => {
    const results = store.query({ metric_name: 'cpu', from: ts(100) })
    expect(results.map(s => s.value).sort()).toEqual([20, 30])
  })

  it('should filter by to timestamp (inclusive)', () => {
    const results = store.query({ metric_name: 'cpu', to: ts(100) })
    expect(results.map(s => s.value).sort()).toEqual([10, 20])
  })

  it('should filter by a closed time range', () => {
    const results = store.query({ from: ts(50), to: ts(150) })
    // mem@ts(50), cpu@ts(100), latency@ts(150)
    expect(results).toHaveLength(3)
  })

  it('should filter by a single label', () => {
    const results = store.query({ metric_name: 'cpu', labels: { host: 'a' } })
    expect(results).toHaveLength(2)
    expect(results.every(s => s.labels['host'] === 'a')).toBe(true)
  })

  it('should return an empty array when no sample matches labels', () => {
    expect(store.query({ labels: { host: 'z' } })).toEqual([])
  })

  it('should return results newest-first', () => {
    const results = store.query({ metric_name: 'cpu' })
    expect(results[0]?.value).toBe(30) // ts(200) is newest
    expect(results[2]?.value).toBe(10) // ts(0) is oldest
  })

  it('should honour limit', () => {
    expect(store.query({ limit: 2 })).toHaveLength(2)
  })
})

describe('MetricStore.aggregate', () => {
  let store: MetricStore

  beforeEach(() => {
    store = new MetricStore()
    ;[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach((v, i) => {
      store.record({ metric_name: 'req.duration', value: v, unit: 'ms', timestamp: ts(i * 100) })
    })
  })

  it('should return null when no samples match', () => {
    expect(store.aggregate('nonexistent', 'avg')).toBeNull()
  })

  it('should compute avg correctly', () => {
    const result = store.aggregate('req.duration', 'avg')
    expect(result?.value).toBe(55) // (10+20+...+100)/10
  })

  it('should compute min correctly', () => {
    expect(store.aggregate('req.duration', 'min')?.value).toBe(10)
  })

  it('should compute max correctly', () => {
    expect(store.aggregate('req.duration', 'max')?.value).toBe(100)
  })

  it('should compute sum correctly', () => {
    expect(store.aggregate('req.duration', 'sum')?.value).toBe(550)
  })

  it('should compute count correctly', () => {
    expect(store.aggregate('req.duration', 'count')?.value).toBe(10)
  })

  it('should compute p95 correctly', () => {
    // p95 of [10..100] (10 values) → ceil(10*0.95)=10 → sorted[9]=100
    expect(store.aggregate('req.duration', 'p95')?.value).toBe(100)
  })

  it('should compute p99 correctly', () => {
    expect(store.aggregate('req.duration', 'p99')?.value).toBe(100)
  })

  it('should populate sample_count, from, and to fields', () => {
    const result = store.aggregate('req.duration', 'avg')
    expect(result?.sample_count).toBe(10)
    expect(result?.from).toBeInstanceOf(Date)
    expect(result?.to).toBeInstanceOf(Date)
  })

  it('should apply time-range filter before aggregating', () => {
    // Only ts(0)..ts(200) → values 10, 20, 30
    const result = store.aggregate('req.duration', 'avg', { from: ts(0), to: ts(200) })
    expect(result?.value).toBe(20)
    expect(result?.sample_count).toBe(3)
  })
})

describe('MetricStore capacity eviction', () => {
  it('should evict oldest samples when capacity is exceeded', () => {
    const store = new MetricStore({ capacity: 3 })
    store.record({ metric_name: 'm', value: 1, unit: 'count', timestamp: ts(0) })
    store.record({ metric_name: 'm', value: 2, unit: 'count', timestamp: ts(1) })
    store.record({ metric_name: 'm', value: 3, unit: 'count', timestamp: ts(2) })
    store.record({ metric_name: 'm', value: 4, unit: 'count', timestamp: ts(3) })

    const results = store.query({ metric_name: 'm' })
    expect(results).toHaveLength(3)
    // Newest-first: 4, 3, 2; value=1 was evicted
    expect(results.map(s => s.value)).toEqual([4, 3, 2])
  })
})
