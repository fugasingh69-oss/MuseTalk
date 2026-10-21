// Google Drive archive writer (server-only).
// Archive layout in the owner's Drive:
//   MuseTalk/
//     conversations/
//       <conversationId>/
//         2026-10-22.json   -> { conversationId, date, messages: [ ... ] }
// Files are merged idempotently by message id (see mergeArchiveMessages),
// so retries and concurrent sync runs never create duplicates.
import { google, type drive_v3 } from 'googleapis'
import { mergeArchiveMessages, archiveFileName, type ArchiveMessage } from '../../src/lib/shared'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

export function driveConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN)
}

export function driveClient(): drive_v3.Drive {
  const oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET)
  oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return google.drive({ version: 'v3', auth: oauth })
}

async function findFolder(drive: drive_v3.Drive, name: string, parent?: string): Promise<string | null> {
  const q = [`mimeType='${FOLDER_MIME}'`, `name='${name.replace(/'/g, "\\'")}'`, 'trashed=false', parent ? `'${parent}' in parents` : `'root' in parents`].join(' and ')
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive', pageSize: 1 })
  return res.data.files?.[0]?.id ?? null
}

async function ensureFolder(drive: drive_v3.Drive, name: string, parent?: string): Promise<string> {
  const found = await findFolder(drive, name, parent)
  if (found) return found
  const res = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) },
    fields: 'id',
  })
  return res.data.id!
}

/** Root MuseTalk folder — created automatically on first sync. Never shared publicly. */
export async function ensureArchiveRoot(drive: drive_v3.Drive): Promise<string> {
  if (process.env.GOOGLE_DRIVE_FOLDER_ID) return process.env.GOOGLE_DRIVE_FOLDER_ID
  return ensureFolder(drive, 'MuseTalk')
}

async function findFile(drive: drive_v3.Drive, name: string, parent: string): Promise<string | null> {
  const q = [`name='${name}'`, `'${parent}' in parents`, 'trashed=false'].join(' and ')
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive', pageSize: 1 })
  return res.data.files?.[0]?.id ?? null
}

/**
 * Append messages to their conversation/day archive files.
 * Groups by conversation + date, reads the existing file, merges with dedup, writes back.
 * Uses scope drive.file only — the app can only touch files it created.
 */
export async function archiveMessages(drive: drive_v3.Drive, messages: ArchiveMessage[]): Promise<void> {
  const root = await ensureArchiveRoot(drive)
  const convRoot = await ensureFolder(drive, 'conversations', root)

  const groups = new Map<string, ArchiveMessage[]>()
  for (const m of messages) {
    const key = `${m.conversationId}/${archiveFileName(m.createdAt)}`
    groups.set(key, [...(groups.get(key) ?? []), m])
  }

  for (const [key, group] of groups) {
    const [conversationId, fileName] = key.split('/')
    const convFolder = await ensureFolder(drive, conversationId, convRoot)
    const existingId = await findFile(drive, fileName, convFolder)

    let existing: ArchiveMessage[] = []
    if (existingId) {
      const got = await drive.files.get({ fileId: existingId, alt: 'media' }, { responseType: 'text' })
      try {
        const parsed = JSON.parse(String(got.data))
        existing = Array.isArray(parsed.messages) ? parsed.messages : []
      } catch { existing = [] }
    }

    const merged = mergeArchiveMessages(existing, group)
    const payload = JSON.stringify({ conversationId, date: fileName.replace('.json', ''), exportedAt: new Date().toISOString(), messages: merged }, null, 2)

    if (existingId) {
      await drive.files.update({ fileId: existingId, media: { mimeType: 'application/json', body: payload } })
    } else {
      await drive.files.create({
        requestBody: { name: fileName, parents: [convFolder], mimeType: 'application/json' },
        media: { mimeType: 'application/json', body: payload },
        fields: 'id',
      })
    }
  }
}
