// Server-only helpers for Netlify Functions. NEVER import this from the browser.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import jwt from 'jsonwebtoken'

let _db: SupabaseClient | null = null
export function db(): SupabaseClient {
  if (_db) return _db
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured')
  _db = createClient(url, key, { auth: { persistSession: false } })
  return _db
}

export interface AuthedUser { id: string; username: string }

export function issueToken(u: AuthedUser): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 16) throw new Error('JWT_SECRET is not configured (needs 16+ chars)')
  return jwt.sign({ sub: u.id, username: u.username }, secret, { expiresIn: '30d' })
}

export function requireUser(headers: Record<string, string | undefined>): AuthedUser {
  const auth = headers.authorization || headers.Authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) throw new HttpError(401, 'Please log in first.')
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload
    return { id: String(payload.sub), username: String(payload.username) }
  } catch {
    throw new HttpError(401, 'Session expired. Please log in again.')
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  }
}

export async function readBody(event: { body: string | null; isBase64Encoded?: boolean }): Promise<Record<string, unknown>> {
  if (!event.body) return {}
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  try { return JSON.parse(raw) } catch { throw new HttpError(400, 'Invalid JSON body.') }
}

/** Fixed-window rate limit backed by Postgres. Returns true if allowed. */
export async function rateLimit(key: string, max: number, windowSec: number): Promise<boolean> {
  const supa = db()
  const windowStart = new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000).toISOString()
  const { data } = await supa.from('rate_limits').select('count').eq('key', key).eq('window_start', windowStart).maybeSingle()
  if (!data) {
    await supa.from('rate_limits').insert({ key, window_start: windowStart, count: 1 })
    return true
  }
  if (data.count >= max) return false
  await supa.from('rate_limits').update({ count: data.count + 1 }).eq('key', key).eq('window_start', windowStart)
  return true
}

export function clientIp(headers: Record<string, string | undefined>): string {
  return (headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || 'unknown').split(',')[0].trim()
}

/** Users the given user must not see / interact with (either direction of a block). */
export async function blockedIds(userId: string): Promise<string[]> {
  const supa = db()
  const [{ data: a }, { data: b }] = await Promise.all([
    supa.from('blocks').select('blocked_id').eq('blocker_id', userId),
    supa.from('blocks').select('blocker_id').eq('blocked_id', userId),
  ])
  const ids = new Set<string>()
  a?.forEach((r) => ids.add(r.blocked_id))
  b?.forEach((r) => ids.add(r.blocker_id))
  return [...ids]
}
