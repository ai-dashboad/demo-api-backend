import { z } from 'zod'

// ─── Primitive schemas ───────────────────────────────────────────────────────

/**
 * Key/value labels used to differentiate metric streams.
 * e.g. { service: "api", region: "us-east-1" }
 */
const LabelsSchema = z.record(z.string(), z.string())

// ─── MetricEvent ─────────────────────────────────────────────────────────────

/**
 * A single metric measurement emitted by the server and consumed by the client
 * over WebSocket. This is the atomic unit of the metrics pipeline.
 */
export const MetricEventSchema = z.object({
  /** Dot-namespaced metric identifier, e.g. "agent.task.duration_ms" */
  metric_name: z.string().min(1),
  /** Measured value */
  value: z.number(),
  /** Unix epoch milliseconds */
  timestamp: z.number().int().positive(),
  /** Dimensional labels for fanout/filtering */
  labels: LabelsSchema.optional(),
  /** SI unit string, e.g. "ms", "bytes", "percent" */
  unit: z.string().optional(),
})

export type MetricEvent = z.infer<typeof MetricEventSchema>

// ─── MetricSeries ─────────────────────────────────────────────────────────────

/**
 * An ordered sequence of data points for a single metric stream over a
 * bounded time window. Used when the server pushes a batch of historical or
 * buffered points (e.g. on initial WebSocket subscription).
 */
export const MetricSeriesSchema = z.object({
  metric_name: z.string().min(1),
  labels: LabelsSchema.optional(),
  unit: z.string().optional(),
  /** Ordered ascending by timestamp */
  data_points: z.array(
    z.object({
      value: z.number(),
      timestamp: z.number().int().positive(),
    })
  ),
  /** Inclusive start of the window (Unix ms) */
  window_start: z.number().int().positive(),
  /** Inclusive end of the window (Unix ms) */
  window_end: z.number().int().positive(),
}).refine(
  (s) => s.window_end >= s.window_start,
  { message: 'window_end must be >= window_start', path: ['window_end'] }
)

export type MetricSeries = z.infer<typeof MetricSeriesSchema>

// ─── AggregatedMetric ────────────────────────────────────────────────────────

/**
 * Pre-computed statistics over a metric stream for a given aggregation window.
 * Emitted by the server after rolling up raw events so clients do not need to
 * perform their own aggregation.
 */
export const AggregatedMetricSchema = z.object({
  metric_name: z.string().min(1),
  labels: LabelsSchema.optional(),
  unit: z.string().optional(),
  /** Inclusive start of the aggregation window (Unix ms) */
  window_start: z.number().int().positive(),
  /** Inclusive end of the aggregation window (Unix ms) */
  window_end: z.number().int().positive(),
  /** Number of raw events that were aggregated */
  count: z.number().int().nonnegative(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
  /** Arithmetic mean */
  avg: z.number(),
  /** 50th percentile (median) — omitted when count < 2 */
  p50: z.number().optional(),
  /** 90th percentile — omitted when count < 10 */
  p90: z.number().optional(),
  /** 99th percentile — omitted when count < 100 */
  p99: z.number().optional(),
}).refine(
  (a) => a.window_end >= a.window_start,
  { message: 'window_end must be >= window_start', path: ['window_end'] }
).refine(
  (a) => a.count === 0 || a.min <= a.max,
  { message: 'min must be <= max when count > 0', path: ['min'] }
)

export type AggregatedMetric = z.infer<typeof AggregatedMetricSchema>

// ─── WebSocket message envelope ───────────────────────────────────────────────

/**
 * Discriminated union of all messages the server can push to a client.
 * Using a `type` discriminant keeps the envelope consistent and allows
 * exhaustive switch handling on the client side.
 */
export const ServerMetricMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('metric_event'), payload: MetricEventSchema }),
  z.object({ type: z.literal('metric_series'), payload: MetricSeriesSchema }),
  z.object({ type: z.literal('aggregated_metric'), payload: AggregatedMetricSchema }),
  z.object({
    type: z.literal('error'),
    payload: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
])

export type ServerMetricMessage = z.infer<typeof ServerMetricMessageSchema>

/**
 * Subscription request sent by the client to the server.
 */
export const MetricSubscriptionSchema = z.object({
  /** Unique ID so the client can correlate acknowledgements and cancel by ID */
  subscription_id: z.string().min(1),
  /** Glob-style metric name filter, e.g. "agent.*" or "agent.task.duration_ms" */
  metric_name_filter: z.string().min(1),
  /** Optional label equality constraints */
  label_filter: LabelsSchema.optional(),
  /**
   * If set, the server will also push an AggregatedMetric on this interval
   * in addition to raw MetricEvents.
   */
  aggregation_window_ms: z.number().int().positive().optional(),
})

export type MetricSubscription = z.infer<typeof MetricSubscriptionSchema>

/**
 * Discriminated union of all messages the client can send to the server.
 */
export const ClientMetricMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), payload: MetricSubscriptionSchema }),
  z.object({
    type: z.literal('unsubscribe'),
    payload: z.object({ subscription_id: z.string().min(1) }),
  }),
])

export type ClientMetricMessage = z.infer<typeof ClientMetricMessageSchema>

// ─── Parse helpers ────────────────────────────────────────────────────────────

/**
 * Parse an unknown WebSocket message payload from the server.
 * Throws a ZodError on invalid shape — callers should handle and close the
 * connection or emit a warning rather than crashing.
 */
export function parseServerMessage(raw: unknown): ServerMetricMessage {
  return ServerMetricMessageSchema.parse(raw)
}

/**
 * Parse an unknown WebSocket message payload from the client.
 * Throws a ZodError on invalid shape.
 */
export function parseClientMessage(raw: unknown): ClientMetricMessage {
  return ClientMetricMessageSchema.parse(raw)
}

/**
 * Safe variant — returns null instead of throwing.
 * Useful in fire-and-forget consumers where a bad frame should be logged
 * and skipped rather than crashing the subscription loop.
 */
export function safeParseServerMessage(raw: unknown): ServerMetricMessage | null {
  const result = ServerMetricMessageSchema.safeParse(raw)
  return result.success ? result.data : null
}
