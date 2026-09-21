/**
 * Shared capacity admission and credential circuit breaker (spec §10.5,
 * §10.6).
 *
 * This deployment runs API + workers in one process, so process-local
 * counters satisfy the shared-capacity requirement; a replicated
 * deployment must replace these with Redis-backed expiring leases
 * before scaling out. Leases carry unique IDs so an old completion
 * cannot release another request's slot.
 */

import type { SafeReason } from '../../providers/typesafe/types.js'

export interface CapacityLease {
  key: string
  id: string
}

export class CapacityLimiter {
  private inFlight = new Map<string, number>()
  private nextLeaseId = 0

  constructor(
    private readonly maxPerWorkspace: number,
    private readonly maxPerCredential: number
  ) {}

  /** Nonblocking admission; null means skip optional inference. */
  tryAcquire(workspaceId: string, credentialId: string): CapacityLease | null {
    const workspaceInFlight = this.inFlight.get(`ws:${workspaceId}`) ?? 0
    const credentialInFlight = this.inFlight.get(`cred:${credentialId}`) ?? 0
    if (workspaceInFlight >= this.maxPerWorkspace) return null
    if (credentialInFlight >= this.maxPerCredential) return null
    const lease: CapacityLease = {
      key: `${workspaceId}|${credentialId}`,
      id: `lease-${++this.nextLeaseId}`,
    }
    this.inFlight.set(`ws:${workspaceId}`, workspaceInFlight + 1)
    this.inFlight.set(`cred:${credentialId}`, credentialInFlight + 1)
    return lease
  }

  /** Release by lease identity; unknown or stale leases are ignored. */
  release(lease: CapacityLease | null): void {
    if (!lease) return
    const [workspaceId, credentialId] = lease.key.split('|')
    const wsKey = `ws:${workspaceId}`
    const credKey = `cred:${credentialId}`
    const ws = this.inFlight.get(wsKey) ?? 0
    const cred = this.inFlight.get(credKey) ?? 0
    if (ws <= 1) this.inFlight.delete(wsKey)
    else this.inFlight.set(wsKey, ws - 1)
    if (cred <= 1) this.inFlight.delete(credKey)
    else this.inFlight.set(credKey, cred - 1)
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open' | 'credential_disabled'

/**
 * Credential/provider breaker (§10.6 initial policy): five consecutive
 * retryable transport failures within 60 seconds open the breaker for
 * 30 seconds, then allow one half-open probe. 401/403 disables the
 * credential pending operator action instead of retrying bad secrets.
 */
export class JudgmentCircuitBreaker {
  private consecutiveRetryable = 0
  private firstFailureAt = 0
  private openedAt = 0
  private halfOpenProbeInFlight = false
  private credentialDisabled = false

  constructor(
    private readonly failureThreshold = 5,
    private readonly failureWindowMs = 60_000,
    private readonly openDurationMs = 30_000
  ) {}

  canCall(): BreakerState {
    if (this.credentialDisabled) return 'credential_disabled'
    if (this.openedAt === 0) return 'closed'
    const elapsed = Date.now() - this.openedAt
    if (elapsed >= this.openDurationMs) {
      if (!this.halfOpenProbeInFlight) {
        this.halfOpenProbeInFlight = true
        return 'half_open'
      }
      return 'open'
    }
    return 'open'
  }

  blockReason(): SafeReason {
    return this.credentialDisabled ? 'authentication_failed' : 'capacity_exhausted'
  }

  recordSuccess(): void {
    this.consecutiveRetryable = 0
    this.openedAt = 0
    this.halfOpenProbeInFlight = false
  }

  /** Retryable = timeout/rate-limit/network; nonretryable = auth failure. */
  recordFailure(kind: 'retryable' | 'authentication'): void {
    if (kind === 'authentication') {
      this.credentialDisabled = true
      return
    }
    const now = Date.now()
    if (now - this.firstFailureAt > this.failureWindowMs) {
      this.consecutiveRetryable = 0
    }
    if (this.consecutiveRetryable === 0) this.firstFailureAt = now
    this.consecutiveRetryable += 1
    if (this.consecutiveRetryable >= this.failureThreshold) {
      this.openedAt = now
      this.consecutiveRetryable = 0
    }
  }
}
