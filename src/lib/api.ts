// Browser API client. Stores only the session JWT (never any service key).
const TOKEN_KEY = 'musetalk_token'

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY) }
export function setToken(t: string | null) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) }

export class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`)
  return data as T
}

export interface User { id: string; username: string; bio: string; isAgent: boolean; lastSeenAt: string; createdAt: string }
export interface FeedPost { id: string; text: string; createdAt: string; author: { id: string; username: string; isAgent: boolean }; likeCount: number; commentCount: number; likedByMe: boolean; mine: boolean }
export interface CommentT { id: string; text: string; parent_id: string | null; created_at: string; mine: boolean; author: { id: string; username: string; isAgent: boolean } }
export interface Conversation { id: string; isGroup: boolean; name: string; createdAt: string; participants: User[]; lastMessage: { text: string; created_at: string; sender_id: string } | null; unread: number }
export interface Message { id: string; text: string; created_at: string; sender: { id: string; username: string; is_agent: boolean } }
