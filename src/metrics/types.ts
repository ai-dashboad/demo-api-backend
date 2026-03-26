import { z } from 'zod'

// Supported units — extensible via union expansion, not a free string,
// so dashboards and aggregation logic can make unit-aware decisions.
export const MetricUnitSchema = z.enum([
  'ms',               // milliseconds (latency, duration)
  'bytes',            // memory, payload size
  'count',            // events, items
  'percent',          // utilisation, error rate
  'requests_per_sec', // throughput
  'errors_per_sec',   // error rate
  'seconds',          // coarse durations
])

export type MetricUnit = z.infer<typeof MetricUnitSchema>

// Labels are string→string pairs for slicing/dicing — same model as
// Prometheus labels. Kept flat so ring-buffer serialisation stays cheap.
export const MetricLabelsSchema = z.record(z.string(), z.string())
export type MetricLabels = z.infer<typeof MetricLabelsSchema>

export const MetricSampleSchema = z.object({
  metric_name: z.string().min(1).max(255),
  value:       z.number().finite(),
  unit:        MetricUnitSchema,
  timestamp:   z.date(),
  labels:      MetricLabelsSchema.default({}),
})

export type MetricSample = z.infer<typeof MetricSampleSchema>

// Input type — timestamp defaults to now when omitted
export const MetricSampleInputSchema = MetricSampleSchema.extend({
  timestamp: z.date().optional(),
})

export type MetricSampleInput = z.infer<typeof MetricSampleInputSchema>

// Query filters passed to MetricStore.query()
export interface MetricQuery {
  metric_name?: string
  /** inclusive lower bound */
  from?:        Date
  /** inclusive upper bound */
  to?:          Date
  /** all provided labels must match exactly */
  labels?:      MetricLabels
  /** max samples to return, applied after filtering, newest-first */
  limit?:       number
}

export type AggregateFunction = 'avg' | 'min' | 'max' | 'sum' | 'count' | 'p95' | 'p99'

export interface AggregateResult {
  metric_name:  string
  fn:           AggregateFunction
  value:        number
  sample_count: number
  from:         Date | null
  to:           Date | null
}
