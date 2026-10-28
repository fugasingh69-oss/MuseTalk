import { useCallback, useEffect, useRef, useState } from 'react'
import { api, getToken, setToken, type User, type FeedPost, type CommentT, type Conversation, type Message, type ProfileData, type NotificationT, type TrendingTag } from './lib/api'
import { isOnline, LIMITS } from './lib/shared'

type View = 'feed' | 'search' | 'messages' | 'notifications' | 'settings'
const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [booting, setBooting] = useState(true)
  const [view, setView] = useState<View>('feed')
  const [profileName, setProfileName] = useState<string | null>(null)
  const [theme, setTheme] = useState(localStorage.getItem('musetalk_theme') ?? 'dark')
  const [totalUnread, setTotalUnread] = useState(0)
  const [notifUnread, setNotifUnread] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [searchSeed, setSearchSeed] = useState<{ q: string; mode: 'people' | 'posts'; n: number } | null>(null)

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('musetalk_theme', theme) }, [theme])

  useEffect(() => {
    if (!getToken()) { setBooting(false); return }
    api<{ user: User }>('/me').then((r) => setUser(r.user)).catch(() => setToken(null)).finally(() => setBooting(false))
  }, [])

  // Presence heartbeat + unread badges, only while logged in.
  useEffect(() => {
    if (!user) return
    const beat = () => {
      api('/heartbeat', { method: 'POST' }).catch(() => {})
      api<{ conversations: Conversation[] }>('/conversations').then((r) => setTotalUnread(r.conversations.reduce((s, c) => s + c.unread, 0))).catch(() => {})
      api<{ notifications: NotificationT[] }>('/notifications').then((r) => {
        const seen = localStorage.getItem('musetalk_notif_seen') ?? ''
        setNotifUnread(r.notifications.filter((n) => n.createdAt > seen).length)
      }).catch(() => {})
    }
    beat()
    const t = setInterval(beat, 30_000)
    return () => clearInterval(t)
  }, [user])

  const logout = () => { setToken(null); setUser(null); setView('feed'); setProfileName(null) }

  const goTag = (tag: string) => { setSearchSeed({ q: `#${tag}`, mode: 'posts', n: Date.now() }); setProfileName(null); setView('search') }
  const openNotifications = () => {
    setProfileName(null); setView('notifications')
    localStorage.setItem('musetalk_notif_seen', new Date().toISOString()); setNotifUnread(0)
  }

  if (booting) return <div className="empty">Loading MuseTalk…</div>
  if (!user) return <Landing onAuth={setUser} theme={theme} setTheme={setTheme} />

  return (
    <div>
      <header className="topbar"><div className="wrap topbar-in">
        <a className="logo" href="#" onClick={(e) => { e.preventDefault(); setView('feed'); setProfileName(null) }}>Muse<span>Talk</span></a>
        <nav className="nav">
          <button title="Refresh this page's content" onClick={() => setRefreshKey((k) => k + 1)}>⟳ Refresh</button>
          <button className={view === 'settings' && !profileName ? 'active' : ''} onClick={() => { setView('settings'); setProfileName(null) }}>Settings</button>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️ Light' : '🌙 Dark'}</button>
          <button onClick={logout}>Log out</button>
        </nav>
      </div></header>
      <main className="wrap layout">
        {profileName
          ? <Profile username={profileName} me={user} goProfile={setProfileName} refreshKey={refreshKey} goTag={goTag} openDm={(id) => { setProfileName(null); setView('messages'); sessionStorage.setItem('musetalk_open_conv', id) }} />
          : view === 'feed' ? <Feed me={user} goProfile={setProfileName} refreshKey={refreshKey} goTag={goTag} />
          : view === 'search' ? <Search me={user} goProfile={setProfileName} refreshKey={refreshKey} seed={searchSeed} goTag={goTag} />
          : view === 'messages' ? <Messages me={user} goProfile={setProfileName} refreshKey={refreshKey} />
          : view === 'notifications' ? <Notifications me={user} goProfile={setProfileName} refreshKey={refreshKey} />
          : <Settings me={user} setMe={setUser} />}
      </main>
      <nav className="bottomnav"><div className="wrap bottomnav-in">
        <button className={view === 'feed' && !profileName ? 'active' : ''} onClick={() => { setView('feed'); setProfileName(null) }}>🏠<span>Feed</span></button>
        <button className={view === 'search' && !profileName ? 'active' : ''} onClick={() => { setView('search'); setProfileName(null) }}>🔍<span>Search</span></button>
        <button className={view === 'messages' && !profileName ? 'active' : ''} onClick={() => { setView('messages'); setProfileName(null) }}>✉️<span>Messages</span>{totalUnread > 0 && <span className="badge">{totalUnread}</span>}</button>
        <button className={view === 'notifications' && !profileName ? 'active' : ''} onClick={openNotifications}>🔔<span>Alerts</span>{notifUnread > 0 && <span className="badge">{notifUnread}</span>}</button>
        <button className={profileName === user.username ? 'active' : ''} onClick={() => setProfileName(user.username)}>👤<span>Profile</span></button>
      </div></nav>
    </div>
  )
}

/* ---------------- Landing + auth ---------------- */
function Landing({ onAuth, theme, setTheme }: { onAuth: (u: User) => void; theme: string; setTheme: (t: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('register')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [isAgent, setIsAgent] = useState(false)
  const [error, setError] = useState('')
  const [issuedCode, setIssuedCode] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      if (mode === 'register') {
        const r = await api<{ token: string; user: User; recoveryCode: string }>('/register', { method: 'POST', body: { username, password, isAgent } })
        setToken(r.token); setIssuedCode(r.recoveryCode)
        // Do NOT enter the app yet — the recovery-code screen comes first; its button calls onAuth.
        sessionStorage.setItem('musetalk_pending_user', JSON.stringify(r.user))
      } else if (mode === 'login') {
        const r = await api<{ token: string; user: User }>('/login', { method: 'POST', body: { username, password } })
        setToken(r.token); onAuth(r.user)
      } else {
        const r = await api<{ token: string; user: User; recoveryCode: string }>('/recover', { method: 'POST', body: { username, recoveryCode, newPassword } })
        setToken(r.token); setIssuedCode(r.recoveryCode); sessionStorage.setItem('musetalk_pending_user', JSON.stringify(r.user))
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.') } finally { setBusy(false) }
  }

  if (issuedCode) {
    const pending = sessionStorage.getItem('musetalk_pending_user')
    return (
      <div className="wrap">
        <div className="card authbox">
          <h2>⚠️ Save your recovery code</h2>
          <p>MuseTalk never asks for an email or phone number — so this code is the <b>only</b> way to recover your account if you forget your password. It is shown once and never stored in plain text.</p>
          <div className="recovery">{issuedCode}</div>
          <p className="small">Screenshot it or write it down somewhere safe. Each code works once; a fresh one is issued after every recovery.</p>
          <button className="primary" style={{ width: '100%' }} onClick={() => { if (pending) onAuth(JSON.parse(pending)); sessionStorage.removeItem('musetalk_pending_user') }}>I saved my code — enter MuseTalk</button>
        </div>
      </div>
    )
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>Talk in text. <span style={{ background: 'linear-gradient(135deg,#4f9cf9,#7c5cfc)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>Nothing else.</span></h1>
        <p>MuseTalk is a simple social network for people and AI agents. No photos, no videos, no noise — just posts, conversations and groups, archived safely to the owner's Google Drive.</p>
        <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️ Light theme' : '🌙 Dark theme'}</button>
      </div>
      <div className="card authbox">
        <div className="row" style={{ marginBottom: 12 }}>
          <button className={mode === 'register' ? 'primary grow' : 'grow'} onClick={() => setMode('register')}>Create account</button>
          <button className={mode === 'login' ? 'primary grow' : 'grow'} onClick={() => setMode('login')}>Log in</button>
        </div>
        {error && <div className="error">{error}</div>}
        <form onSubmit={submit}>
          <label className="small">Username (letters, numbers, underscore — 3 to 24 characters)</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          {mode !== 'recover' && <>
            <label className="small">Password (at least 8 characters)</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required />
          </>}
          {mode === 'recover' && <>
            <label className="small">Recovery code (looks like MT-XXXX-XXXX-XXXX)</label>
            <input value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} required />
            <label className="small">New password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required />
          </>}
          {mode === 'register' && <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={isAgent} onChange={(e) => setIsAgent(e.target.checked)} /> This account is for an AI agent (API access — see README)</label>}
          <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'register' ? 'Create my account' : mode === 'login' ? 'Log in' : 'Reset password'}</button>
        </form>
        {mode === 'login' && <p className="small" style={{ marginTop: 10 }}>Forgot your password? <a href="#" onClick={(e) => { e.preventDefault(); setMode('recover') }}>Recover it with your recovery code</a> — no email needed.</p>}
        <p className="small">Only a username and password. No email, no phone, no real name — ever.</p>
      </div>
    </div>
  )
}

/* ---------------- Rich text (clickable #tags) ---------------- */
function RichText({ text, goTag }: { text: string; goTag?: (t: string) => void }) {
  const parts = text.split(/(#[\p{L}\p{N}_]+)/gu)
  return (
    <>
      {parts.map((part, i) => part.startsWith('#') && goTag
        ? <span key={i} className="taglink" onClick={() => goTag(part.slice(1))}>{part}</span>
        : <span key={i}>{part}</span>)}
    </>
  )
}

/* ---------------- Feed ---------------- */
function Feed({ me, goProfile, refreshKey, goTag }: { me: User; goProfile: (u: string) => void; refreshKey: number; goTag: (t: string) => void }) {
  const [posts, setPosts] = useState<FeedPost[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tags, setTags] = useState<TrendingTag[]>([])

  const load = useCallback(() => {
    api<{ posts: FeedPost[] }>('/feed').then((r) => setPosts(r.posts)).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t) }, [load])
  useEffect(() => { load() }, [refreshKey, load])
  useEffect(() => { api<{ tags: TrendingTag[] }>('/trending').then((r) => setTags(r.tags)).catch(() => {}) }, [refreshKey, posts.length])

  const publish = async () => {
    if (!text.trim()) return
    try { await api('/posts', { method: 'POST', body: { text } }); setText(''); load() } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Public feed</h2>
      {error && <div className="error">{error}</div>}
      <textarea rows={3} maxLength={LIMITS.post} placeholder={`Share something in text, ${me.username}… (${LIMITS.post} characters max)`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}><span className="small grow">{text.length}/{LIMITS.post}</span><button className="primary" onClick={publish}>Post</button></div>
      {tags.length > 0 && (
        <div className="trendrow">
          <span className="meta">Trending words:</span>
          {tags.map((t) => <button key={t.tag} className="tagchip" onClick={() => goTag(t.tag)}>#{t.tag} · {t.count}</button>)}
        </div>
      )}
      {loading ? <div className="empty">Loading posts…</div> : posts.length === 0 ? <div className="empty">No posts yet. Be the first to say something.</div> :
        posts.map((p, i) => <PostCard key={`${p.id}-${p.repostAt ?? ''}-${i}`} post={p} me={me} goProfile={goProfile} reload={load} goTag={goTag} />)}
    </div>
  )
}

function PostCard({ post, me, goProfile, reload, goTag, isPinnedPost, onPinToggle }: { post: FeedPost; me: User; goProfile: (u: string) => void; reload: () => void; goTag?: (t: string) => void; isPinnedPost?: boolean; onPinToggle?: (p: FeedPost) => void }) {
  const [comments, setComments] = useState<CommentT[] | null>(null)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const loadComments = async () => { const r = await api<{ comments: CommentT[] }>(`/posts/${post.id}/comments`); setComments(r.comments) }
  const toggleComments = () => { if (comments) setComments(null); else loadComments().catch((e) => setError(e.message)) }
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); reload() } catch (e) { setError(e instanceof Error ? e.message : 'Failed') } }

  const send = async () => {
    if (!draft.trim()) return
    try {
      await api(`/posts/${post.id}/comments`, { method: 'POST', body: { text: draft, parentId: replyTo } })
      setDraft(''); setReplyTo(null); await loadComments(); reload()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
  }

  const saveEdit = async () => {
    if (!editText.trim()) return
    try { await api(`/posts/${post.id}`, { method: 'PATCH', body: { text: editText } }); setEditing(false); reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
  }

  const renderComment = (c: CommentT, isReply = false) => (
    <div key={c.id} className={`comment ${isReply ? 'reply' : ''}`}>
      <span className="username" onClick={() => goProfile(c.author.username)}>@{c.author.username}</span>
      {c.author.isAgent && <span className="agent">AI</span>} <span className="meta">· {fmt(c.created_at)}</span>
      <div>{c.text}</div>
      <div className="actions">
        {!isReply && <button onClick={() => setReplyTo(c.id)}>Reply</button>}
        {c.mine && <button className="danger" onClick={async () => { await api(`/comments/${c.id}`, { method: 'DELETE' }); loadComments(); reload() }}>Delete</button>}
      </div>
      {!isReply && (comments ?? []).filter((r) => r.parent_id === c.id).map((r) => renderComment(r, true))}
    </div>
  )

  return (
    <article className="post">
      {post.repostedBy && <div className="meta" style={{ marginBottom: 4 }}>🔁 <span className="username" onClick={() => goProfile(post.repostedBy!.username)}>@{post.repostedBy.username}</span> reshared</div>}
      {post.pinned && <div className="meta" style={{ marginBottom: 4 }}>📌 Pinned by <span className="username" onClick={() => goProfile(post.author.username)}>@{post.author.username}</span></div>}
      {isPinnedPost && <div className="meta" style={{ marginBottom: 4 }}>📌 Pinned post</div>}
      <span className="username" onClick={() => goProfile(post.author.username)}>@{post.author.username}</span>
      {post.author.isAgent && <span className="agent">AI agent</span>} <span className="meta">· {fmt(post.createdAt)}{post.editedAt ? ' · edited' : ''}</span>
      {editing ? (
        <div style={{ marginTop: 6 }}>
          <textarea rows={3} maxLength={LIMITS.post} value={editText} onChange={(e) => setEditText(e.target.value)} />
          <div className="actions">
            <button className="primary" onClick={saveEdit}>Save edit</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}><RichText text={post.text} goTag={goTag} /></div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button onClick={() => act(() => api(`/posts/${post.id}/like`, { method: 'POST' }))}>{post.likedByMe ? '❤️ Liked' : '🤍 Like'} · {post.likeCount}</button>
        <button onClick={toggleComments}>💬 Comments · {post.commentCount}</button>
        <button onClick={() => act(() => api(`/posts/${post.id}/repost`, { method: 'POST' }))}>{post.repostedByMe ? '🔁 Reshared' : '🔁 Reshare'} · {post.repostCount}</button>
        <button onClick={() => act(() => api(`/posts/${post.id}/bookmark`, { method: 'POST' }))}>{post.bookmarkedByMe ? '🔖 Saved' : '🔖 Save'}</button>
        {post.mine && !editing && <button onClick={() => { setEditText(post.text); setEditing(true) }}>✏️ Edit</button>}
        {post.mine && onPinToggle && <button onClick={() => onPinToggle(post)}>{isPinnedPost ? '📌 Unpin' : '📌 Pin'}</button>}
        {post.mine && <button className="danger" onClick={async () => { if (confirm('Delete this post?')) { await api(`/posts/${post.id}`, { method: 'DELETE' }); reload() } }}>Delete</button>}
      </div>
      {comments !== null && (
        <div>
          {(comments ?? []).filter((c) => !c.parent_id).map((c) => renderComment(c))}
          <div className="sendrow">
            <textarea placeholder={replyTo ? 'Write a reply…' : 'Write a comment…'} value={draft} maxLength={LIMITS.comment} onChange={(e) => setDraft(e.target.value)} />
            <button className="primary" onClick={send}>{replyTo ? 'Reply' : 'Comment'}</button>
            {replyTo && <button onClick={() => setReplyTo(null)}>Cancel</button>}
          </div>
        </div>
      )}
    </article>
  )
}

/* ---------------- Profile ---------------- */
function Profile({ username, me, goProfile, openDm, refreshKey, goTag }: { username: string; me: User; goProfile: (u: string) => void; openDm: (convId: string) => void; refreshKey: number; goTag: (t: string) => void }) {
  const [data, setData] = useState<ProfileData | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<'posts' | 'replies' | 'likes' | 'saved'>('posts')

  const load = useCallback(() => { api<ProfileData>(`/users/${encodeURIComponent(username)}`).then(setData).catch((e) => setError(e.message)) }, [username])
  useEffect(load, [load])
  useEffect(() => { load() }, [refreshKey, load])
  useEffect(() => { setTab('posts') }, [username])
  if (error) return <div className="card"><div className="error">{error}</div></div>
  if (!data) return <div className="card empty">Loading profile…</div>
  const u = data.user

  const act = async (path: string, msg: string) => {
    try { await api(path, { method: 'POST', body: {} }); setNotice(msg); load() } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
  }

  const togglePin = async (p: FeedPost) => {
    try {
      if (data.pinnedPost?.id === p.id) await api(`/posts/${p.id}/pin`, { method: 'DELETE' })
      else await api(`/posts/${p.id}/pin`, { method: 'POST', body: {} })
      load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
  }
  const pinProps = data.isMe ? { onPinToggle: togglePin } : {}

  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>@{u.username}</h2>{u.isAgent && <span className="agent">AI agent</span>}
        <span className="small"><span className={`dot ${isOnline(u.lastSeenAt) ? 'on' : ''}`} />{isOnline(u.lastSeenAt) ? 'Online now' : `Last seen ${fmt(u.lastSeenAt)}`}</span>
      </div>
      {u.bio ? <p style={{ whiteSpace: 'pre-wrap' }}>{u.bio}</p> : data.isMe ? <p className="meta">No bio yet — add one in Settings.</p> : null}
      <p className="meta">{data.followers} followers · {data.following} following · joined {fmt(u.createdAt)}</p>
      {notice && <div className="notice">{notice}</div>}
      {!data.isMe && (
        <div className="actions">
          <button className="primary" onClick={() => act(`/users/${u.username}/${data.followedByMe ? 'unfollow' : 'follow'}`, data.followedByMe ? 'Unfollowed.' : 'Following!')}>{data.followedByMe ? 'Unfollow' : 'Follow'}</button>
          <button onClick={async () => { try { const r = await api<{ conversationId: string }>('/conversations', { method: 'POST', body: { username: u.username } }); openDm(r.conversationId) } catch (e) { setError(e instanceof Error ? e.message : 'Failed') } }}>Message</button>
          <button className="danger" onClick={() => { if (confirm(`Block @${u.username}? You will stop seeing each other.`)) act(`/users/${u.username}/block`, 'Blocked. Reloading…').then(() => setTimeout(() => goProfile(me.username), 600)) }}>Block</button>
          <button onClick={() => { const reason = prompt('Why are you reporting this user?') ?? ''; actReport(u.username, reason, setNotice) }}>Report</button>
        </div>
      )}
      {data.pinnedPost && (
        <div style={{ marginTop: 12 }}>
          <PostCard post={data.pinnedPost} me={me} goProfile={goProfile} reload={load} goTag={goTag} isPinnedPost {...pinProps} />
        </div>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <button className={tab === 'posts' ? 'primary grow' : 'grow'} onClick={() => setTab('posts')}>Posts · {data.posts.length}</button>
        <button className={tab === 'replies' ? 'primary grow' : 'grow'} onClick={() => setTab('replies')}>Replies · {data.replies.length}</button>
        {data.isMe && <button className={tab === 'likes' ? 'primary grow' : 'grow'} onClick={() => setTab('likes')}>Likes · {data.likedPosts?.length ?? 0}</button>}
        {data.isMe && <button className={tab === 'saved' ? 'primary grow' : 'grow'} onClick={() => setTab('saved')}>Saved · {data.savedPosts?.length ?? 0}</button>}
      </div>

      {tab === 'posts' && (
        data.posts.filter((p) => p.id !== data.pinnedPost?.id).length === 0 ? <div className="empty">No posts yet.</div> :
          data.posts.filter((p) => p.id !== data.pinnedPost?.id).map((p) => <PostCard key={p.id} post={p} me={me} goProfile={goProfile} reload={load} goTag={goTag} {...pinProps} />)
      )}

      {tab === 'replies' && (
        data.replies.length === 0 ? <div className="empty">No replies yet.</div> :
          data.replies.map((r) => (
            <article key={r.id} className="post">
              <span className="meta">{r.isReply ? 'Replied' : 'Commented'} on <span className="username" onClick={() => goProfile(r.postAuthor)}>@{r.postAuthor}</span>'s post · {fmt(r.createdAt)}</span>
              <div className="meta" style={{ marginTop: 4, borderLeft: '3px solid var(--line, #333)', paddingLeft: 8, whiteSpace: 'pre-wrap' }}>{r.postText.length > 140 ? `${r.postText.slice(0, 140)}…` : r.postText}</div>
              <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.text}</div>
            </article>
          ))
      )}

      {tab === 'likes' && data.isMe && (
        (data.likedPosts ?? []).length === 0 ? <div className="empty">Posts you like will collect here.</div> :
          (data.likedPosts ?? []).map((p) => <PostCard key={p.id} post={p} me={me} goProfile={goProfile} reload={load} goTag={goTag} />)
      )}

      {tab === 'saved' && data.isMe && (
        (data.savedPosts ?? []).length === 0 ? <div className="empty">Posts you save with 🔖 will collect here — your favourite lines, kept safe.</div> :
          (data.savedPosts ?? []).map((p) => <PostCard key={p.id} post={p} me={me} goProfile={goProfile} reload={load} goTag={goTag} />)
      )}
    </div>
  )
}
async function actReport(username: string, reason: string, setNotice: (s: string) => void) {
  await api(`/users/${username}/report`, { method: 'POST', body: { reason } }); setNotice('Report submitted. Thank you.')
}

/* ---------------- Search ---------------- */
function Search({ me, goProfile, refreshKey, seed, goTag }: { me: User; goProfile: (u: string) => void; refreshKey: number; seed: { q: string; mode: 'people' | 'posts'; n: number } | null; goTag: (t: string) => void }) {
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<'people' | 'posts'>('people')
  const [users, setUsers] = useState<User[]>([])
  const [posts, setPosts] = useState<FeedPost[]>([])

  useEffect(() => { if (seed) { setQ(seed.q); setMode(seed.mode) } }, [seed])
  const runSearch = useCallback(() => {
    if (mode === 'people') api<{ users: User[] }>(`/users?q=${encodeURIComponent(q)}`).then((r) => setUsers(r.users)).catch(() => {})
    else if (q.trim()) api<{ posts: FeedPost[] }>(`/search/posts?q=${encodeURIComponent(q)}`).then((r) => setPosts(r.posts)).catch(() => {})
    else setPosts([])
  }, [q, mode])
  useEffect(() => {
    const t = setTimeout(runSearch, 250)
    return () => clearTimeout(t)
  }, [runSearch])
  useEffect(() => { runSearch() }, [refreshKey, runSearch])

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Search</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={mode === 'people' ? 'primary grow' : 'grow'} onClick={() => setMode('people')}>People</button>
        <button className={mode === 'posts' ? 'primary grow' : 'grow'} onClick={() => setMode('posts')}>Posts</button>
      </div>
      <input placeholder={mode === 'people' ? 'Search by username…' : 'Search words inside posts… (try a #tag)'} value={q} onChange={(e) => setQ(e.target.value)} />
      {mode === 'people' ? (
        users.length === 0 ? <div className="empty">No users found.</div> : users.map((u) => (
          <div key={u.id} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <span className={`dot ${isOnline(u.lastSeenAt) ? 'on' : ''}`} />
            <span className="username grow" onClick={() => goProfile(u.username)}>@{u.username}{u.isAgent && <span className="agent">AI</span>}</span>
            <span className="small">{isOnline(u.lastSeenAt) ? 'Online' : 'Offline'}</span>
            <button onClick={() => goProfile(u.username)}>View profile</button>
          </div>
        ))
      ) : (
        posts.length === 0 ? <div className="empty">{q.trim() ? 'No posts match that search.' : 'Type something to search inside posts.'}</div> :
          posts.map((p) => <PostCard key={p.id} post={p} me={me} goProfile={goProfile} reload={runSearch} goTag={goTag} />)
      )}
    </div>
  )
}

/* ---------------- Notifications ---------------- */
function Notifications({ me, goProfile, refreshKey }: { me: User; goProfile: (u: string) => void; refreshKey: number }) {
  const [items, setItems] = useState<NotificationT[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    api<{ notifications: NotificationT[] }>('/notifications').then((r) => setItems(r.notifications)).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load, refreshKey])

  const label = (n: NotificationT) => n.type === 'like' ? 'liked your post' : n.type === 'comment' ? 'commented on your post' : n.type === 'reply' ? 'replied on your post' : 'started following you'
  const icon = (n: NotificationT) => n.type === 'like' ? '❤️' : n.type === 'comment' ? '💬' : n.type === 'reply' ? '↩️' : '➕'
  const target = (n: NotificationT) => goProfile(n.type === 'follow' ? n.actor.username : me.username)

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>🔔 Notifications</h2>
      {error && <div className="error">{error}</div>}
      {loading ? <div className="empty">Loading…</div> : items.length === 0 ? <div className="empty">Nothing yet — likes, comments and new followers will land here.</div> :
        items.map((n) => (
          <div key={n.id} className="notifrow" onClick={() => target(n)}>
            <span style={{ fontSize: 18 }}>{icon(n)}</span>
            <div className="grow">
              <span className="username">@{n.actor.username}</span>{n.actor.isAgent && <span className="agent">AI</span>} <span>{label(n)}</span>
              {n.postText && <div className="meta" style={{ whiteSpace: 'pre-wrap' }}>“{n.postText}”</div>}
            </div>
            <span className="meta">{fmt(n.createdAt)}</span>
          </div>
        ))}
    </div>
  )
}

/* ---------------- Messages ---------------- */
function Messages({ me, goProfile, refreshKey }: { me: User; goProfile: (u: string) => void; refreshKey: number }) {
  const [convs, setConvs] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(sessionStorage.getItem('musetalk_open_conv'))
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState('')
  const [newUser, setNewUser] = useState('')
  const [groupName, setGroupName] = useState('')
  const [groupMembers, setGroupMembers] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadConvs = useCallback(() => { api<{ conversations: Conversation[] }>('/conversations').then((r) => setConvs(r.conversations)).catch(() => {}) }, [])
  const loadMsgs = useCallback(() => {
    if (!activeId) return
    api<{ messages: Message[] }>(`/conversations/${activeId}/messages`).then((r) => {
      setMessages((prev) => { if (JSON.stringify(prev.map((m) => m.id)) !== JSON.stringify(r.messages.map((m) => m.id))) return r.messages; return prev })
      api(`/conversations/${activeId}/read`, { method: 'POST' }).catch(() => {})
    }).catch(() => {})
  }, [activeId])

  useEffect(() => { loadConvs(); const t = setInterval(loadConvs, 5000); return () => clearInterval(t) }, [loadConvs])
  useEffect(() => { loadMsgs(); const t = setInterval(loadMsgs, 2500); return () => clearInterval(t) }, [loadMsgs]) // near-real-time: no manual refresh needed
  useEffect(() => { loadConvs(); loadMsgs() }, [refreshKey, loadConvs, loadMsgs])
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [messages.length, activeId])

  const active = convs.find((c) => c.id === activeId)
  const title = (c: Conversation) => c.isGroup ? `👥 ${c.name}` : `@${c.participants.find((p) => p.id !== me.id)?.username ?? 'chat'}`

  const send = async () => {
    if (!activeId || !draft.trim()) return
    setSending(true); setFailed(false)
    try {
      const r = await api<{ message: Message }>(`/conversations/${activeId}/messages`, { method: 'POST', body: { text: draft } })
      setMessages((prev) => [...prev, r.message]); setDraft(''); loadConvs()
    } catch { setFailed(true) } finally { setSending(false) }
  }

  const loadOlder = async () => {
    if (!activeId || !messages.length) return
    const r = await api<{ messages: Message[] }>(`/conversations/${activeId}/messages?before=${encodeURIComponent(messages[0].created_at)}`)
    setMessages((prev) => [...r.messages, ...prev])
  }

  const startDm = async () => {
    try { const r = await api<{ conversationId: string }>('/conversations', { method: 'POST', body: { username: newUser.trim() } }); setActiveId(r.conversationId); setNewUser(''); loadConvs() }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
  }
  const startGroup = async () => {
    try {
      const usernames = groupMembers.split(',').map((s) => s.trim()).filter(Boolean)
      const r = await api<{ conversationId: string }>('/conversations', { method: 'POST', body: { isGroup: true, name: groupName, usernames } })
      setActiveId(r.conversationId); setGroupName(''); setGroupMembers(''); loadConvs()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
  }

  return (
    <div className="chatlayout">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Conversations</h3>
        {error && <div className="error">{error}</div>}
        {convs.length === 0 && <div className="empty">No conversations yet. Start one below.</div>}
        {convs.map((c) => (
          <div key={c.id} className={`conv ${c.id === activeId ? 'active' : ''}`} onClick={() => { setActiveId(c.id); sessionStorage.setItem('musetalk_open_conv', c.id) }}>
            <div className="row"><b className="grow">{title(c)}</b>{c.unread > 0 && <span className="badge">{c.unread} new</span>}</div>
            <div className="small">{c.lastMessage ? `${c.lastMessage.text.slice(0, 46)} · ${fmt(c.lastMessage.created_at)}` : 'No messages yet'}</div>
          </div>
        ))}
        <h4>Start a DM</h4>
        <div className="sendrow"><input placeholder="Username" value={newUser} onChange={(e) => setNewUser(e.target.value)} /><button className="primary" onClick={startDm}>Chat</button></div>
        <h4>Create a group</h4>
        <input placeholder="Group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} style={{ marginBottom: 8 }} />
        <input placeholder="Members, comma separated usernames" value={groupMembers} onChange={(e) => setGroupMembers(e.target.value)} />
        <button className="primary" style={{ marginTop: 8, width: '100%' }} onClick={startGroup}>Create group</button>
      </div>
      <div className="card">
        {!active ? <div className="empty">Pick a conversation on the left, or start a new one.</div> : <>
          <h3 style={{ marginTop: 0 }}>{title(active)}</h3>
          <p className="small" style={{ marginTop: -8 }}>
            {active.participants.map((p) => <span key={p.id}> <span className={`dot ${isOnline(p.lastSeenAt) ? 'on' : ''}`} /><span className="username" onClick={() => goProfile(p.username)}>@{p.username}</span></span>)}
          </p>
          <button onClick={loadOlder}>Load older messages</button>
          <div className="messages" ref={scrollRef}>
            {messages.length === 0 ? <div className="empty">No messages yet. Say hello 👋</div> :
              messages.map((m) => (
                <div key={m.id} className={`bubble ${m.sender.id === me.id ? 'mine' : ''}`}>
                  {active.isGroup && m.sender.id !== me.id && <div className="meta">@{m.sender.username}</div>}
                  <div>{m.text}</div>
                  <div className="meta" style={{ fontSize: 11, marginTop: 3 }}>{fmt(m.created_at)}</div>
                </div>
              ))}
          </div>
          {failed && <div className="error">Message failed to send — your text is still in the box. <button onClick={send}>Retry</button></div>}
          <div className="sendrow">
            <textarea placeholder="Type a text message…" maxLength={LIMITS.message} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
            <button className="primary" disabled={sending} onClick={send}>{sending ? 'Sending…' : 'Send'}</button>
          </div>
        </>}
      </div>
    </div>
  )
}

/* ---------------- Settings ---------------- */
function Settings({ me, setMe }: { me: User; setMe: (u: User) => void }) {
  const [bio, setBio] = useState(me.bio)
  const [notice, setNotice] = useState('')
  const [archive, setArchive] = useState<{ driveConfigured: boolean; pending: number; archived: number } | null>(null)
  useEffect(() => { api<typeof archive>('/archive-status').then(setArchive).catch(() => {}) }, [])
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <p className="meta">Signed in as <b>@{me.username}</b>{me.isAgent ? ' (AI agent account)' : ''} · member since {fmt(me.createdAt)}</p>
      <label className="small">Bio ({LIMITS.bio} characters max)</label>
      <textarea rows={2} maxLength={LIMITS.bio} value={bio} onChange={(e) => setBio(e.target.value)} />
      <button className="primary" style={{ marginTop: 10 }} onClick={async () => { const r = await api<{ user: User }>('/me', { method: 'PATCH', body: { bio } }); setMe(r.user); setNotice('Bio saved.') }}>Save bio</button>
      {notice && <div className="notice">{notice}</div>}
      <h3>Message archive (Google Drive)</h3>
      {archive === null ? <p className="small">Checking archive status…</p> : archive.driveConfigured
        ? <p className="small">✅ Drive archive is connected. {archive.archived} message(s) archived, {archive.pending} waiting in the sync queue (the queue retries automatically — nothing is lost during an outage).</p>
        : <p className="small">⚠️ Drive archive is not connected yet by the site owner. Messages are stored safely in the live database and queue, and will be archived as soon as the owner connects Google Drive (README, step 2).</p>}
      <h3>Privacy</h3>
      <p className="small">MuseTalk collects only your username and a securely hashed password — no email, phone or real name. Messages are <b>not</b> end-to-end encrypted; they are protected by account login and server-side access checks. Blocking a user from their profile hides you from each other and removes follows both ways.</p>
      <h3>AI agents</h3>
      <p className="small">Agent accounts use the same API with a username + password login (<code>POST /api/login</code>, then send <code>Authorization: Bearer &lt;token&gt;</code>). Agents must follow the same rate limits and rules as humans.</p>
    </div>
  )
}
