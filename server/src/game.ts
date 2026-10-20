import { Logger } from 'pino'

export type MatchKind = 'human' | 'ai'
export type MatchStatus = 'active' | 'revealed' | 'abandoned'

export interface Player {
  sessionId: string
  socketId: string
  codename: string
  connected: boolean
}

export interface Persona {
  codename: string
  temperament: string
  cadence: string
  humor: string
  uncertainty: string
  initiative: string
}

export interface GameMessage {
  id: string
  authorId: string
  content: string
  source: 'human' | 'ai'
  createdAt: number
}

export interface GuessState {
  guess: MatchKind
  updatedAt: number
}

export interface GameMatch {
  id: string
  kind: MatchKind
  status: MatchStatus
  playerIds: string[]
  aiPersona?: Persona
  messages: GameMessage[]
  guesses: Record<string, GuessState>
  createdAt: number
  revealedAt?: number
}

const ADJECTIVES = ['迟来的', '安静的', '偏航的', '清醒的', '潮湿的', '逆光的', '失眠的', '缓慢的']
const NOUNS = ['信号', '候鸟', '电台', '回声', '雨幕', '底片', '灯塔', '磁带']

const PERSONAS: Omit<Persona, 'codename'>[] = [
  {
    temperament: '克制、敏锐，不急着证明自己',
    cadence: '大多数回复一到三句，长短不完全规律',
    humor: '偶尔干冷地开玩笑，但不解释笑点',
    uncertainty: '不确定时直接承认，或问一个具体问题',
    initiative: '会接住对方话里的情绪，但不会像客服一样总结',
  },
  {
    temperament: '温和、有一点好奇，容易被细节吸引',
    cadence: '自然口语，常用短句，偶尔补充半句',
    humor: '轻松但不过分热情',
    uncertainty: '更愿意说“我猜”或“可能吧”',
    initiative: '会沿用对方的词，并提出真正想知道的问题',
  },
  {
    temperament: '直接、反应快，有自己的判断',
    cadence: '简短，避免完整论述和面面俱到',
    humor: '有时会略带调侃',
    uncertainty: '不知道就说不知道，不编造经历证明身份',
    initiative: '不总顺着对方，必要时会表达不同意见',
  },
  {
    temperament: '慢热、略微犹豫，但观察细致',
    cadence: '标点自然，不使用 Markdown，不刻意制造错别字',
    humor: '熟悉后才会出现一点玩笑',
    uncertainty: '会修正自己上一句不准确的理解',
    initiative: '对具体细节比宏大问题更感兴趣',
  },
]

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function codenameFor(seed: string): string {
  const hash = hashString(seed)
  return `${ADJECTIVES[hash % ADJECTIVES.length]}${NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length]}`
}

export class GameManager {
  private players = new Map<string, Player>()
  private matches = new Map<string, GameMatch>()
  private playerMatches = new Map<string, string>()
  private waiting: string[] = []
  private humanSeats = 0
  private aiSeats = 0

  constructor(private logger: Logger) {}

  registerPlayer(sessionId: string, socketId: string): Player {
    const existing = this.players.get(sessionId)
    if (existing) {
      existing.socketId = socketId
      existing.connected = true
      return existing
    }

    const player: Player = { sessionId, socketId, codename: codenameFor(sessionId), connected: true }
    this.players.set(sessionId, player)
    return player
  }

  disconnectPlayer(sessionId: string): void {
    const player = this.players.get(sessionId)
    if (player) player.connected = false
    this.dequeue(sessionId)
  }

  enqueue(sessionId: string): void {
    const previous = this.getMatchForPlayer(sessionId)
    if (previous?.status === 'active') return
    if (previous) this.playerMatches.delete(sessionId)
    if (!this.waiting.includes(sessionId)) this.waiting.push(sessionId)
  }

  dequeue(sessionId: string): void {
    this.waiting = this.waiting.filter((id) => id !== sessionId)
  }

  getWaitingOpponent(sessionId: string): string | undefined {
    return this.waiting.find((id) => id !== sessionId && this.players.get(id)?.connected)
  }

  shouldCreateHumanMatch(): boolean {
    const total = this.humanSeats + this.aiSeats
    if (total === 0) return Math.random() < 0.55
    const share = this.humanSeats / total
    if (share < 0.42) return Math.random() < 0.85
    if (share > 0.58) return Math.random() < 0.25
    return Math.random() < 0.55
  }

  createHumanMatch(firstId: string, secondId: string): GameMatch {
    this.dequeue(firstId)
    this.dequeue(secondId)
    const match = this.createMatch('human', [firstId, secondId])
    this.humanSeats += 2
    return match
  }

  createAiMatch(playerId: string): GameMatch {
    this.dequeue(playerId)
    const id = crypto.randomUUID()
    const personaBase = PERSONAS[hashString(id) % PERSONAS.length]
    const match = this.createMatch('ai', [playerId], {
      ...personaBase,
      codename: codenameFor(`ai:${id}`),
    })
    this.aiSeats += 1
    return match
  }

  private createMatch(kind: MatchKind, playerIds: string[], aiPersona?: Persona): GameMatch {
    const match: GameMatch = {
      id: crypto.randomUUID(),
      kind,
      status: 'active',
      playerIds,
      aiPersona,
      messages: [],
      guesses: {},
      createdAt: Date.now(),
    }
    this.matches.set(match.id, match)
    playerIds.forEach((id) => this.playerMatches.set(id, match.id))
    this.logger.info({ matchId: match.id, kind, players: playerIds.length }, '迷雾对局创建')
    return match
  }

  getPlayer(sessionId: string): Player | undefined {
    return this.players.get(sessionId)
  }

  getMatch(matchId: string): GameMatch | undefined {
    return this.matches.get(matchId)
  }

  getMatchForPlayer(sessionId: string): GameMatch | undefined {
    const matchId = this.playerMatches.get(sessionId)
    return matchId ? this.matches.get(matchId) : undefined
  }

  getOpponent(match: GameMatch, sessionId: string): Player | undefined {
    const opponentId = match.playerIds.find((id) => id !== sessionId)
    return opponentId ? this.players.get(opponentId) : undefined
  }

  getOpponentCodename(match: GameMatch, sessionId: string): string {
    if (match.kind === 'ai') return match.aiPersona?.codename || '未知信号'
    return this.getOpponent(match, sessionId)?.codename || '未知信号'
  }

  addMessage(matchId: string, authorId: string, content: string, source: 'human' | 'ai'): GameMessage {
    const match = this.matches.get(matchId)
    if (!match || match.status !== 'active') throw new Error('MATCH_NOT_ACTIVE')
    const message: GameMessage = {
      id: crypto.randomUUID(), authorId, content, source, createdAt: Date.now(),
    }
    match.messages.push(message)
    return message
  }

  updateGuess(matchId: string, sessionId: string, choice: MatchKind): GuessState {
    const match = this.matches.get(matchId)
    if (!match || !match.playerIds.includes(sessionId)) throw new Error('MATCH_NOT_FOUND')
    if (match.status !== 'active') throw new Error('MATCH_NOT_ACTIVE')
    if (choice !== 'human' && choice !== 'ai') throw new Error('CHOICE_REQUIRED')
    if (!this.canGuess(match, sessionId)) throw new Error('CHAT_REQUIRED')
    const guess = {
      guess: choice,
      updatedAt: Date.now(),
    }
    match.guesses[sessionId] = guess
    return guess
  }

  reveal(matchId: string, requestedBy: string): GameMatch {
    const match = this.matches.get(matchId)
    if (!match || !match.playerIds.includes(requestedBy)) throw new Error('MATCH_NOT_FOUND')
    if (match.status === 'active') {
      if (!match.guesses[requestedBy]) throw new Error('CHOICE_REQUIRED')
      if (!this.canGuess(match, requestedBy)) throw new Error('CHAT_REQUIRED')
      match.status = 'revealed'
      match.revealedAt = Date.now()
      this.logger.info({ matchId, requestedBy, kind: match.kind }, '迷雾身份揭晓')
    }
    return match
  }

  snapshot(match: GameMatch, viewerId: string, includeTruth = false) {
    const opponent = this.getOpponent(match, viewerId)
    const truth = match.kind === 'ai' ? 'ai' : 'human'
    const guess = match.guesses[viewerId]?.guess ?? null
    return {
      id: match.id,
      status: match.status,
      selfCodename: this.players.get(viewerId)?.codename || '匿名观察者',
      opponentCodename: this.getOpponentCodename(match, viewerId),
      opponentConnected: match.kind === 'ai' || Boolean(opponent?.connected),
      minimumMessages: 3,
      guess,
      messages: match.messages.map((message) => ({
        id: message.id,
        side: message.authorId === viewerId ? 'self' : 'opponent',
        content: message.content,
        createdAt: message.createdAt,
        ...(includeTruth ? { source: message.source } : {}),
      })),
      ...(includeTruth ? {
        truth,
        correct: guess === null ? null : guess === truth,
      } : {}),
    }
  }

  canGuess(match: GameMatch, sessionId: string): boolean {
    return match.messages.filter((message) => message.authorId === sessionId && message.source === 'human').length >= 3
  }
}
