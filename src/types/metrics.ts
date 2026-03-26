export interface MetricData {
  value:    number
  labels:   Record<string, string>
  metadata: Record<string, unknown>
}

// Messages clients send to the server
export type ClientMessage =
  | { type: 'subscribe';   stream: string }
  | { type: 'unsubscribe'; stream: string }
  | { type: 'ping' }

// Messages the server sends to clients
export type ServerMessage =
  | { type: 'update';       stream: string; data: MetricData; timestamp: string }
  | { type: 'subscribed';   stream: string; subscriber_count: number }
  | { type: 'unsubscribed'; stream: string; subscriber_count: number }
  | { type: 'pong' }
  | { type: 'error';        message: string; code: string }
