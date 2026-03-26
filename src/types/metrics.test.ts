import { describe, it, expect } from 'vitest'
import {
  MetricEventSchema,
  MetricSeriesSchema,
  AggregatedMetricSchema,
  ServerMetricMessageSchema,
  ClientMetricMessageSchema,
  parseServerMessage,
  parseClientMessage,
  safeParseServerMessage,
} from './metrics.js'

// ─── MetricEvent ──────────────────────────────────────────────────────────────

describe('MetricEventSchema', () => {
  const valid = {
    metric_name: 'agent.task.duration_ms',
    value: 142.5,
    timestamp: 1_700_000_000_000,
    labels: { service: 'agent-runtime' },
    unit: 'ms',
  }

  it('should accept a fully-populated event', () => {
    expect(() => MetricEventSchema.parse(valid)).not.toThrow()
  })

  it('should accept an event with no optional fields', () => {
    const minimal = { metric_name: 'cpu', value: 0.5, timestamp: 1_700_000_000_000 }
    expect(() => MetricEventSchema.parse(minimal)).not.toThrow()
  })

  it('should reject an empty metric_name', () => {
    expect(() => MetricEventSchema.parse({ ...valid, metric_name: '' })).toThrow()
  })

  it('should reject a non-integer timestamp', () => {
    expect(() => MetricEventSchema.parse({ ...valid, timestamp: 1.5 })).toThrow()
  })

  it('should reject a negative timestamp', () => {
    expect(() => MetricEventSchema.parse({ ...valid, timestamp: -1 })).toThrow()
  })

  it('should reject non-string label values', () => {
    expect(() =>
      MetricEventSchema.parse({ ...valid, labels: { env: 42 } })
    ).toThrow()
  })
})

// ─── MetricSeries ─────────────────────────────────────────────────────────────

describe('MetricSeriesSchema', () => {
  const valid = {
    metric_name: 'memory.heap_used_bytes',
    unit: 'bytes',
    data_points: [
      { value: 1024, timestamp: 1_700_000_000_000 },
      { value: 2048, timestamp: 1_700_000_001_000 },
    ],
    window_start: 1_700_000_000_000,
    window_end:   1_700_000_001_000,
  }

  it('should accept a valid series', () => {
    expect(() => MetricSeriesSchema.parse(valid)).not.toThrow()
  })

  it('should accept a series with zero data points', () => {
    expect(() =>
      MetricSeriesSchema.parse({ ...valid, data_points: [] })
    ).not.toThrow()
  })

  it('should reject when window_end is before window_start', () => {
    expect(() =>
      MetricSeriesSchema.parse({ ...valid, window_end: valid.window_start - 1 })
    ).toThrow()
  })

  it('should accept when window_end equals window_start (point-in-time window)', () => {
    expect(() =>
      MetricSeriesSchema.parse({ ...valid, window_end: valid.window_start })
    ).not.toThrow()
  })

  it('should reject a data_point with a non-integer timestamp', () => {
    const bad = [
      { value: 1, timestamp: 1.9 },
    ]
    expect(() => MetricSeriesSchema.parse({ ...valid, data_points: bad })).toThrow()
  })
})

// ─── AggregatedMetric ────────────────────────────────────────────────────────

describe('AggregatedMetricSchema', () => {
  const valid = {
    metric_name: 'http.request.latency_ms',
    unit: 'ms',
    window_start: 1_700_000_000_000,
    window_end:   1_700_000_060_000,
    count: 5,
    sum: 350,
    min: 50,
    max: 120,
    avg: 70,
    p50: 65,
    p90: 110,
  }

  it('should accept a fully-populated aggregation', () => {
    expect(() => AggregatedMetricSchema.parse(valid)).not.toThrow()
  })

  it('should accept an aggregation with no percentile fields', () => {
    const { p50, p90, ...minimal } = valid
    expect(() => AggregatedMetricSchema.parse(minimal)).not.toThrow()
  })

  it('should accept a zero-count aggregation where min equals max', () => {
    expect(() =>
      AggregatedMetricSchema.parse({ ...valid, count: 0, sum: 0, min: 0, max: 0, avg: 0 })
    ).not.toThrow()
  })

  it('should reject when window_end is before window_start', () => {
    expect(() =>
      AggregatedMetricSchema.parse({ ...valid, window_end: valid.window_start - 1 })
    ).toThrow()
  })

  it('should reject when min is greater than max and count > 0', () => {
    expect(() =>
      AggregatedMetricSchema.parse({ ...valid, min: 200, max: 50 })
    ).toThrow()
  })

  it('should reject a negative count', () => {
    expect(() => AggregatedMetricSchema.parse({ ...valid, count: -1 })).toThrow()
  })
})

// ─── ServerMetricMessage ─────────────────────────────────────────────────────

describe('ServerMetricMessageSchema', () => {
  it('should accept a metric_event message', () => {
    const msg = {
      type: 'metric_event',
      payload: { metric_name: 'cpu', value: 0.8, timestamp: 1_700_000_000_000 },
    }
    expect(() => ServerMetricMessageSchema.parse(msg)).not.toThrow()
  })

  it('should accept a metric_series message', () => {
    const msg = {
      type: 'metric_series',
      payload: {
        metric_name: 'cpu',
        data_points: [],
        window_start: 1_700_000_000_000,
        window_end: 1_700_000_060_000,
      },
    }
    expect(() => ServerMetricMessageSchema.parse(msg)).not.toThrow()
  })

  it('should accept an aggregated_metric message', () => {
    const msg = {
      type: 'aggregated_metric',
      payload: {
        metric_name: 'cpu',
        window_start: 1_700_000_000_000,
        window_end: 1_700_000_060_000,
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        avg: 0,
      },
    }
    expect(() => ServerMetricMessageSchema.parse(msg)).not.toThrow()
  })

  it('should accept an error message', () => {
    const msg = { type: 'error', payload: { code: 'NOT_FOUND', message: 'metric not found' } }
    expect(() => ServerMetricMessageSchema.parse(msg)).not.toThrow()
  })

  it('should reject an unknown type discriminant', () => {
    const msg = { type: 'unknown_type', payload: {} }
    expect(() => ServerMetricMessageSchema.parse(msg)).toThrow()
  })

  it('should reject a metric_event message with an invalid payload', () => {
    const msg = { type: 'metric_event', payload: { metric_name: '', value: 1, timestamp: 1_700_000_000_000 } }
    expect(() => ServerMetricMessageSchema.parse(msg)).toThrow()
  })
})

// ─── ClientMetricMessage ─────────────────────────────────────────────────────

describe('ClientMetricMessageSchema', () => {
  it('should accept a subscribe message', () => {
    const msg = {
      type: 'subscribe',
      payload: {
        subscription_id: 'sub-1',
        metric_name_filter: 'agent.*',
        label_filter: { env: 'prod' },
        aggregation_window_ms: 60_000,
      },
    }
    expect(() => ClientMetricMessageSchema.parse(msg)).not.toThrow()
  })

  it('should accept an unsubscribe message', () => {
    const msg = { type: 'unsubscribe', payload: { subscription_id: 'sub-1' } }
    expect(() => ClientMetricMessageSchema.parse(msg)).not.toThrow()
  })

  it('should reject a subscribe message with an empty subscription_id', () => {
    const msg = {
      type: 'subscribe',
      payload: { subscription_id: '', metric_name_filter: 'cpu' },
    }
    expect(() => ClientMetricMessageSchema.parse(msg)).toThrow()
  })

  it('should reject a subscribe message with an empty metric_name_filter', () => {
    const msg = {
      type: 'subscribe',
      payload: { subscription_id: 'sub-1', metric_name_filter: '' },
    }
    expect(() => ClientMetricMessageSchema.parse(msg)).toThrow()
  })
})

// ─── Parse helpers ────────────────────────────────────────────────────────────

describe('parseServerMessage', () => {
  it('should return a typed message on valid input', () => {
    const raw = {
      type: 'metric_event',
      payload: { metric_name: 'cpu', value: 0.5, timestamp: 1_700_000_000_000 },
    }
    const msg = parseServerMessage(raw)
    expect(msg.type).toBe('metric_event')
  })

  it('should throw on invalid input', () => {
    expect(() => parseServerMessage({ type: 'bad' })).toThrow()
  })
})

describe('parseClientMessage', () => {
  it('should return a typed message on valid input', () => {
    const raw = {
      type: 'unsubscribe',
      payload: { subscription_id: 'sub-99' },
    }
    const msg = parseClientMessage(raw)
    expect(msg.type).toBe('unsubscribe')
  })

  it('should throw on invalid input', () => {
    expect(() => parseClientMessage(null)).toThrow()
  })
})

describe('safeParseServerMessage', () => {
  it('should return the message on valid input', () => {
    const raw = {
      type: 'error',
      payload: { code: 'TIMEOUT', message: 'upstream timed out' },
    }
    expect(safeParseServerMessage(raw)).not.toBeNull()
  })

  it('should return null on invalid input without throwing', () => {
    expect(() => safeParseServerMessage({ type: 'garbage' })).not.toThrow()
    expect(safeParseServerMessage({ type: 'garbage' })).toBeNull()
  })

  it('should return null for null input', () => {
    expect(safeParseServerMessage(null)).toBeNull()
  })
})
