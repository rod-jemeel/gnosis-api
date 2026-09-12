/**
 * Identity boundary (spec §4.2): verified tokens only. A workspace path
 * is a requested scope, never proof of membership — the tenant context
 * is constructed after identity AND membership checks.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import type { Context, Next } from 'hono'
import { config } from './config.js'
import { unauthorized } from './errors.js'

export interface Identity {
  userId: string
  email: string | null
}

const LOCAL_IDENTITY: Identity = { userId: 'dev-user', email: 'dev@localhost' }

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
if (config.AUTH_MODE === 'supabase' && config.SUPABASE_JWKS_URL) {
  jwks = createRemoteJWKSet(new URL(config.SUPABASE_JWKS_URL))
}

const encoder = new TextEncoder()

async function verifyToken(token: string): Promise<JWTPayload> {
  if (config.AUTH_MODE === 'local') return {}
  if (config.SUPABASE_JWT_SECRET) {
    return jwtVerify(token, encoder.encode(config.SUPABASE_JWT_SECRET), {
      algorithms: ['HS256'],
      ...(config.SUPABASE_ISSUER ? { issuer: config.SUPABASE_ISSUER } : {}),
    }).then((r) => r.payload)
  }
  if (jwks) {
    return jwtVerify(token, jwks, {
      algorithms: ['ES256', 'RS256'],
      ...(config.SUPABASE_ISSUER ? { issuer: config.SUPABASE_ISSUER } : {}),
    }).then((r) => r.payload)
  }
  throw unauthorized('Authentication is misconfigured.')
}

export async function identify(c: Context, next: Next) {
  if (config.AUTH_MODE === 'local') {
    c.set('identity', LOCAL_IDENTITY)
    await next()
    return
  }
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) throw unauthorized()
  try {
    const payload = await verifyToken(header.slice(7))
    const userId = payload.sub
    if (!userId) throw unauthorized('Token has no subject.')
    const email =
      typeof payload.email === 'string' ? payload.email : (payload.user_metadata as { email?: string } | undefined)?.email ?? null
    c.set('identity', { userId, email })
    await next()
  } catch (err) {
    if (err && typeof err === 'object' && 'expired' in err) {
      throw unauthorized('Token expired; sign in again.')
    }
    throw unauthorized('Invalid access token.')
  }
}

/**
 * Tenant context (spec §4.2): resolved from verified membership in the
 * workspace, never from client-supplied roles.
 */
export interface TenantContext {
  workspaceId: string
  userId: string
  role: 'owner' | 'editor' | 'viewer'
}

declare module 'hono' {
  interface ContextVariableMap {
    identity: Identity
    tenant: TenantContext
    requestId: string
  }
}
