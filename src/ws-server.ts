import { createServer, type AddressInfo } from 'node:http'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { NatsConnection } from 'nats'
import type { ClientMessage, MetricData, ServerMessage } from './types/metrics.js'

// Idle-connection pruning interval — must be shorter than any upstream LB timeout
const HEARTBEAT_INTERVAL_MS = 30_000
// Guard against clients that send oversized payloads to inflate heap usage
const MAX_MESSAGE_BYTES = 64 * 1024 // 64 KB

// WebSocket augmented with per-connection tracking state
interface TrackedClient extends WebSocket {
  isAlive:       boolean
  subscriptions: Set<string>
}

/**
 * Pure subscription/broadcast logic with no network I/O.
 * Kept separate so it can be unit-tested without spinning up a real server.
 */
export class MetricBroadcaster {
  // stream name → set of subscribed clients
  private readonly streams = new Map<string, Set<TrackedClient>>()

  subscribe(client: TrackedClient, stream: string): void {
    if (!this.streams.has(stream)) {
      this.streams.set(stream, new Set())
    }
    this.streams.get(stream)!.add(client)
    client.subscriptions.add(stream)
  }

  unsubscribe(client: TrackedClient, stream: string): void {
    const subscribers = this.streams.get(stream)
    if (subscribers) {
      subscribers.delete(client)
      // Remove empty buckets to avoid unbounded map growth
      if (subscribers.size === 0) this.streams.delete(stream)
    }
    client.subscriptions.delete(stream)
  }

  /** Remove a client from every stream it joined — call on disconnect. */
  removeClient(client: TrackedClient): void {
    for (const stream of client.subscriptions) {
      const subscribers = this.streams.get(stream)
      if (subscribers) {
        subscribers.delete(client)
        if (subscribers.size === 0) this.streams.delete(stream)
      }
    }
    client.subscriptions.clear()
  }

  /**
   * Fan out a metric update to all OPEN subscribers of the stream.
   * Returns the number of clients that were sent the message.
   */
  broadcast(stream: string, data: MetricData): number {
    const subscribers = this.streams.get(stream)
    if (!subscribers || subscribers.size === 0) return 0

    const message: ServerMessage = {
      type:      'update',
      stream,
      data,
      timestamp: new Date().toISOString(),
    }
    const payload = JSON.stringify(message)
    let sent = 0

    for (const client of subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
        sent++
      }
    }
    return sent
  }

  subscriberCount(stream: string): number {
    return this.streams.get(stream)?.size ?? 0
  }

  streamCount(): number {
    return this.streams.size
  }
}

/** WebSocket server that manages per-stream metric subscriptions and broadcasts. */
export class MetricWebSocketServer {
  private readonly broadcaster = new MetricBroadcaster()
  private readonly httpServer  = createServer()
  private readonly wss         = new WebSocketServer({ server: this.httpServer })
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly nc?: NatsConnection) {
    this.wss.on('connection', (socket, req) =>
      this.handleConnection(socket as TrackedClient, req)
    )
  }

  /** Bind to the given port. Resolves once the socket is ready to accept connections. */
  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject)
      this.httpServer.listen(port, () => {
        this.httpServer.off('error', reject)
        this.startHeartbeat()
        if (this.nc) this.attachNats(this.nc)
        resolve()
      })
    })
  }

  /** Gracefully close all connections, then shut down the underlying HTTP server. */
  close(): Promise<void> {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    // Send a standard going-away close frame before the server drops the sockets
    for (const raw of this.wss.clients) {
      raw.close(1001, 'Server shutting down')
    }

    return new Promise((resolve, reject) =>
      this.wss.close(err => (err ? reject(err) : resolve()))
    )
  }

  /** Address of the bound server — only valid after listen() resolves. */
  address(): AddressInfo {
    return this.httpServer.address() as AddressInfo
  }

  /** Push a metric update directly (e.g. forwarded from a NATS message). */
  broadcast(stream: string, data: MetricData): number {
    return this.broadcaster.broadcast(stream, data)
  }

  private handleConnection(
    client: TrackedClient,
    req: import('node:http').IncomingMessage,
  ): void {
    client.isAlive       = true
    client.subscriptions = new Set()

    const remote = req.socket.remoteAddress ?? 'unknown'
    console.log(`[ws-server] Connected: ${remote}`)

    // Reset liveness flag on each pong so the heartbeat knows the client is alive
    client.on('pong', () => { client.isAlive = true })

    client.on('message', (raw: RawData) => {
      // Normalise to a single Buffer regardless of the underlying framing
      const buf = Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw instanceof ArrayBuffer ? raw : Buffer.concat(raw as Buffer[]))

      if (buf.length > MAX_MESSAGE_BYTES) {
        this.send(client, { type: 'error', message: 'Message exceeds 64 KB limit', code: 'MSG_TOO_LARGE' })
        return
      }

      this.handleMessage(client, buf.toString('utf8'))
    })

    client.on('close', (code, reason) => {
      console.log(`[ws-server] Disconnected: ${remote} (${code} ${reason.toString()})`)
      this.broadcaster.removeClient(client)
    })

    // Socket errors are non-fatal — 'close' fires immediately after and handles cleanup
    client.on('error', (err: Error) => {
      console.error(`[ws-server] Socket error (${remote}):`, err.message)
    })
  }

  private handleMessage(client: TrackedClient, raw: string): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw) as ClientMessage
    } catch {
      this.send(client, { type: 'error', message: 'Invalid JSON payload', code: 'PARSE_ERROR' })
      return
    }

    switch (msg.type) {
      case 'subscribe': {
        if (!isValidStream(msg.stream)) {
          this.send(client, {
            type:    'error',
            message: `Invalid stream name: "${String(msg.stream)}"`,
            code:    'INVALID_STREAM',
          })
          return
        }
        this.broadcaster.subscribe(client, msg.stream)
        this.send(client, {
          type:             'subscribed',
          stream:           msg.stream,
          subscriber_count: this.broadcaster.subscriberCount(msg.stream),
        })
        break
      }

      case 'unsubscribe': {
        this.broadcaster.unsubscribe(client, msg.stream)
        this.send(client, {
          type:             'unsubscribed',
          stream:           msg.stream,
          subscriber_count: this.broadcaster.subscriberCount(msg.stream),
        })
        break
      }

      case 'ping': {
        this.send(client, { type: 'pong' })
        break
      }

      default: {
        // Safe cast — msg.type is `never` here statically but can be any string at runtime
        const unknownType = (msg as unknown as { type: string }).type
        this.send(client, {
          type:    'error',
          message: `Unknown message type: "${unknownType}"`,
          code:    'UNKNOWN_TYPE',
        })
      }
    }
  }

  private send(client: TrackedClient, msg: ServerMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg))
    }
  }

  // Ping every connected client; terminate any that have not responded since the last ping.
  // This detects half-open TCP connections that will never produce a 'close' event.
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const raw of this.wss.clients) {
        const client = raw as TrackedClient
        if (!client.isAlive) {
          this.broadcaster.removeClient(client)
          client.terminate()
          continue
        }
        client.isAlive = false
        client.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)

    // Unref so the timer does not keep the process alive during tests or clean shutdown
    this.heartbeatTimer.unref()
  }

  // Subscribe to the NATS wildcard subject and fan out updates to WebSocket subscribers.
  // Subject format: dev.metrics.<stream-name>
  private attachNats(nc: NatsConnection): void {
    const sub = nc.subscribe('dev.metrics.>')
    ;(async () => {
      for await (const msg of sub) {
        try {
          const data   = JSON.parse(new TextDecoder().decode(msg.data)) as MetricData
          const stream = msg.subject.slice('dev.metrics.'.length)
          this.broadcaster.broadcast(stream, data)
        } catch (err) {
          console.error('[ws-server] Failed to parse NATS metric message:', err)
        }
      }
    })()
  }
}

// Stream names must begin with an alphanumeric character, then allow dots/hyphens/underscores,
// and be capped at 128 characters. Rejects path-traversal attempts like "../../etc/passwd".
function isValidStream(stream: unknown): stream is string {
  return typeof stream === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(stream)
}
