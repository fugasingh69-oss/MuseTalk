// MuseTalk API — single Netlify Function router. All routes are under /api/*
// Every private operation checks the JWT server-side. No service keys reach the browser.
import bcrypt from 'bcryptjs'
import { db, requireUser, issueToken, json, readBody, rateLimit, clientIp, blockedIds, HttpError } from './_shared'
import { validateUsername, validatePassword, cleanText, LIMITS, generateRecoveryCode, normalizeRecoveryCode } from '../../src/lib/shared'

type Event = { httpMethod: string; path: string; headers: Record<string, string | undefined>; body: string | null; isBase64Encoded?: boolean; queryStringParameters?: Record<string, string | null> }

const publicUser = (u: Record<string, unknown>) => ({
  id: u.id, username: u.username, bio: u.bio ?? '', isAgent: !!u.is_agent,
  lastSeenAt: u.last_seen_at, createdAt: u.created_at,
})

// Embedded author objects (feed / comments / profile) get the same camelCase shape.
const pubAuthor = (a: unknown) => {
  const r = (a ?? {}) as Record<string, unknown>
  return { id: r.id, username: r.username, isAgent: !!r.is_agent }
}

async function register(event: Event) {
  const ip = clientIp(event.headers)
  if (!(await rateLimit(`register:${ip}`, 5, 3600))) throw new HttpError(429, 'Too many accounts created from this network. Try again later.')
  const body = await readBody(event)
  const username = String(body.username ?? '').trim()
  const password = String(body.password ?? '')
  const isAgent = body.isAgent === true
  const errU = validateUsername(username); if (errU) throw new HttpError(400, errU)
  const errP = validatePassword(password); if (errP) throw new HttpError(400, errP)

  const supa = db()
  const { data: existing } = await supa.from('users').select('id').eq('username_lower', username.toLowerCase()).maybeSingle()
  if (existing) throw new HttpError(409, 'That username is already taken. Please choose another.')

  const recoveryCode = generateRecoveryCode()
  const [passwordHash, recoveryHash] = await Promise.all([bcrypt.hash(password, 12), bcrypt.hash(normalizeRecoveryCode(recoveryCode), 10)])
  const { data, error } = await supa.from('users').insert({
    username, username_lower: username.toLowerCase(), password_hash: passwordHash, recovery_code_hash: recoveryHash, is_agent: isAgent,
  }).select('id, username, bio, is_agent, last_seen_at, created_at').single()
  if (error) throw new HttpError(500, 'Could not create the account. Please try again.')
  // The recovery code is returned ONCE. It is the only way back in without email/phone — the user must save it.
  return json(201, { token: issueToken({ id: data.id, username: data.username }), user: publicUser(data), recoveryCode })
}

async function login(event: Event) {
  const ip = clientIp(event.headers)
  const body = await readBody(event)
  const username = String(body.username ?? '').trim()
  if (!(await rateLimit(`login:${ip}:${username.toLowerCase()}`, 10, 900))) throw new HttpError(429, 'Too many login attempts. Wait a few minutes and try again.')
  const supa = db()
  const { data: user } = await supa.from('users').select('*').eq('username_lower', username.toLowerCase()).maybeSingle()
  const ok = user && (await bcrypt.compare(String(body.password ?? ''), user.password_hash))
  if (!ok) throw new HttpError(401, 'Wrong username or password.')
  await supa.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', user.id)
  return json(200, { token: issueToken({ id: user.id, username: user.username }), user: publicUser(user) })
}

async function recover(event: Event) {
  const ip = clientIp(event.headers)
  if (!(await rateLimit(`recover:${ip}`, 5, 3600))) throw new HttpError(429, 'Too many recovery attempts. Try again later.')
  const body = await readBody(event)
  const username = String(body.username ?? '').trim()
  const code = normalizeRecoveryCode(String(body.recoveryCode ?? ''))
  const newPassword = String(body.newPassword ?? '')
  const errP = validatePassword(newPassword); if (errP) throw new HttpError(400, errP)
  const supa = db()
  const { data: user } = await supa.from('users').select('*').eq('username_lower', username.toLowerCase()).maybeSingle()
  const ok = user?.recovery_code_hash && (await bcrypt.compare(code, user.recovery_code_hash))
  if (!ok) throw new HttpError(401, 'Username or recovery code is incorrect.')
  const nextCode = generateRecoveryCode()
  await supa.from('users').update({
    password_hash: await bcrypt.hash(newPassword, 12),
    recovery_code_hash: await bcrypt.hash(normalizeRecoveryCode(nextCode), 10), // old code is single-use
  }).eq('id', user.id)
  return json(200, { token: issueToken({ id: user.id, username: user.username }), user: publicUser(user), recoveryCode: nextCode })
}

async function feed(me: string) {
  const supa = db()
  const hidden = await blockedIds(me)
  let q = supa.from('posts').select('id, text, created_at, author:users!posts_author_id_fkey(id, username, is_agent), likes(count), comments(count)')
    .order('created_at', { ascending: false }).limit(100)
  if (hidden.length) q = q.not('author_id', 'in', `(${hidden.join(',')})`)
  const { data, error } = await q
  if (error) throw new HttpError(500, 'Could not load the feed.')
  const { data: myLikes } = await supa.from('likes').select('post_id').eq('user_id', me)
  const liked = new Set((myLikes ?? []).map((l) => l.post_id))
  return json(200, {
    posts: (data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id, text: p.text, createdAt: p.created_at, author: pubAuthor(p.author),
      likeCount: (p.likes as { count: number }[])?.[0]?.count ?? 0,
      commentCount: (p.comments as { count: number }[])?.[0]?.count ?? 0,
      likedByMe: liked.has(p.id as string), mine: (p.author as { id: string }).id === me,
    })),
  })
}

async function createPost(event: Event, me: { id: string }) {
  if (!(await rateLimit(`post:${me.id}`, 30, 3600))) throw new HttpError(429, 'You are posting too fast. Take a short break.')
  const body = await readBody(event)
  const text = cleanText(String(body.text ?? ''), LIMITS.post)
  if (!text) throw new HttpError(400, `Post must be 1–${LIMITS.post} characters of text.`)
  const { data, error } = await db().from('posts').insert({ author_id: me.id, text }).select('id, text, created_at').single()
  if (error) throw new HttpError(500, 'Could not publish the post.')
  return json(201, { post: data })
}

async function deletePost(me: string, postId: string) {
  const { error } = await db().from('posts').delete().eq('id', postId).eq('author_id', me) // only own posts
  if (error) throw new HttpError(500, 'Could not delete the post.')
  return json(200, { ok: true })
}

async function toggleLike(me: string, postId: string) {
  const supa = db()
  const { data: existing } = await supa.from('likes').select('post_id').eq('post_id', postId).eq('user_id', me).maybeSingle()
  if (existing) { await supa.from('likes').delete().eq('post_id', postId).eq('user_id', me); return json(200, { liked: false }) }
  const { error } = await supa.from('likes').insert({ post_id: postId, user_id: me })
  if (error) throw new HttpError(404, 'Post not found.')
  return json(200, { liked: true })
}

async function listComments(me: string, postId: string) {
  const hidden = await blockedIds(me)
  let q = db().from('comments').select('id, text, parent_id, created_at, author:users!comments_author_id_fkey(id, username, is_agent)')
    .eq('post_id', postId).order('created_at', { ascending: true }).limit(300)
  if (hidden.length) q = q.not('author_id', 'in', `(${hidden.join(',')})`)
  const { data } = await q
  return json(200, { comments: (data ?? []).map((c: Record<string, unknown>) => ({ ...c, author: pubAuthor(c.author), mine: (c.author as { id: string }).id === me })) })
}

async function createComment(event: Event, me: string, postId: string) {
  if (!(await rateLimit(`comment:${me}`, 60, 3600))) throw new HttpError(429, 'You are commenting too fast.')
  const body = await readBody(event)
  const text = cleanText(String(body.text ?? ''), LIMITS.comment)
  if (!text) throw new HttpError(400, `Comment must be 1–${LIMITS.comment} characters.`)
  const parentId = body.parentId ? String(body.parentId) : null // replies thread under a parent comment
  const { data, error } = await db().from('comments').insert({ post_id: postId, author_id: me, parent_id: parentId, text }).select('id, text, parent_id, created_at').single()
  if (error) throw new HttpError(500, 'Could not add the comment.')
  return json(201, { comment: data })
}

async function deleteComment(me: string, commentId: string) {
  const { error } = await db().from('comments').delete().eq('id', commentId).eq('author_id', me)
  if (error) throw new HttpError(500, 'Could not delete the comment.')
  return json(200, { ok: true })
}

async function searchUsers(me: string, query: string) {
  const hidden = await blockedIds(me)
  let q = db().from('users').select('id, username, bio, is_agent, last_seen_at, created_at').order('username').limit(30)
  if (query) q = q.ilike('username', `%${query.replace(/[%_]/g, '')}%`)
  if (hidden.length) q = q.not('id', 'in', `(${hidden.join(',')})`)
  const { data } = await q
  return json(200, { users: (data ?? []).map(publicUser) })
}

async function profile(me: string, username: string) {
  const supa = db()
  const { data: user } = await supa.from('users').select('*').eq('username_lower', username.toLowerCase()).maybeSingle()
  if (!user) throw new HttpError(404, 'User not found.')
  const hidden = await blockedIds(me)
  if (hidden.includes(user.id)) throw new HttpError(404, 'User not found.')
  const isMe = user.id === me
  const authorPub = { id: user.id as string, username: user.username as string, isAgent: !!user.is_agent }

  const [{ count: followers }, { count: following }, { data: followRow }, { data: postRows }, { data: myLikeRows }, { data: commentRows }] = await Promise.all([
    supa.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', user.id),
    supa.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', user.id),
    supa.from('follows').select('follower_id').eq('follower_id', me).eq('following_id', user.id).maybeSingle(),
    supa.from('posts').select('id, text, created_at, likes(count), comments(count)').eq('author_id', user.id).order('created_at', { ascending: false }).limit(50),
    supa.from('likes').select('post_id').eq('user_id', me),
    supa.from('comments').select('id, text, created_at, parent_id, post_id').eq('author_id', user.id).order('created_at', { ascending: false }).limit(50),
  ])
  const likedSet = new Set((myLikeRows ?? []).map((l) => l.post_id as string))
  const shapePost = (p: Record<string, unknown>, author: { id: string; username: string; isAgent: boolean }) => ({
    id: p.id, text: p.text, createdAt: p.created_at, author,
    likeCount: (p.likes as { count: number }[])?.[0]?.count ?? 0,
    commentCount: (p.comments as { count: number }[])?.[0]?.count ?? 0,
    likedByMe: likedSet.has(p.id as string), mine: author.id === me,
  })
  const posts = (postRows ?? []).map((p) => shapePost(p as Record<string, unknown>, authorPub))

  // Replies: every comment this user wrote, with the post it belongs to as context.
  let replies: Record<string, unknown>[] = []
  const cRows = (commentRows ?? []) as { id: string; text: string; created_at: string; parent_id: string | null; post_id: string }[]
  if (cRows.length) {
    const postIds = [...new Set(cRows.map((c) => c.post_id))]
    const { data: ctxPosts } = await supa.from('posts').select('id, text, author_id').in('id', postIds)
    const authorIds = [...new Set((ctxPosts ?? []).map((p) => p.author_id as string))]
    const { data: ctxUsers } = authorIds.length
      ? await supa.from('users').select('id, username').in('id', authorIds)
      : { data: [] as { id: string; username: string }[] }
    const postById = new Map((ctxPosts ?? []).map((p) => [p.id as string, p]))
    const nameById = new Map((ctxUsers ?? []).map((u) => [u.id as string, u.username as string]))
    replies = cRows.map((c) => {
      const post = postById.get(c.post_id)
      return {
        id: c.id, text: c.text, createdAt: c.created_at, isReply: !!c.parent_id,
        postId: c.post_id, postText: (post?.text as string) ?? '', postAuthor: post ? (nameById.get(post.author_id as string) ?? '') : '',
      }
    })
  }

  // Liked posts — returned only on your OWN profile (your likes are yours to revisit).
  let likedPosts: Record<string, unknown>[] | undefined
  if (isMe) {
    likedPosts = []
    const { data: likeRows } = await supa.from('likes').select('post_id').eq('user_id', me).order('created_at', { ascending: false }).limit(50)
    const ids = (likeRows ?? []).map((l) => l.post_id as string)
    if (ids.length) {
      const { data: liked } = await supa.from('posts')
        .select('id, text, created_at, author:users!posts_author_id_fkey(id, username, is_agent), likes(count), comments(count)')
        .in('id', ids)
      const byId = new Map((liked ?? []).map((p) => [(p as Record<string, unknown>).id as string, p as Record<string, unknown>]))
      likedPosts = ids.map((id) => byId.get(id)).filter((p): p is Record<string, unknown> => !!p)
        .map((p) => shapePost(p, pubAuthor(p.author)))
    }
  }

  return json(200, {
    user: publicUser(user), followers: followers ?? 0, following: following ?? 0,
    followedByMe: !!followRow, isMe, posts, replies,
    ...(likedPosts !== undefined ? { likedPosts } : {}),
  })
}

async function setFollow(me: string, username: string, follow: boolean) {
  const supa = db()
  const { data: target } = await supa.from('users').select('id').eq('username_lower', username.toLowerCase()).maybeSingle()
  if (!target) throw new HttpError(404, 'User not found.')
  if (target.id === me) throw new HttpError(400, 'You cannot follow yourself.')
  if (follow) { const { error } = await supa.from('follows').insert({ follower_id: me, following_id: target.id }); if (error && !error.message.includes('duplicate')) throw new HttpError(500, 'Could not follow.') }
  else await supa.from('follows').delete().eq('follower_id', me).eq('following_id', target.id)
  return json(200, { following: follow })
}

async function blockOrReport(event: Event, me: string, username: string, kind: 'block' | 'report') {
  const supa = db()
  const { data: target } = await supa.from('users').select('id').eq('username_lower', username.toLowerCase()).maybeSingle()
  if (!target) throw new HttpError(404, 'User not found.')
  if (target.id === me) throw new HttpError(400, 'You cannot do that to yourself.')
  if (kind === 'block') {
    await supa.from('blocks').insert({ blocker_id: me, blocked_id: target.id })
    await supa.from('follows').delete().eq('follower_id', me).eq('following_id', target.id)
    await supa.from('follows').delete().eq('follower_id', target.id).eq('following_id', me)
  } else {
    const body = await readBody(event)
    await supa.from('reports').insert({ reporter_id: me, reported_id: target.id, reason: String(body.reason ?? '').slice(0, 300) })
  }
  return json(200, { ok: true })
}

async function assertParticipant(me: string, conversationId: string) {
  const { data } = await db().from('conversation_participants').select('conversation_id').eq('conversation_id', conversationId).eq('user_id', me).maybeSingle()
  if (!data) throw new HttpError(403, 'You are not a participant of this conversation.')
}

async function listConversations(me: string) {
  const supa = db()
  const { data: parts } = await supa.from('conversation_participants').select('conversation_id, last_read_at').eq('user_id', me)
  const ids = (parts ?? []).map((p) => p.conversation_id)
  if (!ids.length) return json(200, { conversations: [] })
  const readMap = new Map((parts ?? []).map((p) => [p.conversation_id, p.last_read_at]))
  const [{ data: convs }, { data: allParts }, { data: recent }] = await Promise.all([
    supa.from('conversations').select('*').in('id', ids),
    supa.from('conversation_participants').select('conversation_id, user:users!conversation_participants_user_id_fkey(id, username, is_agent, last_seen_at)').in('conversation_id', ids),
    supa.from('messages').select('conversation_id, text, created_at, sender_id').in('conversation_id', ids).order('created_at', { ascending: false }).limit(500),
  ])
  const lastByConv = new Map<string, Record<string, unknown>>()
  for (const m of recent ?? []) if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m)
  const out = []
  for (const c of convs ?? []) {
    const lastRead = readMap.get(c.id) ?? 'epoch'
    const unread = (recent ?? []).filter((m) => m.conversation_id === c.id && m.sender_id !== me && m.created_at > lastRead).length
    out.push({
      id: c.id, isGroup: c.is_group, name: c.name, createdAt: c.created_at,
      participants: (allParts ?? []).filter((p) => p.conversation_id === c.id).map((p) => p.user),
      lastMessage: lastByConv.get(c.id) ?? null, unread,
    })
  }
  out.sort((a, b) => String(b.lastMessage?.createdAt ?? b.createdAt).localeCompare(String(a.lastMessage?.createdAt ?? a.createdAt)))
  return json(200, { conversations: out })
}

async function createConversation(event: Event, me: string) {
  const body = await readBody(event)
  const supa = db()
  const hidden = await blockedIds(me)
  if (body.isGroup === true) {
    const name = cleanText(String(body.name ?? ''), LIMITS.groupName)
    const usernames: string[] = Array.isArray(body.usernames) ? body.usernames.map(String) : []
    if (!name) throw new HttpError(400, 'Group needs a name.')
    if (usernames.length < 1) throw new HttpError(400, 'Add at least one other person to the group.')
    const { data: users } = await supa.from('users').select('id').in('username_lower', usernames.map((u) => u.toLowerCase()))
    const memberIds = (users ?? []).map((u) => u.id).filter((id) => !hidden.includes(id))
    if (!memberIds.length) throw new HttpError(404, 'None of those users could be added.')
    const { data: conv, error } = await supa.from('conversations').insert({ is_group: true, name, created_by: me }).select('id').single()
    if (error) throw new HttpError(500, 'Could not create the group.')
    await supa.from('conversation_participants').insert([me, ...memberIds].map((user_id) => ({ conversation_id: conv.id, user_id })))
    return json(201, { conversationId: conv.id })
  }
  const username = String(body.username ?? '')
  const { data: target } = await supa.from('users').select('id').eq('username_lower', username.toLowerCase()).maybeSingle()
  if (!target) throw new HttpError(404, 'User not found.')
  if (target.id === me) throw new HttpError(400, 'You cannot message yourself.')
  if (hidden.includes(target.id)) throw new HttpError(403, 'You cannot message this user.')
  // Reuse an existing 1:1 conversation if one exists.
  const { data: mine } = await supa.from('conversation_participants').select('conversation_id').eq('user_id', me)
  const myIds = (mine ?? []).map((r) => r.conversation_id)
  if (myIds.length) {
    const { data: theirs } = await supa.from('conversation_participants').select('conversation_id').eq('user_id', target.id).in('conversation_id', myIds)
    for (const row of theirs ?? []) {
      const { data: conv } = await supa.from('conversations').select('id, is_group').eq('id', row.conversation_id).maybeSingle()
      if (conv && !conv.is_group) return json(200, { conversationId: conv.id })
    }
  }
  const { data: conv, error } = await supa.from('conversations').insert({ is_group: false }).select('id').single()
  if (error) throw new HttpError(500, 'Could not start the conversation.')
  await supa.from('conversation_participants').insert([{ conversation_id: conv.id, user_id: me }, { conversation_id: conv.id, user_id: target.id }])
  return json(201, { conversationId: conv.id })
}

async function listMessages(me: string, conversationId: string, before?: string) {
  await assertParticipant(me, conversationId)
  let q = db().from('messages').select('id, text, created_at, sender:users!messages_sender_id_fkey(id, username, is_agent)')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(50)
  if (before) q = q.lt('created_at', before) // pagination for older messages
  const { data } = await q
  return json(200, { messages: (data ?? []).reverse() })
}

async function sendMessage(event: Event, me: string, conversationId: string) {
  await assertParticipant(me, conversationId)
  if (!(await rateLimit(`msg:${me}`, 120, 3600))) throw new HttpError(429, 'You are sending messages too fast.')
  const body = await readBody(event)
  const text = cleanText(String(body.text ?? ''), LIMITS.message)
  if (!text) throw new HttpError(400, `Message must be 1–${LIMITS.message} characters.`)
  const supa = db()
  const { data, error } = await supa.from('messages').insert({ conversation_id: conversationId, sender_id: me, text })
    .select('id, text, created_at, sender:users!messages_sender_id_fkey(id, username, is_agent)').single()
  if (error) throw new HttpError(500, 'Could not send the message.')
  // Enqueue for Google Drive archive in the same flow. If this insert ever failed,
  // the scheduled sync also has a safety net: it only marks synced rows, queue first.
  await supa.from('drive_sync_queue').insert({ message_id: data.id })
  await supa.from('conversation_participants').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conversationId).eq('user_id', me)
  return json(201, { message: data })
}

async function markRead(me: string, conversationId: string) {
  await assertParticipant(me, conversationId)
  await db().from('conversation_participants').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conversationId).eq('user_id', me)
  return json(200, { ok: true })
}

async function updateProfile(event: Event, me: string) {
  const body = await readBody(event)
  const bio = String(body.bio ?? '').slice(0, LIMITS.bio)
  const { data } = await db().from('users').update({ bio }).eq('id', me).select('id, username, bio, is_agent, last_seen_at, created_at').single()
  return json(200, { user: publicUser(data) })
}

export async function handler(event: Event) {
  try {
    const path = event.path.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/'
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
    const method = event.httpMethod

    if (method === 'POST' && seg[0] === 'register' && seg.length === 1) return await register(event)
    if (method === 'POST' && seg[0] === 'login') return await login(event)
    if (method === 'POST' && seg[0] === 'recover') return await recover(event)

    const me = requireUser(event.headers)
    const supa = db()
    if (method === 'POST' && seg[0] === 'heartbeat') { await supa.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', me.id); return json(200, { ok: true }) }
    if (method === 'GET' && seg[0] === 'me') { const { data } = await supa.from('users').select('*').eq('id', me.id).single(); return json(200, { user: publicUser(data) }) }
    if (method === 'PATCH' && seg[0] === 'me') return await updateProfile(event, me.id)

    if (method === 'GET' && seg[0] === 'feed') return await feed(me.id)
    if (method === 'POST' && seg[0] === 'posts' && seg.length === 1) return await createPost(event, me)
    if (method === 'DELETE' && seg[0] === 'posts' && seg.length === 2) return await deletePost(me.id, seg[1])
    if (method === 'POST' && seg[0] === 'posts' && seg[2] === 'like') return await toggleLike(me.id, seg[1])
    if (method === 'GET' && seg[0] === 'posts' && seg[2] === 'comments') return await listComments(me.id, seg[1])
    if (method === 'POST' && seg[0] === 'posts' && seg[2] === 'comments') return await createComment(event, me.id, seg[1])
    if (method === 'DELETE' && seg[0] === 'comments' && seg.length === 2) return await deleteComment(me.id, seg[1])

    if (method === 'GET' && seg[0] === 'users' && seg.length === 1) return await searchUsers(me.id, String(event.queryStringParameters?.q ?? ''))
    if (method === 'GET' && seg[0] === 'users' && seg.length === 2) return await profile(me.id, seg[1])
    if (method === 'POST' && seg[0] === 'users' && seg[2] === 'follow') return await setFollow(me.id, seg[1], true)
    if (method === 'POST' && seg[0] === 'users' && seg[2] === 'unfollow') return await setFollow(me.id, seg[1], false)
    if (method === 'POST' && seg[0] === 'users' && seg[2] === 'block') return await blockOrReport(event, me.id, seg[1], 'block')
    if (method === 'POST' && seg[0] === 'users' && seg[2] === 'report') return await blockOrReport(event, me.id, seg[1], 'report')

    if (method === 'GET' && seg[0] === 'conversations' && seg.length === 1) return await listConversations(me.id)
    if (method === 'POST' && seg[0] === 'conversations' && seg.length === 1) return await createConversation(event, me.id)
    if (method === 'GET' && seg[0] === 'conversations' && seg[2] === 'messages') return await listMessages(me.id, seg[1], event.queryStringParameters?.before ?? undefined)
    if (method === 'POST' && seg[0] === 'conversations' && seg[2] === 'messages') return await sendMessage(event, me.id, seg[1])
    if (method === 'POST' && seg[0] === 'conversations' && seg[2] === 'read') return await markRead(me.id, seg[1])

    if (method === 'GET' && seg[0] === 'archive-status') {
      const [{ count: pending }, { count: synced }] = await Promise.all([
        supa.from('drive_sync_queue').select('*', { count: 'exact', head: true }).is('synced_at', null),
        supa.from('drive_sync_queue').select('*', { count: 'exact', head: true }).not('synced_at', 'is', null),
      ])
      return json(200, { driveConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN), pending: pending ?? 0, archived: synced ?? 0 })
    }

    throw new HttpError(404, 'Route not found.')
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message })
    console.error(e)
    return json(500, { error: 'Something went wrong on the server.' })
  }
}
