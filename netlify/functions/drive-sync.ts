// Scheduled function: drains drive_sync_queue into Google Drive every 5 minutes.
// Config for the schedule lives in the `config` export below (Netlify scheduled functions).
// Messages stay safely in Postgres + the queue until Drive confirms the write,
// so outages cause delay, never silent loss. Backoff: 1m, 5m, 25m, 2h, then daily.
import { db } from './_shared'
import { driveClient, driveConfigured, archiveMessages } from './_drive'
import type { ArchiveMessage } from '../../src/lib/shared'

export const config = { schedule: '*/5 * * * *' }

const BACKOFF_MIN = [1, 5, 25, 120, 1440]

export async function handler() {
  if (!driveConfigured()) {
    return { statusCode: 200, body: 'Drive not configured yet — queue kept intact.' }
  }
  const supa = db()
  const nowIso = new Date().toISOString()

  const { data: queued, error } = await supa
    .from('drive_sync_queue')
    .select('message_id, attempts')
    .is('synced_at', null)
    .lte('next_attempt_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) return { statusCode: 500, body: `Queue read failed: ${error.message}` }
  if (!queued?.length) return { statusCode: 200, body: 'Queue empty.' }

  const ids = queued.map((q) => q.message_id)
  const { data: msgs } = await supa
    .from('messages')
    .select('id, conversation_id, sender_id, text, created_at, sender:users!messages_sender_id_fkey(username)')
    .in('id', ids)
  if (!msgs?.length) return { statusCode: 200, body: 'Nothing to archive.' }

  const archive: ArchiveMessage[] = msgs.map((m: Record<string, unknown>) => ({
    id: String(m.id),
    conversationId: String(m.conversation_id),
    senderId: String(m.sender_id),
    senderUsername: String((m.sender as { username?: string } | null)?.username ?? ''),
    text: String(m.text),
    createdAt: String(m.created_at),
  }))

  try {
    await archiveMessages(driveClient(), archive)
    await supa.from('drive_sync_queue').update({ synced_at: new Date().toISOString(), last_error: null }).in('message_id', ids)
    return { statusCode: 200, body: `Archived ${archive.length} message(s) to Google Drive.` }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Mark each item for retry with backoff — nothing is dropped.
    for (const q of queued) {
      const attempts = q.attempts + 1
      const delay = BACKOFF_MIN[Math.min(q.attempts, BACKOFF_MIN.length - 1)]
      await supa.from('drive_sync_queue').update({
        attempts,
        last_error: message.slice(0, 500),
        next_attempt_at: new Date(Date.now() + delay * 60_000).toISOString(),
      }).eq('message_id', q.message_id)
    }
    return { statusCode: 502, body: `Drive sync failed, will retry: ${message}` }
  }
}
