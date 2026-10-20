export interface PlayerAuthEnv {
  DB: D1Database
  PLAYER_AUTH_SECRET?: string
}

export interface PlayerSession {
  tokenHash: string
  playerId: string
  userId: string | null
  username: string | null
  expiresAt: number
}

const SESSION_SECONDS = 30 * 24 * 60 * 60
const RATE_WINDOW_MS = 15 * 60 * 1000
// Production Workers currently cap native PBKDF2 at 100,000 iterations.
// A separate Worker secret peppers the derived value; never store it in D1.
const PASSWORD_ITERATIONS = 100_000
const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesFromHex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/.{2}/g) || [], (pair) => Number.parseInt(pair, 16))
}

export async function digestToken(token: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(token)))
}

export function normalizeUsername(value: unknown): { username: string; key: string } | null {
  if (typeof value !== 'string') return null
  const username = value.trim()
  return /^[A-Za-z0-9_]{3,24}$/.test(username) ? { username, key: username.toLowerCase() } : null
}

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length >= 10 && value.length <= 128
}

export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

async function derivePassword(password: string, salt: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: PASSWORD_ITERATIONS, salt: bytesFromHex(salt) }, key, 256)
  const pepper = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', pepper, encoder.encode(`apvsap-player-password-v1:${hex(derived)}`)))
}

export async function hashPassword(password: string, secret: string): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer)
  return `pbkdf2-sha256-pepper-v1$${PASSWORD_ITERATIONS}$${salt}$${await derivePassword(password, salt, secret)}`
}

export async function verifyPassword(password: string, stored: string, secret: string): Promise<boolean> {
  if (stored.split('$').length !== 4) return false
  const [version, iterations, salt, expected] = stored.split('$')
  if (version !== 'pbkdf2-sha256-pepper-v1' || iterations !== String(PASSWORD_ITERATIONS) || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{64}$/.test(expected || '')) return false
  return constantTimeEqual(await derivePassword(password, salt, secret), expected)
}

function cookieName(request: Request): string {
  return new URL(request.url).protocol === 'https:' ? '__Host-apvsap_player' : 'apvsap_player_dev'
}

function cookieToken(request: Request): string | null {
  const name = cookieName(request)
  const entry = (request.headers.get('Cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  const token = entry?.slice(name.length + 1)
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null
}

export function playerCookie(request: Request, token: string | null): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${cookieName(request)}=${token || ''}; Path=/; Max-Age=${token ? SESSION_SECONDS : 0}; HttpOnly${secure}; SameSite=Strict`
}

export async function playerSession(request: Request, env: PlayerAuthEnv): Promise<PlayerSession | null> {
  const token = cookieToken(request)
  if (!token) return null
  const tokenHash = await digestToken(token)
  const row = await env.DB.prepare(`SELECT s.player_id, s.user_id, s.expires_at, a.username
    FROM player_sessions s LEFT JOIN player_accounts a ON a.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, Date.now()).first<{ player_id: string; user_id: string | null; expires_at: number; username: string | null }>()
  return row ? { tokenHash, playerId: row.player_id, userId: row.user_id, username: row.username, expiresAt: row.expires_at } : null
}

export function publicPlayer(session: PlayerSession) {
  // This non-bearer fingerprint lets another tab reconnect after token rotation.
  return { id: session.playerId, sessionKey: session.tokenHash.slice(0, 16), kind: session.userId ? 'account' : 'guest', username: session.username }
}

function json(payload: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Cache-Control', 'no-store')
  return Response.json(payload, { status, headers: responseHeaders })
}

async function consumeLimit(env: PlayerAuthEnv, scope: string, identifier: string, maximum: number): Promise<boolean> {
  const key = `${scope}:${await digestToken(identifier)}`
  const now = Date.now()
  const row = await env.DB.prepare(`INSERT INTO player_auth_limits (key, attempts, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    RETURNING attempts`).bind(key, now + RATE_WINDOW_MS, now, now).first<{ attempts: number }>()
  return Boolean(row && row.attempts <= maximum)
}

async function readCredentials(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 4096) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch { return null }
}

export async function handlePlayerAuth(
  request: Request,
  env: PlayerAuthEnv,
  revokeSockets: (tokenHash: string, preserveSeat?: boolean) => Promise<void>,
  resolveAccountSeat: (accountId: string, guestSeat: string | null) => Promise<string | null> = async (accountId) => `user:${accountId}`,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/api/auth/session') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
    const session = await playerSession(request, env)
    return json({ player: session ? publicPlayer(session) : null })
  }
  if (!['/api/auth/register', '/api/auth/login', '/api/auth/guest', '/api/auth/logout'].includes(path)) return json({ error: 'Not found' }, 404)
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: '请求来源不正确，请从本站操作。' }, 403)
  const previous = await playerSession(request, env)
  if (path === '/api/auth/logout') {
    if (previous) {
      await env.DB.prepare('DELETE FROM player_sessions WHERE token_hash = ?').bind(previous.tokenHash).run()
      await revokeSockets(previous.tokenHash)
    }
    return json({ player: null }, 200, { 'Set-Cookie': playerCookie(request, null) })
  }
  if (path === '/api/auth/guest' && previous) return json({ player: publicPlayer(previous) })
  const mode = path.split('/').pop()!
  const ip = request.headers.get('CF-Connecting-IP') || 'local'
  if (!await consumeLimit(env, `ip-${mode}`, ip, mode === 'register' ? 6 : mode === 'login' ? 20 : 30)) {
    return json({ error: '操作太频繁，请 15 分钟后再试。' }, 429, { 'Retry-After': '900' })
  }
  let userId: string | null = null
  let username: string | null = null
  if (mode !== 'guest') {
    if (!env.PLAYER_AUTH_SECRET) return json({ error: '账号服务暂时不可用，仍可选择游客游玩。' }, 503)
    const credentials = await readCredentials(request)
    const name = normalizeUsername(credentials?.username)
    const password = credentials?.password
    if (!name) return json({ error: '用户名需为 3–24 位英文字母、数字或下划线。' }, 400)
    if (!validPassword(password)) return json({ error: '密码需为 10–128 个字符，建议使用独立的长密码。' }, 400)
    if (mode === 'register') {
      userId = crypto.randomUUID()
      username = name.username
      const passwordHash = await hashPassword(password, env.PLAYER_AUTH_SECRET)
      // INSERT OR IGNORE plus the UNIQUE index makes duplicate races safe.
      const result = await env.DB.prepare('INSERT OR IGNORE INTO player_accounts (id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, username, name.key, passwordHash, Date.now()).run()
      if (!result.meta.changes) return json({ error: '这个用户名已被使用，请换一个。' }, 409)
    } else {
      if (!await consumeLimit(env, 'account-login', name.key, 10)) return json({ error: '操作太频繁，请 15 分钟后再试。' }, 429, { 'Retry-After': '900' })
      const account = await env.DB.prepare('SELECT id, username, password_hash FROM player_accounts WHERE username_key = ?').bind(name.key).first<{ id: string; username: string; password_hash: string }>()
      // Missing accounts still perform the same KDF to avoid a cheap timing oracle.
      const dummy = `pbkdf2-sha256-pepper-v1$${PASSWORD_ITERATIONS}$${'0'.repeat(32)}$${'0'.repeat(64)}`
      const valid = await verifyPassword(password, account?.password_hash || dummy, env.PLAYER_AUTH_SECRET)
      if (!account || !valid) return json({ error: '用户名或密码不正确。' }, 401)
      userId = account.id
      username = account.username
      await env.DB.prepare('DELETE FROM player_auth_limits WHERE key = ?').bind(`account-login:${await digestToken(name.key)}`).run()
    }
  }
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const tokenHash = await digestToken(token)
  const playerId = userId ? await resolveAccountSeat(userId, previous && !previous.userId ? previous.playerId : null) : `guest:${crypto.randomUUID()}`
  if (!playerId) {
    // This brand-new account has never been exposed or authenticated. Roll it
    // back if a concurrent upgrade claimed the same guest before us.
    if (mode === 'register' && userId) await env.DB.prepare('DELETE FROM player_accounts WHERE id = ?').bind(userId).run()
    return json({ error: '账号与游客正在不同的对话中，请先结束其中一局再登录。当前游客对话已保留。' }, 409)
  }
  const relocated = userId ? await env.DB.prepare('SELECT token_hash FROM player_sessions WHERE user_id = ? AND player_id != ? AND expires_at > ?').bind(userId, playerId, Date.now()).all<{ token_hash: string }>() : null
  const expiresAt = Date.now() + SESSION_SECONDS * 1000
  const statements = [env.DB.prepare('INSERT INTO player_sessions (token_hash, user_id, player_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(tokenHash, userId, playerId, Date.now(), expiresAt)]
  if (userId) statements.push(env.DB.prepare('UPDATE player_sessions SET player_id = ? WHERE user_id = ?').bind(playerId, userId))
  if (userId) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO player_seat_owners(player_id,account_id,claimed_at) VALUES(?,?,?)').bind(playerId, userId, Date.now()))
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO player_seat_owners(player_id,account_id,claimed_at) VALUES(?,?,?)').bind(`user:${userId}`, userId, Date.now()))
  }
  if (previous) statements.push(env.DB.prepare('DELETE FROM player_sessions WHERE token_hash = ?').bind(previous.tokenHash))
  await env.DB.batch(statements)
  if (previous) await revokeSockets(previous.tokenHash, previous.playerId === playerId)
  for (const session of relocated?.results || []) await revokeSockets(session.token_hash)
  return json({ player: publicPlayer({ tokenHash, playerId, userId, username, expiresAt }) }, mode === 'register' ? 201 : 200, { 'Set-Cookie': playerCookie(request, token) })
}
