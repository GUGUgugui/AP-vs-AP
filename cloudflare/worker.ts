import { DurableObject } from 'cloudflare:workers'
import { AI_GENERATION_PARAMETERS, aiReadPauseMs, aiReplyDelayMs, aiReplyIssues, aiReplyRetryHint, buildAiSystemPrompt } from './ai-behavior'
import { AI_PERSONAS } from './ai-personas'
import { parseAiReply } from './ai-response'
import { humanStyleProfile, summarizeHumanStyle, type HumanStyleProfile, type HumanStyleTotals } from './style-learning'
import { canPlayerGuess, MIN_MESSAGES_BEFORE_GUESS, guessFromPayload, legacyGuessValue, readIdentityGuess, type IdentityGuess } from './identity-guess'
import { handlePlayerAuth, playerSession } from './player-auth'
import { chooseAccountSeat } from './account-seat'
import { playerFeatures, communityFeatures, unlockPlayerBadges } from './player-features'
import type { EndReason } from './player-rules'
import { refreshTrainingSample } from './training-dataset'

interface Env {
  LOBBY: DurableObjectNamespace<MistLobby>
  ASSETS: Fetcher
  DB: D1Database
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_MODEL: string
  RETENTION_DAYS: string
  PROMPT_VERSION: string
  ADMIN_PASSWORD?: string
  ADMIN_SESSION_SECRET?: string
  PLAYER_AUTH_SECRET?: string
}

type MatchKind = 'human' | 'ai'
type MatchStatus = 'active' | 'revealed'

interface Player {
  sessionId: string
  codename: string
  connected: boolean
  styleOptIn?: boolean
}

interface Persona {
  codename: string
  temperament: string
  cadence: string
  humor: string
  uncertainty: string
  initiative: string
  worldview: string
  preferences: string
  speechHabits: string
  friction: string
}

interface GameMessage {
  id: string
  authorId: string
  content: string
  source: 'human' | 'ai' | 'admin'
  createdAt: number
  visibleTo?: string[]
}

interface GuessState {
  guess?: IdentityGuess
  humanProbability?: number
  updatedAt: number
}

interface GameMatch {
  id: string
  kind: MatchKind
  status: MatchStatus
  playerIds: string[]
  aiPersona?: Persona
  messages: GameMessage[]
  guesses: Record<string, GuessState>
  createdAt: number
  revealedAt?: number
  aiBusy?: boolean
  aiMemory?: string[]
  styleConsent?: Record<string, boolean>
  learnedStyle?: HumanStyleProfile | null
  styleVariant?: 'baseline' | 'learned'
  endReason?: EndReason
}

interface AiReplyResult {
  reply: string | null
  memory: string[]
  fallback: boolean
}

interface LobbyState {
  players: Record<string, Player>
  matches: Record<string, GameMatch>
  playerMatches: Record<string, string>
  accountSeats?: Record<string, string>
  waiting: Array<{ sessionId: string; readyAt: number }>
  humanSeats: number
  aiSeats: number
}

type SocketAttachment =
  | { kind: 'player'; sessionId: string; tokenHash?: string; expiresAt?: number }
  | { kind: 'admin' }

interface ClientEnvelope {
  type: 'match:join' | 'match:leave' | 'match:skip' | 'match:cancel' | 'style:revoke' | 'typing:update' | 'message:send' | 'guess:update' | 'match:reveal' | 'admin:inject' | 'admin:refresh'
  payload?: Record<string, unknown>
}

const MATCH_WINDOW_MS = 2400
const MAX_MESSAGE_LENGTH = 2000
const STATE_KEY = 'lobby-state-v1'
const ADMIN_COOKIE = 'apvsap_admin'
const ADMIN_SESSION_SECONDS = 12 * 60 * 60
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 6

const ADJECTIVES = ['迟来的', '安静的', '偏航的', '清醒的', '潮湿的', '逆光的', '失眠的', '缓慢的']
const NOUNS = ['信号', '候鸟', '电台', '回声', '雨幕', '底片', '灯塔', '磁带']
const PERSONAS: readonly Omit<Persona, 'codename'>[] = AI_PERSONAS

function emptyState(): LobbyState {
  return { players: {}, matches: {}, playerMatches: {}, waiting: [], humanSeats: 0, aiSeats: 0 }
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function codenameFor(seed: string): string {
  const hash = hashString(seed)
  return `${ADJECTIVES[hash % ADJECTIVES.length]}${NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length]}`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signAdminValue(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return base64Url(new Uint8Array(signature))
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

async function passwordMatches(candidate: string, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) return false
  const [candidateHash, passwordHash] = await Promise.all([
    signAdminValue(env.ADMIN_SESSION_SECRET, `password:${candidate}`),
    signAdminValue(env.ADMIN_SESSION_SECRET, `password:${env.ADMIN_PASSWORD}`),
  ])
  return constantTimeEqual(candidateHash, passwordHash)
}

async function createAdminCookie(env: Env, request: Request): Promise<string> {
  if (!env.ADMIN_SESSION_SECRET) throw new Error('ADMIN_SESSION_SECRET is missing')
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS
  const value = String(expiresAt)
  const signature = await signAdminValue(env.ADMIN_SESSION_SECRET, value)
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${ADMIN_COOKIE}=${value}.${signature}; Path=/admin; Max-Age=${ADMIN_SESSION_SECONDS}; HttpOnly${secure}; SameSite=Strict`
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie') || ''
  for (const item of cookies.split(';')) {
    const [key, ...rest] = item.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

async function isAdminRequest(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_SESSION_SECRET) return false
  const token = readCookie(request, ADMIN_COOKIE)
  if (!token) return false
  const separator = token.indexOf('.')
  if (separator < 1) return false
  const expiresAt = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false
  const expected = await signAdminValue(env.ADMIN_SESSION_SECRET, expiresAt)
  return constantTimeEqual(signature, expected)
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  return Boolean(origin && origin === new URL(request.url).origin)
}

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Cache-Control', 'no-store')
  return Response.json(payload, { status, headers: responseHeaders })
}

function clearAdminCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
}

export class MistLobby extends DurableObject<Env> {
  private state: LobbyState = emptyState()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<LobbyState>(STATE_KEY) || emptyState()
      // Recover seat ownership for accounts upgraded before personal history existed.
      for (const [accountId, seat] of Object.entries(this.state.accountSeats || {})) {
        await this.env.DB.prepare('INSERT OR IGNORE INTO player_seat_owners(player_id,account_id,claimed_at) SELECT ?,id,? FROM player_accounts WHERE id=?').bind(seat, Date.now(), accountId).run()
      }
      if (this.pruneRevealedState()) await ctx.storage.put(STATE_KEY, this.state)
      for (const player of Object.values(this.state.players)) player.connected = false
      for (const match of Object.values(this.state.matches)) {
        if (match.aiPersona) {
          const defaults = PERSONAS[hashString(match.id) % PERSONAS.length]
          match.aiPersona = { ...defaults, ...match.aiPersona }
          match.aiMemory ||= []
        }
        if (match.status === 'revealed') ctx.waitUntil(this.archiveMatch(match))
      }
      for (const socket of ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null
        const sessionId = attachment && 'sessionId' in attachment ? attachment.sessionId : undefined
        if (sessionId && this.state.players[sessionId]) {
          this.state.players[sessionId].connected = true
        }
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/internal/player-match' && request.method === 'POST') {
      const { playerId, matchId, report } = await request.json() as { playerId: string; matchId: string; report: boolean }
      const match = this.state.matches[matchId]
      if (!match || !match.playerIds.includes(playerId)) return jsonResponse({ error: 'Not found' }, 404)
      if (match.status === 'active') {
        if (!report) return jsonResponse({ error: 'Still active' }, 409)
        await this.finishMatch(match, 'reported')
      }
      await this.archiveMatch(match)
      return jsonResponse({ ready: true })
    }
    if (url.pathname === '/internal/claim-account-seat' && request.method === 'POST') {
      const { accountId, guestSeat } = await request.json() as { accountId: string; guestSeat: string | null }
      if (!/^[a-f0-9-]{36}$/.test(accountId) || (guestSeat !== null && !/^guest:[a-f0-9-]{36}$/.test(guestSeat))) return Response.json({ error: 'Invalid identity' }, { status: 400 })
      const accountSeats = this.state.accountSeats ||= {}
      const owner = guestSeat ? await this.env.DB.prepare('SELECT account_id FROM player_seat_owners WHERE player_id=?').bind(guestSeat).first<{ account_id: string }>() : null
      const accountSeat = accountSeats[accountId] || `user:${accountId}`
      const isBusy = (seat: string) => this.getMatchForPlayer(seat)?.status === 'active' || this.state.waiting.some((entry) => entry.sessionId === seat)
      const playerId = chooseAccountSeat({
        accountSeat, guestSeat, accountBusy: isBusy(accountSeat), guestBusy: Boolean(guestSeat && isBusy(guestSeat)),
        guestOwnedByAnotherAccount: Boolean(owner && owner.account_id !== accountId) || Boolean(guestSeat && Object.entries(accountSeats).some(([id, seat]) => id !== accountId && seat === guestSeat)),
      })
      if (!playerId) return Response.json({ error: 'Seat conflict' }, { status: 409 })
      accountSeats[accountId] = playerId
      await this.persist()
      return Response.json({ playerId })
    }
    if (url.pathname === '/internal/revoke-player-session' && request.method === 'POST') {
      const { tokenHash, preserveSeat } = await request.json() as { tokenHash: string; preserveSeat?: boolean }
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null
        if (attachment?.kind === 'player' && attachment.tokenHash === tokenHash) socket.close(4001, preserveSeat ? 'identity refreshed' : 'session revoked')
      }
      return Response.json({ revoked: true })
    }
    if (url.pathname.startsWith('/internal/forget-match/') && request.method === 'POST') {
      const matchId = url.pathname.slice('/internal/forget-match/'.length)
      const match = this.state.matches[matchId]
      if (match?.status === 'revealed') {
        delete this.state.matches[matchId]
        for (const playerId of match.playerIds) {
          if (this.state.playerMatches[playerId] === matchId) delete this.state.playerMatches[playerId]
        }
        await this.persist()
      }
      return Response.json({ forgotten: true })
    }

    if (url.pathname === '/admin/api/login' && request.method === 'POST') {
      return this.adminLogin(request)
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 })
    }

    if (url.pathname === '/admin/ws') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.ctx.acceptWebSocket(server, ['admin'])
      server.serializeAttachment({ kind: 'admin' } satisfies SocketAttachment)
      this.send(server, 'admin:snapshot', this.adminSnapshot())
      return new Response(null, { status: 101, webSocket: client })
    }

    const identity = await playerSession(request, this.env)
    if (!identity) return new Response('Player session required', { status: 401 })
    const sessionId = identity.playerId
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.ctx.acceptWebSocket(server, [`player:${sessionId}`])
    server.serializeAttachment({ kind: 'player', sessionId, tokenHash: identity.tokenHash, expiresAt: identity.expiresAt } satisfies SocketAttachment)
    this.state.players[sessionId] = {
      sessionId,
      codename: this.state.players[sessionId]?.codename || codenameFor(sessionId),
      connected: true,
      styleOptIn: this.state.players[sessionId]?.styleOptIn ?? true,
    }
    await this.persist()

    this.send(server, 'player:ready', { codename: this.state.players[sessionId].codename })
    const restored = this.getMatchForPlayer(sessionId)
    if (restored?.status === 'active') this.send(server, 'match:found', this.snapshot(restored, sessionId))
    if (restored?.status === 'revealed' && !this.state.waiting.some(entry => entry.sessionId === sessionId)) this.send(server, 'match:revealed', this.snapshot(restored, sessionId, true))
    if (!restored || restored.status !== 'active') {
      const queued = this.state.waiting.find((entry) => entry.sessionId === sessionId)
      if (queued) this.send(server, 'match:searching', { waitMs: Math.max(0, queued.readyAt - Date.now()) })
    }
    if (restored?.status === 'active' && restored.kind === 'human') {
      const opponentId = restored.playerIds.find((id) => id !== sessionId)
      if (opponentId) this.sendTo(opponentId, 'opponent:connected', {})
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null
    if (!attachment) return
    if (attachment.kind === 'player') {
      const valid = attachment.tokenHash && attachment.expiresAt && attachment.expiresAt > Date.now()
        && await this.env.DB.prepare('SELECT 1 FROM player_sessions WHERE token_hash = ? AND player_id = ? AND expires_at > ?').bind(attachment.tokenHash, attachment.sessionId, Date.now()).first()
      if (!valid) { socket.close(4001, 'session expired'); return }
    }

    let envelope: ClientEnvelope
    try {
      envelope = JSON.parse(typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage))
    } catch {
      this.send(socket, 'error:message', { message: '无法识别这段信号' })
      return
    }

    const payload = envelope.payload || {}

    if (attachment.kind === 'admin') {
      if (envelope.type === 'admin:refresh') {
        this.send(socket, 'admin:snapshot', this.adminSnapshot())
      } else if (envelope.type === 'admin:inject') {
        await this.adminInject(socket, payload)
      }
      return
    }

    const sessionId = attachment.sessionId

    switch (envelope.type) {
      case 'match:join':
        await this.joinMatch(sessionId, payload.styleOptIn !== false)
        break
      case 'match:leave':
      case 'match:skip': {
        const current = this.getMatchForPlayer(sessionId)
        // Match-bound commands cannot accidentally terminate a replacement room.
        if (!current || current.id !== payload.matchId || current.status !== 'active') break
        await this.finishMatch(current, envelope.type === 'match:skip' ? 'skipped' : 'left')
        if (envelope.type === 'match:skip') await this.joinMatch(sessionId, payload.styleOptIn !== false)
        break
      }
      case 'match:cancel':
        if (this.getMatchForPlayer(sessionId)?.status === 'active') {
          this.sendTo(sessionId, 'match:found', this.snapshot(this.getMatchForPlayer(sessionId)!, sessionId))
          break
        }
        this.dequeue(sessionId)
        this.sendTo(sessionId, 'match:idle', {})
        await this.persist()
        await this.scheduleAlarm()
        break
      case 'style:revoke':
        await this.revokeStyleConsent(sessionId)
        break
      case 'typing:update':
        this.forwardTyping(sessionId, Boolean(payload.typing))
        break
      case 'message:send':
        await this.handleMessage(sessionId, typeof payload.content === 'string' ? payload.content : '')
        break
      case 'guess:update':
        await this.updateGuess(sessionId, guessFromPayload(payload))
        break
      case 'match:reveal':
        await this.reveal(sessionId, guessFromPayload(payload))
        break
    }
  }

  async webSocketClose(socket: WebSocket, _code: number, reason: string): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null
    if (!attachment || attachment.kind === 'admin') return
    const sessionId = attachment.sessionId
    if (!sessionId || !this.state.players[sessionId]) return

    const stillConnected = this.ctx.getWebSockets(`player:${sessionId}`).some((candidate) => candidate !== socket)
    this.state.players[sessionId].connected = stillConnected
    if (!stillConnected) {
      const refreshing = reason === 'identity refreshed'
      const queued = this.state.waiting.find((entry) => entry.sessionId === sessionId)
      if (refreshing && queued) {
        // Allow the newly issued Cookie to reconnect without losing its queue seat.
        queued.readyAt = Math.max(queued.readyAt, Date.now() + 3000)
        await this.scheduleAlarm()
      } else this.dequeue(sessionId)
      const match = this.getMatchForPlayer(sessionId)
      if (!refreshing && match?.status === 'active' && match.kind === 'human') {
        const opponentId = match.playerIds.find((id) => id !== sessionId)
        if (opponentId) this.sendTo(opponentId, 'opponent:disconnected', {})
      }
      await this.persist()
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const due = this.state.waiting.filter((entry) => entry.readyAt <= now).map((entry) => entry.sessionId)

    for (const sessionId of due) {
      if (!this.state.waiting.some((entry) => entry.sessionId === sessionId)) continue
      const player = this.state.players[sessionId]
      if (!player?.connected) {
        this.dequeue(sessionId)
        continue
      }

      const opponent = this.state.waiting.find((entry) => entry.sessionId !== sessionId && this.state.players[entry.sessionId]?.connected)
      if (opponent && this.shouldCreateHumanMatch()) {
        const match = this.createHumanMatch(sessionId, opponent.sessionId)
        this.emitMatchFound(match)
      } else {
        const match = this.createAiMatch(sessionId)
        this.emitMatchFound(match)
      }
    }

    await this.persist()
    await this.scheduleAlarm()
  }

  private async adminLogin(request: Request): Promise<Response> {
    if (!this.env.ADMIN_PASSWORD || !this.env.ADMIN_SESSION_SECRET) {
      return jsonResponse({ error: '管理后台尚未配置' }, 503)
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'local'
    const attemptKey = `admin-login:${hashString(ip).toString(16)}`
    const now = Date.now()
    const saved = await this.ctx.storage.get<{ attempts: number; windowStartedAt: number }>(attemptKey)
    const record = !saved || now - saved.windowStartedAt > LOGIN_WINDOW_MS
      ? { attempts: 0, windowStartedAt: now }
      : saved

    if (record.attempts >= LOGIN_MAX_ATTEMPTS) {
      return jsonResponse({ error: '尝试次数过多，请稍后再试' }, 429)
    }

    let password = ''
    try {
      const body = await request.json() as { password?: unknown }
      if (typeof body.password === 'string' && body.password.length <= 300) password = body.password
    } catch {
      // Invalid JSON is handled as a failed login.
    }

    if (!await passwordMatches(password, this.env)) {
      record.attempts += 1
      await this.ctx.storage.put(attemptKey, record)
      return jsonResponse({ error: '管理口令不正确' }, 401)
    }

    await this.ctx.storage.delete(attemptKey)
    return jsonResponse({ authenticated: true, expiresIn: ADMIN_SESSION_SECONDS })
  }

  private async adminInject(socket: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const matchId = typeof payload.matchId === 'string' ? payload.matchId : ''
    const targetSessionId = typeof payload.targetSessionId === 'string' ? payload.targetSessionId : ''
    const content = typeof payload.content === 'string' ? payload.content.trim() : ''
    const match = this.state.matches[matchId]

    if (!match || match.status !== 'active') {
      this.send(socket, 'admin:error', { message: '这段对话已经结束或不存在' })
      return
    }
    if (!match.playerIds.includes(targetSessionId)) {
      this.send(socket, 'admin:error', { message: '目标玩家不属于这段对话' })
      return
    }
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      this.send(socket, 'admin:error', { message: content ? '介入消息太长' : '介入消息不能为空' })
      return
    }

    const message = this.addMessage(match, `admin:${targetSessionId}`, content, 'admin', [targetSessionId])
    this.sendTo(targetSessionId, 'opponent:typing', false)
    this.sendTo(targetSessionId, 'message:receive', this.publicMessage(message, 'opponent'))
    await this.persist()
    this.ctx.waitUntil(this.env.DB.prepare(
      'INSERT INTO admin_actions (id, match_id, target_session_id, action_type, content, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_match_ids WHERE id = ?)',
    ).bind(crypto.randomUUID(), matchId, targetSessionId, 'inject_message', content, Date.now(), matchId).run().catch((error) => {
      console.error('Admin action archive failed', error instanceof Error ? error.message : 'unknown')
    }))
    this.send(socket, 'admin:injected', { matchId, targetSessionId, messageId: message.id })
  }

  private adminSnapshot() {
    const matches = Object.values(this.state.matches)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((match) => ({
        id: match.id,
        kind: match.kind,
        status: match.status,
        createdAt: match.createdAt,
        revealedAt: match.revealedAt,
        aiBusy: Boolean(match.aiBusy),
        participants: match.playerIds.map((sessionId) => ({
          sessionId,
          codename: this.state.players[sessionId]?.codename || '匿名观察者',
          connected: Boolean(this.state.players[sessionId]?.connected),
          guess: readIdentityGuess(match.guesses[sessionId]),
        })),
        aiPersona: match.aiPersona ? { codename: match.aiPersona.codename } : undefined,
        messages: match.messages.map((message) => ({
          id: message.id,
          authorId: message.authorId,
          authorCodename: message.source === 'admin'
            ? '管理员介入'
            : message.source === 'ai'
              ? match.aiPersona?.codename || 'AI 信号'
              : this.state.players[message.authorId]?.codename || '匿名玩家',
          content: message.content,
          source: message.source,
          createdAt: message.createdAt,
          targetSessionIds: message.visibleTo || match.playerIds,
        })),
      }))

    return {
      generatedAt: Date.now(),
      stats: {
        connectedPlayers: Object.values(this.state.players).filter((player) => player.connected).length,
        waitingPlayers: this.state.waiting.length,
        activeMatches: matches.filter((match) => match.status === 'active').length,
        totalMatches: matches.length,
        interventions: matches.reduce((count, match) => count + match.messages.filter((message) => message.source === 'admin').length, 0),
      },
      matches,
    }
  }

  private async joinMatch(sessionId: string, styleOptIn: boolean): Promise<void> {
    const current = this.getMatchForPlayer(sessionId)
    if (current?.status === 'active') {
      this.sendTo(sessionId, 'match:found', this.snapshot(current, sessionId))
      return
    }

    if (current) delete this.state.playerMatches[sessionId]
    if (this.state.players[sessionId]) this.state.players[sessionId].styleOptIn = styleOptIn
    this.dequeue(sessionId)
    this.state.waiting.push({ sessionId, readyAt: Date.now() + MATCH_WINDOW_MS })
    this.sendTo(sessionId, 'match:searching', { waitMs: MATCH_WINDOW_MS })
    await this.persist()
    await this.scheduleAlarm()
  }

  private async revokeStyleConsent(sessionId: string): Promise<void> {
    const match = this.getMatchForPlayer(sessionId)
    if (!match || match.status !== 'active' || !match.styleConsent?.[sessionId]) return
    match.styleConsent[sessionId] = false
    if (this.state.players[sessionId]) this.state.players[sessionId].styleOptIn = false
    await this.persist()
    this.sendTo(sessionId, 'style:consent', { enabled: false })
  }

  private async handleMessage(sessionId: string, rawContent: string): Promise<void> {
    const content = rawContent.trim()
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      this.sendTo(sessionId, 'error:message', { message: content ? '消息太长了' : '消息不能为空' })
      return
    }

    const match = this.getMatchForPlayer(sessionId)
    if (!match || match.status !== 'active') {
      this.sendTo(sessionId, 'error:message', { message: '这段信号已经结束' })
      return
    }
    if (match.kind === 'ai' && match.aiBusy) {
      this.sendTo(sessionId, 'error:message', { message: '对方还在输入，先等这一条抵达' })
      return
    }

    const ownMessage = this.addMessage(match, sessionId, content, 'human')
    this.sendTo(sessionId, 'message:accepted', this.publicMessage(ownMessage, 'self'))

    if (match.kind === 'human') {
      const opponentId = match.playerIds.find((id) => id !== sessionId)
      if (opponentId) {
        this.sendTo(opponentId, 'opponent:typing', false)
        await wait(180 + Math.min(700, content.length * 7))
        this.sendTo(opponentId, 'message:receive', this.publicMessage(ownMessage, 'opponent'))
      }
      await this.persist()
      return
    }

    if (!match.aiPersona) return
    match.aiBusy = true
    await this.persist()

    const startedAt = Date.now()
    const generation = this.generateAiReply(match)
    const readPause = aiReadPauseMs(content.length, Math.random())
    try {
      await wait(readPause)
      if (match.status !== 'active') return
      this.sendTo(sessionId, 'opponent:typing', true)

      const result = await generation
      if (match.status !== 'active') return
      if (!result.reply) {
        this.sendTo(sessionId, 'error:message', { message: '对话暂时中断了，没有收到对方的回复。稍后可以再试。' })
        return
      }

      const targetDelay = Math.max(readPause + 900, aiReplyDelayMs(result.reply, Math.random(), match.learnedStyle))
      await wait(Math.max(0, targetDelay - (Date.now() - startedAt)))
      if (match.status !== 'active') return
      match.aiMemory = [...new Set([...(match.aiMemory || []), ...result.memory])].slice(-6)
      const aiMessage = this.addMessage(match, `ai:${match.id}`, result.reply, 'ai')
      this.sendTo(sessionId, 'message:receive', this.publicMessage(aiMessage, 'opponent'))
    } finally {
      match.aiBusy = false
      this.sendTo(sessionId, 'opponent:typing', false)
      await this.persist()
    }
  }

  private forwardTyping(sessionId: string, typing: boolean): void {
    const match = this.getMatchForPlayer(sessionId)
    if (!match || match.status !== 'active' || match.kind !== 'human') return
    const opponentId = match.playerIds.find((id) => id !== sessionId)
    if (opponentId) this.sendTo(opponentId, 'opponent:typing', typing)
  }

  private async updateGuess(sessionId: string, choice: IdentityGuess | null): Promise<void> {
    const match = this.getMatchForPlayer(sessionId)
    if (!match || match.status !== 'active') return
    if (!choice) { this.sendTo(sessionId, 'error:message', { message: '请先选择真人或 AI。' }); return }
    if (!canPlayerGuess(match.messages, sessionId)) { this.sendTo(sessionId, 'error:message', { message: '先发送 3 条消息，再判断身份吧。' }); return }
    const guess = {
      guess: choice,
      updatedAt: Date.now(),
    }
    match.guesses[sessionId] = guess
    this.sendTo(sessionId, 'guess:updated', { ...guess, humanProbability: legacyGuessValue(choice) })
    await this.persist()
  }

  private async reveal(sessionId: string, choice: IdentityGuess | null): Promise<void> {
    const match = this.getMatchForPlayer(sessionId)
    if (!match || match.status !== 'active') return
    if (!choice) { this.sendTo(sessionId, 'error:message', { message: '请先选择真人或 AI，再提交判断。' }); return }
    if (!canPlayerGuess(match.messages, sessionId)) { this.sendTo(sessionId, 'error:message', { message: '先发送 3 条消息，再判断身份吧。' }); return }
    match.guesses[sessionId] = {
      guess: choice,
      updatedAt: Date.now(),
    }
    await this.finishMatch(match, 'judged')
  }

  private async finishMatch(match: GameMatch, reason: EndReason): Promise<void> {
    if (match.status !== 'active') return
    match.endReason = reason
    match.status = 'revealed'
    match.revealedAt = Date.now()
    match.aiBusy = false
    await this.persist()
    this.ctx.waitUntil(this.archiveMatch(match))
    for (const playerId of match.playerIds) {
      this.sendTo(playerId, 'opponent:typing', false)
      this.sendTo(playerId, 'match:revealed', this.snapshot(match, playerId, true))
    }
  }

  private async generateAiReply(match: GameMatch): Promise<AiReplyResult> {
    const messages = match.messages
    const persona = match.aiPersona!
    const startedAt = Date.now()
    const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0)
    if (!this.env.DEEPSEEK_API_KEY) {
      console.error('DeepSeek reply failed', 'missing_api_key')
      this.ctx.waitUntil(this.recordAiEvent(match, persona, 'fallback', 'missing_api_key', Date.now() - startedAt, inputChars, 0))
      return { reply: null, memory: [], fallback: true }
    }

    if (match.learnedStyle === undefined) match.learnedStyle = match.styleVariant === 'learned' ? await this.loadHumanStyleProfile() : null
    const context = { playerMessages: messages.filter(message => message.source === 'human').length, latestUserMessage: [...messages].reverse().find(message => message.source === 'human')?.content }
    const systemPrompt = buildAiSystemPrompt(persona, match.aiMemory || [], match.learnedStyle, context)

    let lastError = 'unknown'
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          signal: AbortSignal.timeout(12_000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: this.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
            ...AI_GENERATION_PARAMETERS,
            messages: [
            { role: 'system', content: systemPrompt + (attempt > 0 ? aiReplyRetryHint(context) : '') },
            ...messages.slice(-24).map((message) => ({
              role: message.source === 'human' ? 'user' : 'assistant',
              content: message.content,
            })),
            ],
          }),
        })
        if (!response.ok) {
          lastError = `http_${response.status}`
          if (response.status < 500 && response.status !== 429) break
          throw new Error(lastError)
        }
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
        const parsed = parseAiReply(data.choices?.[0]?.message?.content || '')
        const issues = parsed ? aiReplyIssues(parsed.reply, context) : []
        if (parsed && !issues.length) {
          this.ctx.waitUntil(this.recordAiEvent(match, persona, 'success', null, Date.now() - startedAt, inputChars, parsed.reply.length))
          return { ...parsed, fallback: false }
        }
        lastError = parsed ? `reply_style:${issues.join(',')}` : 'empty_or_invalid_reply'
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'unknown'
      }
      if (attempt === 0) await wait(300)
    }

    console.error('DeepSeek reply failed', lastError)
    this.ctx.waitUntil(this.recordAiEvent(match, persona, 'fallback', lastError, Date.now() - startedAt, inputChars, 0))
    return { reply: null, memory: [], fallback: true }
  }

  private async loadHumanStyleProfile(): Promise<HumanStyleProfile | null> {
    try {
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000
      const totals = await this.env.DB.prepare(`
        SELECT COUNT(*) AS matchCount,
          COALESCE(SUM(message_count), 0) AS messageCount,
          COALESCE(SUM(total_chars), 0) AS totalChars,
          COALESCE(SUM(short_count), 0) AS shortCount,
          COALESCE(SUM(question_count), 0) AS questionCount,
          COALESCE(SUM(reply_delay_count), 0) AS replyDelayCount,
          COALESCE(SUM(total_reply_delay_ms), 0) AS totalReplyDelayMs
        FROM human_style_samples WHERE sample_version = 1 AND created_at >= ?
      `).bind(since).first<HumanStyleTotals>()
      return totals ? humanStyleProfile(totals) : null
    } catch (error) {
      console.error('Human style profile load failed', error instanceof Error ? error.message : 'unknown')
      return null
    }
  }

  private createHumanMatch(firstId: string, secondId: string): GameMatch {
    this.dequeue(firstId)
    this.dequeue(secondId)
    const match = this.createMatch('human', [firstId, secondId])
    this.state.humanSeats += 2
    return match
  }

  private createAiMatch(playerId: string): GameMatch {
    this.dequeue(playerId)
    const id = crypto.randomUUID()
    const match = this.createMatch('ai', [playerId], {
      ...PERSONAS[hashString(id) % PERSONAS.length],
      codename: codenameFor(`ai:${id}`),
    }, id)
    this.state.aiSeats += 1
    return match
  }

  private createMatch(kind: MatchKind, playerIds: string[], aiPersona?: Persona, preferredId?: string): GameMatch {
    const id = preferredId || crypto.randomUUID()
    const match: GameMatch = {
      id,
      kind,
      status: 'active',
      playerIds,
      aiPersona,
      aiMemory: aiPersona ? [] : undefined,
      styleConsent: Object.fromEntries(playerIds.map((playerId) => [playerId, this.state.players[playerId]?.styleOptIn ?? true])),
      styleVariant: kind === 'ai' ? (hashString(id) % 2 === 0 ? 'learned' : 'baseline') : undefined,
      messages: [],
      guesses: {},
      createdAt: Date.now(),
    }
    this.state.matches[match.id] = match
    for (const playerId of playerIds) this.state.playerMatches[playerId] = match.id
    return match
  }

  private shouldCreateHumanMatch(): boolean {
    const total = this.state.humanSeats + this.state.aiSeats
    if (total === 0) return Math.random() < 0.55
    const share = this.state.humanSeats / total
    if (share < 0.42) return Math.random() < 0.85
    if (share > 0.58) return Math.random() < 0.25
    return Math.random() < 0.55
  }

  private addMessage(
    match: GameMatch,
    authorId: string,
    content: string,
    source: 'human' | 'ai' | 'admin',
    visibleTo?: string[],
  ): GameMessage {
    const message = { id: crypto.randomUUID(), authorId, content, source, createdAt: Date.now(), visibleTo }
    match.messages.push(message)
    return message
  }

  private snapshot(match: GameMatch, viewerId: string, includeTruth = false) {
    const truth = match.kind === 'human' ? 'human' : 'ai'
    const guess = readIdentityGuess(match.guesses[viewerId])
    const opponentId = match.playerIds.find((id) => id !== viewerId)
    return {
      id: match.id,
      status: match.status,
      selfCodename: this.state.players[viewerId]?.codename || '匿名观察者',
      opponentCodename: match.kind === 'ai' ? match.aiPersona?.codename || '未知信号' : this.state.players[opponentId || '']?.codename || '未知信号',
      opponentConnected: match.kind === 'ai' || Boolean(this.state.players[opponentId || '']?.connected),
      styleOptIn: Boolean(match.styleConsent?.[viewerId]),
      minimumMessages: MIN_MESSAGES_BEFORE_GUESS,
      guess,
      // Keep already-open clients functional until they refresh.
      humanProbability: legacyGuessValue(guess),
      messages: match.messages.filter((message) => !message.visibleTo || message.visibleTo.includes(viewerId)).map((message) => ({
        ...this.publicMessage(message, message.authorId === viewerId ? 'self' : 'opponent'),
        ...(includeTruth ? { source: message.source } : {}),
      })),
      ...(includeTruth ? {
        truth,
        endReason: match.endReason || 'judged',
        intervened: match.messages.some(message => message.source === 'admin'),
        correct: guess === null || (match.endReason && match.endReason !== 'judged') || match.messages.some(message => message.source === 'admin') ? null : guess === truth,
      } : {}),
    }
  }

  private publicMessage(message: GameMessage, side: 'self' | 'opponent') {
    return { id: message.id, side, content: message.content, createdAt: message.createdAt }
  }

  private getMatchForPlayer(sessionId: string): GameMatch | undefined {
    return this.state.matches[this.state.playerMatches[sessionId]]
  }

  private dequeue(sessionId: string): void {
    this.state.waiting = this.state.waiting.filter((entry) => entry.sessionId !== sessionId)
  }

  private emitMatchFound(match: GameMatch): void {
    for (const sessionId of match.playerIds) this.sendTo(sessionId, 'match:found', this.snapshot(match, sessionId))
  }

  private sendTo(sessionId: string, type: string, payload: unknown): void {
    for (const socket of this.ctx.getWebSockets(`player:${sessionId}`)) this.send(socket, type, payload)
  }

  private send(socket: WebSocket, type: string, payload: unknown): void {
    try {
      socket.send(JSON.stringify({ type, payload }))
    } catch {
      // A closing socket will disappear from getWebSockets automatically.
    }
  }

  private async recordAiEvent(
    match: GameMatch,
    persona: Persona,
    status: 'success' | 'fallback',
    errorCode: string | null,
    latencyMs: number,
    inputChars: number,
    outputChars: number,
  ): Promise<void> {
    try {
      await this.env.DB.prepare(`
        INSERT INTO ai_events
          (id, match_id, model, persona_codename, prompt_version, status, error_code, latency_ms, input_chars, output_chars, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM deleted_match_ids WHERE id = ?)
      `).bind(
        crypto.randomUUID(), match.id, this.env.DEEPSEEK_MODEL || 'deepseek-v4-flash', persona.codename,
        `${this.env.PROMPT_VERSION || 'human-v5-reserved'}:${match.learnedStyle ? 'learned' : 'baseline'}`,
        status, errorCode, latencyMs, inputChars, outputChars, Date.now(), match.id,
      ).run()
    } catch (error) {
      console.error('AI metric write failed', error instanceof Error ? error.message : 'unknown')
    }
  }

  private authorCodename(match: GameMatch, message: GameMessage): string {
    if (message.source === 'admin') return '管理员介入'
    if (message.source === 'ai') return match.aiPersona?.codename || 'AI 信号'
    return this.state.players[message.authorId]?.codename || '匿名玩家'
  }

  private async executeD1Batches(statements: D1PreparedStatement[]): Promise<void> {
    for (let index = 0; index < statements.length; index += 80) {
      await this.env.DB.batch(statements.slice(index, index + 80))
    }
  }

  private async archiveMatch(match: GameMatch): Promise<void> {
    if (match.status !== 'revealed' || !match.revealedAt) return
    try {
      const deleted = await this.env.DB.prepare('SELECT id FROM deleted_match_ids WHERE id = ?').bind(match.id).first()
      if (deleted) return
      const truth = match.kind === 'human' ? 'human' : 'ai'
      const statements: D1PreparedStatement[] = [
        this.env.DB.prepare(`
          INSERT INTO matches
            (id, kind, status, ai_codename, created_at, revealed_at, duration_ms, message_count, participant_count, truth, archived_at, end_reason, intervention_count)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM deleted_match_ids WHERE id = ?)
          ON CONFLICT(id) DO UPDATE SET
            status=excluded.status, revealed_at=excluded.revealed_at, duration_ms=excluded.duration_ms,
            message_count=excluded.message_count, participant_count=excluded.participant_count, archived_at=excluded.archived_at,end_reason=excluded.end_reason,intervention_count=excluded.intervention_count
        `).bind(
          match.id, match.kind, match.status, match.aiPersona?.codename || null, match.createdAt, match.revealedAt,
          Math.max(0, match.revealedAt - match.createdAt), match.messages.length, match.playerIds.length, truth, Date.now(), match.endReason || 'judged', match.messages.filter(message => message.source === 'admin').length, match.id,
        ),
      ]

      for (const sessionId of match.playerIds) {
        const guess = readIdentityGuess(match.guesses[sessionId])
        const correct = guess === null || (match.endReason && match.endReason !== 'judged') || match.messages.some(message => message.source === 'admin') ? null : guess === truth ? 1 : 0
        statements.push(this.env.DB.prepare(`
          INSERT INTO participants (match_id, session_id, codename, human_probability, correct)
          SELECT ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM deleted_match_ids WHERE id = ?)
          ON CONFLICT(match_id, session_id) DO UPDATE SET
            codename=excluded.codename, human_probability=excluded.human_probability, correct=excluded.correct
        `).bind(match.id, sessionId, this.state.players[sessionId]?.codename || '匿名观察者', legacyGuessValue(guess), correct, match.id))
      }

      for (const [messageIndex, message] of match.messages.entries()) {
        statements.push(this.env.DB.prepare(`
          INSERT INTO messages
            (id, match_id, author_id, author_codename, source, content, created_at, target_session_ids, message_index)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM deleted_match_ids WHERE id = ?)
          ON CONFLICT(id) DO UPDATE SET message_index=excluded.message_index
        `).bind(
          message.id, match.id, message.authorId, this.authorCodename(match, message), message.source,
          message.content, message.createdAt, JSON.stringify(message.visibleTo || match.playerIds), messageIndex, match.id,
        ))
      }

      if ((!match.endReason || match.endReason === 'judged') && match.kind === 'human' && !match.messages.some((message) => message.source === 'admin') && match.playerIds.every((playerId) => match.styleConsent?.[playerId] === true)) {
        const sample = summarizeHumanStyle(match.messages, match.playerIds)
        if (sample) {
          statements.push(this.env.DB.prepare(`
            INSERT INTO human_style_samples
              (match_id, sample_version, created_at, message_count, total_chars, short_count, question_count, reply_delay_count, total_reply_delay_ms)
            SELECT ?, 1, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM deleted_match_ids WHERE id = ?)
            ON CONFLICT(match_id) DO UPDATE SET
              message_count=excluded.message_count, total_chars=excluded.total_chars,
              short_count=excluded.short_count, question_count=excluded.question_count,
              reply_delay_count=excluded.reply_delay_count, total_reply_delay_ms=excluded.total_reply_delay_ms
          `).bind(
            match.id, match.revealedAt, sample.messageCount, sample.totalChars, sample.shortCount,
            sample.questionCount, sample.replyDelayCount, sample.totalReplyDelayMs, match.id,
          ))
        }
      }

      await this.executeD1Batches(statements)
      for (const playerId of match.playerIds) await unlockPlayerBadges(this.env, playerId)
      await refreshTrainingSample(this.env.DB, match.id)
    } catch (error) {
      console.error('Match archive failed', error instanceof Error ? error.message : 'unknown')
    }
  }

  private pruneRevealedState(): boolean {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    let pruned = false
    for (const match of Object.values(this.state.matches)) {
      if (match.status !== 'revealed' || !match.revealedAt || match.revealedAt >= cutoff) continue
      delete this.state.matches[match.id]
      pruned = true
      for (const playerId of match.playerIds) {
        if (this.state.playerMatches[playerId] === match.id) delete this.state.playerMatches[playerId]
      }
    }
    return pruned
  }

  private async persist(): Promise<void> {
    this.pruneRevealedState()
    await this.ctx.storage.put(STATE_KEY, this.state)
    if (this.ctx.getWebSockets('admin').length > 0) {
      const snapshot = this.adminSnapshot()
      for (const socket of this.ctx.getWebSockets('admin')) this.send(socket, 'admin:snapshot', snapshot)
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const next = this.state.waiting.reduce<number | null>((minimum, entry) => minimum === null ? entry.readyAt : Math.min(minimum, entry.readyAt), null)
    if (next === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.max(Date.now(), next))
  }
}

function clampInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback
}

async function historyList(env: Env, url: URL): Promise<Response> {
  const limit = clampInteger(url.searchParams.get('limit'), 25, 10, 50)
  const cursor = clampInteger(url.searchParams.get('cursor'), Date.now() + 1, 1, Number.MAX_SAFE_INTEGER)
  const kind = url.searchParams.get('kind')
  const query = (url.searchParams.get('q') || '').trim().slice(0, 80)
  const conditions = ['m.created_at < ?']
  const bindings: unknown[] = [cursor]
  if (kind === 'human' || kind === 'ai') {
    conditions.push('m.kind = ?')
    bindings.push(kind)
  }
  if (query) {
    conditions.push(`(
      m.id LIKE ? OR m.ai_codename LIKE ? OR EXISTS (
        SELECT 1 FROM participants p WHERE p.match_id = m.id AND p.codename LIKE ?
      )
    )`)
    const pattern = `%${query}%`
    bindings.push(pattern, pattern, pattern)
  }

  const result = await env.DB.prepare(`
    SELECT m.*,
      (SELECT GROUP_CONCAT(p.codename, ' × ') FROM participants p WHERE p.match_id = m.id) AS participant_codenames,
      (SELECT COUNT(*) FROM messages msg WHERE msg.match_id = m.id AND msg.source = 'admin') AS intervention_count
    FROM matches m
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at DESC
    LIMIT ?
  `).bind(...bindings, limit).all<Record<string, unknown>>()

  const items = result.results || []
  const nextCursor = items.length === limit ? Number(items.at(-1)?.created_at) : null
  return jsonResponse({ items, nextCursor, retentionDays: clampInteger(env.RETENTION_DAYS, 30, 1, 365) })
}

async function historyDetail(env: Env, matchId: string): Promise<Response> {
  const match = await env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind(matchId).first<Record<string, unknown>>()
  if (!match) return jsonResponse({ error: 'Conversation not found' }, 404)
  const [participants, messages, aiEvents, adminActions] = await Promise.all([
    env.DB.prepare('SELECT * FROM participants WHERE match_id = ? ORDER BY codename').bind(matchId).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM messages WHERE match_id = ? ORDER BY message_index,created_at,id').bind(matchId).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT status, error_code, latency_ms, model, persona_codename, prompt_version, created_at FROM ai_events WHERE match_id = ? ORDER BY created_at').bind(matchId).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT id, target_session_id, action_type, content, created_at FROM admin_actions WHERE match_id = ? ORDER BY created_at').bind(matchId).all<Record<string, unknown>>(),
  ])
  return jsonResponse({
    match,
    participants: (participants.results || []).map(({ human_probability, ...participant }) => ({
      ...participant,
      guess: readIdentityGuess({ humanProbability: human_probability }),
    })),
    messages: (messages.results || []).map((message) => ({
      ...message,
      target_session_ids: (() => { try { return JSON.parse(String(message.target_session_ids || '[]')) } catch { return [] } })(),
    })),
    aiEvents: aiEvents.results || [],
    adminActions: adminActions.results || [],
  })
}

async function deleteHistory(env: Env, matchId: string): Promise<Response> {
  const exists = await env.DB.prepare('SELECT id FROM matches WHERE id = ?').bind(matchId).first()
  if (!exists) return jsonResponse({ error: 'Conversation not found' }, 404)
  const lobby = env.LOBBY.get(env.LOBBY.idFromName('global-lobby-v1'))
  const forgotten = await lobby.fetch(new Request(`https://internal/forget-match/${matchId}`, { method: 'POST' }))
  if (!forgotten.ok) return jsonResponse({ error: 'Live state could not be cleared' }, 503)
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO deleted_match_ids (id, deleted_at) VALUES (?, ?)').bind(matchId, Date.now()),
    env.DB.prepare('DELETE FROM human_style_samples WHERE match_id = ?').bind(matchId),
    env.DB.prepare('DELETE FROM matches WHERE id = ?').bind(matchId),
    env.DB.prepare('DELETE FROM ai_events WHERE match_id = ?').bind(matchId),
    env.DB.prepare('DELETE FROM admin_actions WHERE match_id = ?').bind(matchId),
  ])
  return jsonResponse({ deleted: true, matchId })
}

async function metricsSnapshot(env: Env, url: URL): Promise<Response> {
  const days = clampInteger(url.searchParams.get('days'), 7, 1, 90)
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const [matches, judgments, ai, dailyMatches, dailyAi, errors, personas, styleTotals, styleExperiment] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS total_matches,
        SUM(CASE WHEN kind='ai' THEN 1 ELSE 0 END) AS ai_matches,
        SUM(CASE WHEN kind='human' THEN 1 ELSE 0 END) AS human_matches,
        AVG(duration_ms) AS avg_duration_ms,
        AVG(message_count) AS avg_messages
      FROM matches WHERE created_at >= ?
    `).bind(since).first<Record<string, number | null>>(),
    env.DB.prepare(`
      SELECT COUNT(correct) AS judgments,
        AVG(correct) * 100 AS accuracy
      FROM participants p JOIN matches m ON m.id=p.match_id WHERE m.created_at >= ? AND m.end_reason='judged' AND m.intervention_count=0 AND NOT EXISTS(SELECT 1 FROM messages msg WHERE msg.match_id=m.id AND msg.source='admin')
    `).bind(since).first<Record<string, number | null>>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS requests,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN status='fallback' THEN 1 ELSE 0 END) AS fallbacks,
        AVG(latency_ms) AS avg_latency_ms,
        MAX(latency_ms) AS max_latency_ms
      FROM ai_events WHERE created_at >= ?
    `).bind(since).first<Record<string, number | null>>(),
    env.DB.prepare(`
      SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS matches
      FROM matches WHERE created_at >= ? GROUP BY day ORDER BY day
    `).bind(since).all<{ day: string; matches: number }>(),
    env.DB.prepare(`
      SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS requests,
        SUM(CASE WHEN status='fallback' THEN 1 ELSE 0 END) AS fallbacks
      FROM ai_events WHERE created_at >= ? GROUP BY day ORDER BY day
    `).bind(since).all<{ day: string; requests: number; fallbacks: number }>(),
    env.DB.prepare(`
      SELECT COALESCE(error_code, 'unknown') AS code, COUNT(*) AS count
      FROM ai_events WHERE created_at >= ? AND status='fallback'
      GROUP BY code ORDER BY count DESC LIMIT 8
    `).bind(since).all<{ code: string; count: number }>(),
    env.DB.prepare(`
      SELECT m.ai_codename AS persona, COUNT(DISTINCT m.id) AS matches,
        COUNT(p.correct) AS judged,
        AVG(p.correct) * 100 AS detection_accuracy
      FROM matches m JOIN participants p ON p.match_id=m.id
      WHERE m.created_at >= ? AND m.kind='ai'
      GROUP BY m.ai_codename ORDER BY matches DESC
    `).bind(since).all<{ persona: string; matches: number; judged: number; detection_accuracy: number | null }>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS matchCount,
        COALESCE(SUM(message_count), 0) AS messageCount,
        COALESCE(SUM(total_chars), 0) AS totalChars,
        COALESCE(SUM(short_count), 0) AS shortCount,
        COALESCE(SUM(question_count), 0) AS questionCount,
        COALESCE(SUM(reply_delay_count), 0) AS replyDelayCount,
        COALESCE(SUM(total_reply_delay_ms), 0) AS totalReplyDelayMs
      FROM human_style_samples WHERE sample_version = 1 AND created_at >= ?
    `).bind(Date.now() - 30 * 24 * 60 * 60 * 1000).first<HumanStyleTotals>(),
    env.DB.prepare(`
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM ai_events e WHERE e.match_id = m.id AND e.prompt_version = ?
      ) THEN 'learned' ELSE 'baseline' END AS variant,
        COUNT(DISTINCT m.id) AS matches,
        SUM(CASE WHEN p.correct IS NOT NULL THEN 1 ELSE 0 END) AS judged,
        AVG(CASE WHEN p.correct IS NOT NULL THEN p.correct END) * 100 AS detection_accuracy
      FROM matches m JOIN participants p ON p.match_id = m.id
      WHERE m.kind = 'ai' AND m.created_at >= ?
        AND EXISTS (SELECT 1 FROM ai_events e2 WHERE e2.match_id = m.id AND e2.prompt_version IN (?, ?))
      GROUP BY variant
    `).bind(`${env.PROMPT_VERSION}:learned`, since, `${env.PROMPT_VERSION}:learned`, `${env.PROMPT_VERSION}:baseline`)
      .all<{ variant: 'learned' | 'baseline'; matches: number; judged: number; detection_accuracy: number | null }>(),
  ])

  const byDay = new Map<string, { day: string; matches: number; requests: number; fallbacks: number }>()
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)
    byDay.set(day, { day, matches: 0, requests: 0, fallbacks: 0 })
  }
  for (const row of dailyMatches.results || []) if (byDay.has(row.day)) byDay.get(row.day)!.matches = Number(row.matches)
  for (const row of dailyAi.results || []) if (byDay.has(row.day)) Object.assign(byDay.get(row.day)!, { requests: Number(row.requests), fallbacks: Number(row.fallbacks) })

  const aiRequests = Number(ai?.requests || 0)
  return jsonResponse({
    days,
    generatedAt: Date.now(),
    matches: {
      total: Number(matches?.total_matches || 0), ai: Number(matches?.ai_matches || 0), human: Number(matches?.human_matches || 0),
      avgDurationMs: Math.round(Number(matches?.avg_duration_ms || 0)), avgMessages: Number(Number(matches?.avg_messages || 0).toFixed(1)),
    },
    judgments: {
      total: Number(judgments?.judgments || 0), accuracy: Number(Number(judgments?.accuracy || 0).toFixed(1)),
    },
    ai: {
      requests: aiRequests, successes: Number(ai?.successes || 0), fallbacks: Number(ai?.fallbacks || 0),
      successRate: aiRequests ? Number((Number(ai?.successes || 0) / aiRequests * 100).toFixed(1)) : 0,
      fallbackRate: aiRequests ? Number((Number(ai?.fallbacks || 0) / aiRequests * 100).toFixed(1)) : 0,
      avgLatencyMs: Math.round(Number(ai?.avg_latency_ms || 0)), maxLatencyMs: Number(ai?.max_latency_ms || 0),
    },
    daily: [...byDay.values()],
    errors: errors.results || [],
    personas: personas.results || [],
    styleLearning: {
      matches: Number(styleTotals?.matchCount || 0),
      messages: Number(styleTotals?.messageCount || 0),
      active: Boolean(styleTotals && humanStyleProfile(styleTotals)),
    },
    styleExperiment: styleExperiment.results || [],
  })
}

async function enforceRetention(env: Env): Promise<void> {
  const retentionDays = clampInteger(env.RETENTION_DAYS, 30, 1, 365)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  await env.DB.batch([
    env.DB.prepare('DELETE FROM player_sessions WHERE expires_at <= ?').bind(Date.now()),
    env.DB.prepare('DELETE FROM player_auth_limits WHERE reset_at <= ?').bind(Date.now()),
    env.DB.prepare('INSERT OR IGNORE INTO deleted_match_ids (id, deleted_at) SELECT id, ? FROM matches WHERE created_at < ?').bind(Date.now(), cutoff),
    env.DB.prepare('DELETE FROM human_style_samples WHERE created_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM matches WHERE created_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM ai_events WHERE created_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM admin_actions WHERE created_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM deleted_match_ids WHERE deleted_at < ?').bind(cutoff),
  ])
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:; base-uri 'none'; frame-ancestors 'none'")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const lobby = () => env.LOBBY.get(env.LOBBY.idFromName('global-lobby-v1'))

    if (url.pathname.startsWith('/api/auth/')) {
      try {
        return await handlePlayerAuth(request, env, async (tokenHash, preserveSeat) => {
          await lobby().fetch(new Request('https://internal/internal/revoke-player-session', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenHash, preserveSeat }),
          }))
        }, async (accountId, guestSeat) => {
          const result = await lobby().fetch(new Request('https://internal/internal/claim-account-seat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, guestSeat }),
          }))
          if (result.status === 409) return null
          if (!result.ok) throw new Error('Seat unavailable')
          return (await result.json() as { playerId: string }).playerId
        })
      } catch {
        // Never log credentials, cookies or raw database failures.
        return jsonResponse({ error: '账号服务暂时不可用，请稍后重试。' }, 503)
      }
    }

    if (url.pathname.startsWith('/api/player/')) {
      try { return await playerFeatures(request, env, (playerId, matchId, report) => lobby().fetch(new Request('https://internal/internal/player-match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId, matchId, report }) }))) }
      catch { return jsonResponse({ error: '玩家服务暂时不可用，请稍后重试。' }, 503) }
    }
    if (url.pathname === '/admin/api/community' || url.pathname.startsWith('/admin/api/reports/') || url.pathname.startsWith('/admin/api/training/')) {
      if (!await isAdminRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
      if (request.method !== 'GET' && !isSameOrigin(request)) return jsonResponse({ error: 'Origin rejected' }, 403)
      try { return await communityFeatures(request, env) } catch { return jsonResponse({ error: '管理服务暂时不可用。' }, 503) }
    }

    if (url.pathname === '/admin/api/login') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
      if (!isSameOrigin(request)) return jsonResponse({ error: 'Origin rejected' }, 403)
      const result = await lobby().fetch(request)
      if (!result.ok) return result
      return jsonResponse(
        { authenticated: true, expiresIn: ADMIN_SESSION_SECONDS },
        200,
        { 'Set-Cookie': await createAdminCookie(env, request) },
      )
    }

    if (url.pathname === '/admin/api/session') {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405)
      return jsonResponse({ authenticated: await isAdminRequest(request, env) })
    }

    if (url.pathname === '/admin/api/logout') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
      if (!isSameOrigin(request)) return jsonResponse({ error: 'Origin rejected' }, 403)
      return jsonResponse({ authenticated: false }, 200, { 'Set-Cookie': clearAdminCookie() })
    }

    if (url.pathname === '/admin/api/metrics') {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405)
      if (!await isAdminRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
      return metricsSnapshot(env, url)
    }

    if (url.pathname === '/admin/api/history') {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405)
      if (!await isAdminRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
      return historyList(env, url)
    }

    const historyMatch = url.pathname.match(/^\/admin\/api\/history\/([A-Za-z0-9-]{8,100})$/)
    if (historyMatch) {
      if (!await isAdminRequest(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
      if (request.method === 'GET') return historyDetail(env, historyMatch[1])
      if (request.method === 'DELETE') {
        if (!isSameOrigin(request)) return jsonResponse({ error: 'Origin rejected' }, 403)
        return deleteHistory(env, historyMatch[1])
      }
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }

    if (url.pathname === '/admin/ws') {
      if (!isSameOrigin(request) || !await isAdminRequest(request, env)) {
        return new Response('Unauthorized', { status: 401 })
      }
      return lobby().fetch(request)
    }

    if (url.pathname === '/ws') {
      if (!isSameOrigin(request)) return new Response('Origin rejected', { status: 403 })
      return lobby().fetch(request)
    }

    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok', runtime: 'cloudflare-workers', durableObjects: true, d1: true, retentionDays: clampInteger(env.RETENTION_DAYS, 30, 1, 365) })
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request))
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enforceRetention(env))
  },
} satisfies ExportedHandler<Env>
