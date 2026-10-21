// Shared validation + helpers used by frontend, backend functions and tests.

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/

export function validateUsername(u: string): string | null {
  if (!u) return 'Username is required.'
  if (u.length < 3) return 'Username must be at least 3 characters.'
  if (u.length > 24) return 'Username must be at most 24 characters.'
  if (!USERNAME_RE.test(u)) return 'Use only letters, numbers and underscores.'
  return null
}

export function validatePassword(p: string): string | null {
  if (!p) return 'Password is required.'
  if (p.length < 8) return 'Password must be at least 8 characters.'
  if (p.length > 128) return 'Password is too long.'
  return null
}

export function cleanText(t: string, max: number): string | null {
  const v = (t ?? '').trim()
  if (!v) return null
  if (v.length > max) return null
  return v
}

export const LIMITS = { post: 1000, comment: 500, message: 2000, bio: 160, groupName: 60 }

/** Escape HTML to prevent XSS when any text is rendered as markup anywhere. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** Generate a human-friendly recovery code, e.g. MT-7K2P-9QXD-4MZA. Stored only as a hash server-side. */
export function generateRecoveryCode(random: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no confusing 0/O/1/I
  const part = () => Array.from({ length: 4 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
  return `MT-${part()}-${part()}-${part()}`
}

export function normalizeRecoveryCode(c: string): string {
  return c.trim().toUpperCase().replace(/\s+/g, '')
}

/** Idempotent merge for Drive archives: dedup by message id, keep chronological order. */
export interface ArchiveMessage {
  id: string
  conversationId: string
  senderId: string
  senderUsername: string
  text: string
  createdAt: string
}

export function mergeArchiveMessages(existing: ArchiveMessage[], incoming: ArchiveMessage[]): ArchiveMessage[] {
  const byId = new Map<string, ArchiveMessage>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m) // first write wins — retries never duplicate
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function archiveFileName(dateISO: string): string {
  return `${dateISO.slice(0, 10)}.json` // YYYY-MM-DD.json
}

export function isOnline(lastSeenISO: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenISO) return false
  return now - new Date(lastSeenISO).getTime() < 90_000 // seen in the last 90 seconds
}
