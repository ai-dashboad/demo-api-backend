import { RingBuffer } from './ring-buffer.js'
import {
  MetricSampleInputSchema,
  type AggregateFunction,
  type AggregateResult,
  type MetricLabels,
  type MetricQuery,
  type MetricSample,
  type MetricSampleInput,
} from './types.js'

export interface MetricStoreOptions {
  /** Max samples kept in memory. Oldest are dropped when exceeded. Default: 50_000 */
  capacity?: number
}

/**
 * In-memory time-series store backed by a ring buffer.
 *
 * Chosen over InfluxDB/TimescaleDB for the MVP because it requires zero
 * infrastructure and the agent-runtime already runs in a constrained
 * environment. The interface is designed so a TimescaleDB adapter can be
 * swapped in behind the same API once query volumes justify it.
 */
export class MetricStore {
  private readonly buffer: RingBuffer

  constructor(options: MetricStoreOptions = {}) {
    this.buffer = new RingBuffer(options.capacity ?? 50_000)
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Record a metric sample. Timestamp defaults to now.
   * Throws a ZodError if the input fails validation.
   */
  record(input: MetricSampleInput): MetricSample {
    const parsed = MetricSampleInputSchema.parse(input)
    const sample: MetricSample = {
      ...parsed,
      timestamp: parsed.timestamp ?? new Date(),
    }
    this.buffer.push(sample)
    return sample
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Query samples with optional name, time-range, and label filters.
   * Results are returned newest-first.
   */
  query(q: MetricQuery = {}): MetricSample[] {
    let samples = this.buffer.toArray()

    if (q.metric_name !== undefined) {
      samples = samples.filter(s => s.metric_name === q.metric_name)
    }
    if (q.from !== undefined) {
      const from = q.from
      samples = samples.filter(s => s.timestamp >= from)
    }
    if (q.to !== undefined) {
      const to = q.to
      samples = samples.filter(s => s.timestamp <= to)
    }
    if (q.labels !== undefined) {
      const filterLabels = q.labels
      samples = samples.filter(s => labelsMatch(s.labels, filterLabels))
    }

    // Newest-first to match typical dashboard/API expectations
    samples.reverse()

    if (q.limit !== undefined && q.limit > 0) {
      samples = samples.slice(0, q.limit)
    }

    return samples
  }

  /**
   * Compute a single aggregate statistic over a filtered set of samples.
   * Returns null when there are no matching samples.
   */
  aggregate(
    metric_name: string,
    fn: AggregateFunction,
    filter: Omit<MetricQuery, 'metric_name' | 'limit'> = {},
  ): AggregateResult | null {
    const samples = this.query({ ...filter, metric_name })
    if (samples.length === 0) return null

    const values = samples.map(s => s.value)
    const timestamps = samples.map(s => s.timestamp)

    return {
      metric_name,
      fn,
      value:        computeAggregate(values, fn),
      sample_count: samples.length,
      from:         min(timestamps),
      to:           max(timestamps),
    }
  }

  /** Number of samples currently in the buffer. */
  get size(): number {
    return this.buffer.size
  }

  /** Wipe all stored samples — useful in tests. */
  clear(): void {
    this.buffer.clear()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function labelsMatch(sample: MetricLabels, filter: MetricLabels): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (sample[k] !== v) return false
  }
  return true
}

function computeAggregate(values: number[], fn: AggregateFunction): number {
  switch (fn) {
    case 'count': return values.length
    case 'sum':   return values.reduce((a, b) => a + b, 0)
    case 'min':   return Math.min(...values)
    case 'max':   return Math.max(...values)
    case 'avg':   return values.reduce((a, b) => a + b, 0) / values.length
    case 'p95':   return percentile(values, 0.95)
    case 'p99':   return percentile(values, 0.99)
  }
}

/** Nearest-rank percentile. Sorts a copy — does not mutate the input. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  // Clamp to valid index range
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1)
  return sorted[idx] as number
}

function min(dates: Date[]): Date | null {
  if (dates.length === 0) return null
  return dates.reduce((a, b) => (a < b ? a : b))
}

function max(dates: Date[]): Date | null {
  if (dates.length === 0) return null
  return dates.reduce((a, b) => (a > b ? a : b))
}
