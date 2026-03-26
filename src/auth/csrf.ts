import { randomBytes } from 'crypto'

const STATE_TTL_MS = 10 * 60 * 1_000 // 10 minutes

// In-memory store: state token → expiry epoch ms.
// Tokens are single-use: consumed on first validation attempt.
// For a multi-instance deployment, replace this with a Redis-backed store.
const pendingStates = new Map<string, number>()

export function generateCsrfState(): string {
  const state = randomBytes(32).toString('hex')
  pendingStates.set(state, Date.now() + STATE_TTL_MS)
  return state
}

/**
 * Returns true and removes the state if it exists and has not expired.
 * Always returns false (and removes the state if present) on reuse,
 * making states single-use regardless of outcome.
 */
export function validateCsrfState(state: string): boolean {
  const expiry = pendingStates.get(state)
  // Always delete so replayed states are always rejected
  pendingStates.delete(state)
  if (expiry === undefined) return false
  return Date.now() < expiry
}

/** Exposed for test teardown only — do not call in production code. */
export function clearPendingStates(): void {
  pendingStates.clear()
}
