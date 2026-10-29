// Scheduled function: drains drive_sync_queue into Google Drive every 5 minutes.
// Config for the schedule lives in the `config` export below (Netlify scheduled functions).
// Messages stay safely in Postgres + the queue until Drive confirms the write,
// so outages cause delay, never silent loss. Backoff: 1m, 5m, 25m, 2h, then daily.
//
// Timeout discipline (fix for the Oct 26 stall): Netlify kills a scheduled run at
// 30s. The old version archived up to 200 messages and only marked the queue AFTER
// every Drive write finished, so a big backlog could never complete inside 30s and
// no progress was ever recorded — the queue looked frozen while runs kept timing out.
// Now: small batches, each conversation/day group is marked synced immediately after
// its own Drive write confirms, and a hard internal deadline (with an AbortSignal
// threaded into every Drive call) stops the run cleanly before Netlify kills it.
import { db } from './_shared'
import { driveClient, driveConfigured, archiveMessages } from './_drive'
import { archiveFileName, type ArchiveMessage } from '../../src/lib/shared'

export const config = { schedule: '*/5 * * * *' }

const BACKOFF_MIN = [1, 5, 25, 120, 1440]
const BATCH = 40
const DEADLINE_MS = 22_000 // stop starting new work well before Netlify's 30s kill

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
    .limit(BATCH)
  if (error) return { statusCode: 500, body: `Queue read failed: ${error.message}` }
  if (!queued?.length) return { statusCode: 200, body: 'Queue empty.' }

  const ids = queued.map((q) => q.message_id)
  const { data: msgs } = await supa
    .from('messages')
    .select('id, conversation_id, sender_id, text, created_at, deleted_at, sender:users!messages_sender_id_fkey(username)')
    .in('id', ids)
  if (!msgs?.length) return { statusCode: 200, body: 'Nothing to archive.' }

  // A message the sender deleted before it was archived must never reach
  // Drive: drop it from the queue entirely instead of syncing it.
  const deletedIds = msgs.filter((m) => m.deleted_at).map((m) => String(m.id))
  if (deletedIds.length) {
    await supa.from('drive_sync_queue').delete().in('message_id', deletedIds)
  }
  const liveMsgs = msgs.filter((m) => !m.deleted_at)
  if (!liveMsgs.length) return { statusCode: 200, body: 'Nothing to archive (deleted messages dropped from the queue).' }

  const archive: ArchiveMessage[] = liveMsgs.map((m: Record<string, unknown>) => ({
    id: String(m.id),
    conversationId: String(m.conversation_id),
    senderId: String(m.sender_id),
    senderUsername: String((m.sender as { username?: string } | null)?.username ?? ''),
    text: String(m.text),
    createdAt: String(m.created_at),
  }))

  // Same grouping archiveMessages uses internally: one group = one Drive file.
  const groups = new Map<string, ArchiveMessage[]>()
  for (const m of archive) {
    const key = `${m.conversationId}/${archiveFileName(m.createdAt)}`
    groups.set(key, [...(groups.get(key) ?? []), m])
  }

  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
  const drive = driveClient()
  const doneIds = new Set<string>()
  let archivedCount = 0

  try {
    for (const group of groups.values()) {
      if (Date.now() - startedAt > DEADLINE_MS - 3_000) break // leave the rest for the next run
      await archiveMessages(drive, group, { signal: controller.signal })
      const groupIds = group.map((m) => m.id)
      await supa.from('drive_sync_queue').update({ synced_at: new Date().toISOString(), last_error: null }).in('message_id', groupIds)
      groupIds.forEach((id) => doneIds.add(id))
      archivedCount += group.length
    }
    if (archivedCount === 0) throw new Error('No archive group completed before the deadline.')
    return { statusCode: 200, body: `Archived ${archivedCount} message(s) to Google Drive.${doneIds.size < ids.length ? ` ${ids.length - doneIds.size} left for the next run.` : ''}` }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Mark each unfinished item for retry with backoff — nothing is dropped.
    for (const q of queued) {
      if (doneIds.has(q.message_id)) continue
      const attempts = q.attempts + 1
      const delay = BACKOFF_MIN[Math.min(q.attempts, BACKOFF_MIN.length - 1)]
      await supa.from('drive_sync_queue').update({
        attempts,
        last_error: message.slice(0, 500),
        next_attempt_at: new Date(Date.now() + delay * 60_000).toISOString(),
      }).eq('message_id', q.message_id)
    }
    return { statusCode: 502, body: `Drive sync failed, will retry: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}
