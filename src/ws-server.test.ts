import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket as WsClient } from 'ws'
import { MetricBroadcaster, MetricWebSocketServer } from './ws-server.js'
import type { MetricData, ServerMessage } from './types/metrics.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockClient(overrides: { readyState?: number } = {}) {
  const sent: string[] = []
  return {
    isAlive:       true,
    subscriptions: new Set<string>(),
    readyState:    overrides.readyState ?? 1, // 1 = WebSocket.OPEN
    send(payload: string) { sent.push(payload) },
    _sent: sent,
  }
}

type MockClient = ReturnType<typeof mockClient>

function connectClient(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}`)
    ws.once('open',  ()    => resolve(ws))
    ws.once('error', (err) => reject(err))
  })
}

function nextMessage(ws: WsClient): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try { resolve(JSON.parse(data.toString()) as ServerMessage) }
      catch (e) { reject(e) }
    })
    ws.once('error', reject)
  })
}

function closeClient(ws: WsClient): Promise<void> {
  return new Promise(resolve => {
    if (ws.readyState === WsClient.CLOSED) return resolve()
    ws.once('close', resolve)
    ws.close()
  })
}

const SAMPLE_METRIC: MetricData = {
  value:    88.5,
  labels:   { host: 'web-1' },
  metadata: { unit: 'percent' },
}

// ── MetricBroadcaster unit tests ──────────────────────────────────────────────

describe('MetricBroadcaster', () => {
  let broadcaster: MetricBroadcaster
  let clientA: MockClient
  let clientB: MockClient

  beforeEach(() => {
    broadcaster = new MetricBroadcaster()
    clientA     = mockClient()
    clientB     = mockClient()
  })

  describe('subscribe', () => {
    it('should add client to the stream subscriber set', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      expect(broadcaster.subscriberCount('cpu.usage')).toBe(1)
      expect(clientA.subscriptions.has('cpu.usage')).toBe(true)
    })

    it('should allow multiple clients to subscribe to the same stream', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.subscribe(clientB as any, 'cpu.usage')
      expect(broadcaster.subscriberCount('cpu.usage')).toBe(2)
    })

    it('should allow one client to subscribe to multiple streams', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.subscribe(clientA as any, 'mem.usage')
      expect(clientA.subscriptions.size).toBe(2)
      expect(broadcaster.streamCount()).toBe(2)
    })
  })

  describe('unsubscribe', () => {
    it('should remove client from the stream and decrement subscriber count', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.unsubscribe(clientA as any, 'cpu.usage')
      expect(broadcaster.subscriberCount('cpu.usage')).toBe(0)
    })

    it('should remove an empty stream from the internal map', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.unsubscribe(clientA as any, 'cpu.usage')
      expect(broadcaster.streamCount()).toBe(0)
    })

    it('should be idempotent when the client is not subscribed', () => {
      expect(() => broadcaster.unsubscribe(clientA as any, 'nonexistent')).not.toThrow()
    })
  })

  describe('removeClient', () => {
    it('should remove the client from all subscribed streams', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.subscribe(clientA as any, 'mem.usage')
      broadcaster.removeClient(clientA as any)
      expect(broadcaster.subscriberCount('cpu.usage')).toBe(0)
      expect(broadcaster.subscriberCount('mem.usage')).toBe(0)
      expect(broadcaster.streamCount()).toBe(0)
    })

    it('should not affect other subscribers on shared streams', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.subscribe(clientB as any, 'cpu.usage')
      broadcaster.removeClient(clientA as any)
      expect(broadcaster.subscriberCount('cpu.usage')).toBe(1)
    })
  })

  describe('broadcast', () => {
    it('should deliver the update to all OPEN subscribers', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.subscribe(clientB as any, 'cpu.usage')
      const sent = broadcaster.broadcast('cpu.usage', SAMPLE_METRIC)
      expect(sent).toBe(2)
      expect(clientA._sent).toHaveLength(1)
      expect(clientB._sent).toHaveLength(1)
    })

    it('should include type, stream, data, and an ISO timestamp in the payload', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.broadcast('cpu.usage', SAMPLE_METRIC)
      const msg = JSON.parse(clientA._sent[0]) as ServerMessage
      expect(msg.type).toBe('update')
      if (msg.type === 'update') {
        expect(msg.stream).toBe('cpu.usage')
        expect(msg.data).toEqual(SAMPLE_METRIC)
        expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      }
    })

    it('should not deliver to clients subscribed to a different stream', () => {
      broadcaster.subscribe(clientA as any, 'cpu.usage')
      broadcaster.subscribe(clientB as any, 'mem.usage')
      broadcaster.broadcast('cpu.usage', SAMPLE_METRIC)
      expect(clientB._sent).toHaveLength(0)
    })

    it('should skip clients whose readyState is not OPEN', () => {
      const closedClient = mockClient({ readyState: 3 }) // 3 = CLOSED
      broadcaster.subscribe(closedClient as any, 'cpu.usage')
      expect(broadcaster.broadcast('cpu.usage', SAMPLE_METRIC)).toBe(0)
    })

    it('should return 0 when no subscribers exist for the stream', () => {
      expect(broadcaster.broadcast('no.one.here', SAMPLE_METRIC)).toBe(0)
    })
  })
})

// ── MetricWebSocketServer integration tests ───────────────────────────────────

describe('MetricWebSocketServer', () => {
  let server: MetricWebSocketServer
  let port:   number

  beforeEach(async () => {
    server = new MetricWebSocketServer() // no NATS in tests
    await server.listen(0)              // 0 = OS-assigned port avoids conflicts
    port = server.address().port
  })

  afterEach(async () => {
    await server.close()
  })

  it('should accept WebSocket connections', async () => {
    const ws = await connectClient(port)
    expect(ws.readyState).toBe(WsClient.OPEN)
    await closeClient(ws)
  })

  it('should acknowledge a subscribe message with subscriber_count', async () => {
    const ws = await connectClient(port)
    ws.send(JSON.stringify({ type: 'subscribe', stream: 'cpu.usage' }))
    const msg = await nextMessage(ws)
    expect(msg.type).toBe('subscribed')
    if (msg.type === 'subscribed') {
      expect(msg.stream).toBe('cpu.usage')
      expect(msg.subscriber_count).toBe(1)
    }
    await closeClient(ws)
  })

  it('should deliver broadcast updates to subscribed clients', async () => {
    const ws = await connectClient(port)
    ws.send(JSON.stringify({ type: 'subscribe', stream: 'cpu.usage' }))
    await nextMessage(ws) // consume the subscribed ack

    server.broadcast('cpu.usage', SAMPLE_METRIC)

    const update = await nextMessage(ws)
    expect(update.type).toBe('update')
    if (update.type === 'update') {
      expect(update.stream).toBe('cpu.usage')
      expect(update.data).toEqual(SAMPLE_METRIC)
    }
    await closeClient(ws)
  })

  it('should not deliver updates for unsubscribed streams', async () => {
    const ws = await connectClient(port)
    ws.send(JSON.stringify({ type: 'subscribe', stream: 'cpu.usage' }))
    await nextMessage(ws) // subscribed ack

    server.broadcast('mem.usage', SAMPLE_METRIC) // different stream

    const result = await Promise.race([
      nextMessage(ws),
      new Promise<null>(r => setTimeout(() => r(null), 150)),
    ])
    expect(result).toBeNull()
    await closeClient(ws)
  })

  it('should stop delivering updates after unsubscribe', async () => {
    const ws = await connectClient(port)
    ws.send(JSON.stringify({ type: 'subscribe', stream: 'cpu.usage' }))
    await nextMessage(ws)

    ws.send(JSON.stringify({ type: 'unsubscribe', stream: 'cpu.usage' }))
    const unsubMsg = await nextMessage(ws)
    expect(unsubMsg.type).toBe('unsubscribed')
    if (unsubMsg.type === 'unsubscribed') expect(unsubMsg.subscriber_count).toBe(0)

    server.broadcast('cpu.usage', SAMPLE_METRIC)
    const result = await Promise.race([
      nextMessage(ws),
      new Promise<null>(r => setTimeout(() => r(null), 150)),
    ])
    expect(result).toBeNull()
    await closeClient(ws)
  })

  it('should respond to ping with pong', async () => {
    const ws = await connectClient(port)
    ws.send(JSON.stringify({ type: 'ping' }))
    const msg = await nextMessage(ws)
    expect(msg.type).toBe('pong')
    await closeClient(ws)
  })

  it('should return PARSE_ERROR for invalid JSON', async () => {
    const ws = await connectClient(port)
    ws.send('not json at all')
    const msg = await nextMessage(ws)
    expect(msg.type).toBe('error')
    if (msg.type === 'error') expect(msg.code).toBe('PARSE_ERROR')
    await closeClient(ws)
  })

  it('should return UNKNOWN_TYPE for an unrecognised message type', async () => {
    const ws = await connectClient(port)
    ws.send(JSON.stringify({ type: 'teleport' }))
    const msg = await nextMessage(ws)
    expect(msg.type).toBe('error')
    if (msg.type === 'error') expect(msg.code).toBe('UNKNOWN_TYPE')
    await closeClient(ws)
  })

  it('should return INVALID_STREAM for a stream name containing path traversal', async () => {
    const ws = await connectClient(port)
    ws.send(JSON.stringify({ type: 'subscribe', stream: '../../etc/passwd' }))
    const msg = await nextMessage(ws)
    expect(msg.type).toBe('error')
    if (msg.type === 'error') expect(msg.code).toBe('INVALID_STREAM')
    await closeClient(ws)
  })

  it('should return MSG_TOO_LARGE for a payload exceeding 64 KB', async () => {
    const ws = await connectClient(port)
    ws.send(Buffer.alloc(65 * 1024, 'x'))
    const msg = await nextMessage(ws)
    expect(msg.type).toBe('error')
    if (msg.type === 'error') expect(msg.code).toBe('MSG_TOO_LARGE')
    await closeClient(ws)
  })

  it('should broadcast to multiple subscribers on the same stream', async () => {
    const [ws1, ws2] = await Promise.all([connectClient(port), connectClient(port)])

    ws1.send(JSON.stringify({ type: 'subscribe', stream: 'net.rx' }))
    ws2.send(JSON.stringify({ type: 'subscribe', stream: 'net.rx' }))
    await Promise.all([nextMessage(ws1), nextMessage(ws2)]) // subscribed acks

    const sent = server.broadcast('net.rx', SAMPLE_METRIC)
    expect(sent).toBe(2)

    const [m1, m2] = await Promise.all([nextMessage(ws1), nextMessage(ws2)])
    expect(m1.type).toBe('update')
    expect(m2.type).toBe('update')

    await Promise.all([closeClient(ws1), closeClient(ws2)])
  })

  it('should clean up subscriptions when a client disconnects', async () => {
    const ws = await connectClient(port)
    ws.send(JSON.stringify({ type: 'subscribe', stream: 'disk.io' }))
    await nextMessage(ws)

    await closeClient(ws)
    // Give the server one event-loop tick to process the close event
    await new Promise(r => setTimeout(r, 20))

    // A broadcast to the now-dead stream should reach 0 clients
    expect(server.broadcast('disk.io', SAMPLE_METRIC)).toBe(0)
  })
})
