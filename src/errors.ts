/**
 * v2 error shape (spec §15.5): stable machine code, safe message,
 * retryable flag, request id.
 */

import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'

export class V2Error extends Error {
  status: number
  code: string
  retryable: boolean

  constructor(status: number, code: string, message: string, retryable?: boolean) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable ?? status >= 500
  }
}

export const badRequest = (code: string, message: string) =>
  new V2Error(400, code, message, false)
export const unauthorized = (message = 'Authentication required.') =>
  new V2Error(401, 'UNAUTHENTICATED', message, false)
export const forbidden = (message = 'This action requires the editor role.') =>
  new V2Error(403, 'FORBIDDEN', message, false)
export const notFound = (message = 'Resource not found.') =>
  new V2Error(404, 'NOT_FOUND', message, false)
export const conflict = (code: string, message: string) =>
  new V2Error(409, code, message, false)

export function requestIds(): { requestId: (c: Context) => string } {
  return {
    requestId: (c) => c.get('requestId') ?? randomUUID(),
  }
}

export function errorHandler(err: unknown, c: Context) {
  const requestId = c.get('requestId') ?? randomUUID()
  if (err instanceof V2Error) {
    c.header('x-request-id', requestId)
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          requestId,
        },
      },
      err.status as 400
    )
  }
  // Safe 5xx: no stack traces or provider details leak.
  console.error('[unhandled]', err)
  return c.json(
    {
      error: {
        code: 'INTERNAL',
        message: 'An internal error occurred.',
        retryable: true,
        requestId,
      },
    },
    500
  )
}
