import { describe, it, expect } from 'vitest'
import bcrypt from 'bcryptjs'
import {
  validateUsername, validatePassword, generateRecoveryCode, normalizeRecoveryCode,
  mergeArchiveMessages, archiveFileName, escapeHtml, isOnline, type ArchiveMessage,
} from '../src/lib/shared'

describe('username validation', () => {
  it('accepts a normal username', () => expect(validateUsername('abhishek_01')).toBeNull())
  it('rejects too-short, spaces and symbols', () => {
    expect(validateUsername('ab')).not.toBeNull()
    expect(validateUsername('bad name')).not.toBeNull()
    expect(validateUsername('bad-name!')).not.toBeNull()
  })
})

describe('password validation + hashing', () => {
  it('rejects short passwords', () => expect(validatePassword('short')).not.toBeNull())
  it('hashes are never plaintext and verify correctly', async () => {
    const hash = await bcrypt.hash('correct horse battery', 10)
    expect(hash).not.toContain('correct horse')
    expect(await bcrypt.compare('correct horse battery', hash)).toBe(true)
    expect(await bcrypt.compare('wrong password', hash)).toBe(false)
  })
})

describe('recovery code', () => {
  it('has the MT-XXXX-XXXX-XXXX shape and normalizes case/space', () => {
    const code = generateRecoveryCode()
    expect(code).toMatch(/^MT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(normalizeRecoveryCode('  mt-abcd-2345 ')).toBe('MT-ABCD-2345')
  })
})

describe('Drive archive merge (dedup)', () => {
  const m = (id: string, createdAt: string): ArchiveMessage => ({ id, conversationId: 'c1', senderId: 'u1', senderUsername: 'a', text: `msg ${id}`, createdAt })
  it('never duplicates on retry and stays chronological', () => {
    const first = mergeArchiveMessages([], [m('2', '2026-10-22T10:00:02Z'), m('1', '2026-10-22T10:00:01Z')])
    const retried = mergeArchiveMessages(first, [m('2', '2026-10-22T10:00:02Z'), m('3', '2026-10-22T10:00:03Z')])
    expect(retried.map((x) => x.id)).toEqual(['1', '2', '3'])
  })
  it('names archive files by day', () => expect(archiveFileName('2026-10-22T10:00:01Z')).toBe('2026-10-22.json'))
})

describe('safety helpers', () => {
  it('escapes HTML', () => expect(escapeHtml('<script>"x"</script>')).not.toContain('<script>'))
  it('online means seen within 90 seconds', () => {
    expect(isOnline(new Date(Date.now() - 10_000).toISOString())).toBe(true)
    expect(isOnline(new Date(Date.now() - 10 * 60_000).toISOString())).toBe(false)
    expect(isOnline(null)).toBe(false)
  })
})
