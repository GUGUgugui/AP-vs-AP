import { Server, Socket } from 'socket.io'
import { Logger } from 'pino'
import { GameManager, type GameMatch } from './game'
import type { DialogueModel } from './deepseek'

const MAX_MESSAGE_LENGTH = 2000
const MATCH_WINDOW_MS = 2400

export function setupSocketHandlers(
  io: Server,
  games: GameManager,
  dialogue: DialogueModel,
  logger: Logger,
) {
  const matchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const aiBusy = new Set<string>()

  const clearMatchTimer = (sessionId: string) => {
    const timer = matchTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    matchTimers.delete(sessionId)
  }

  const playerRoom = (sessionId: string) => `player:${sessionId}`

  const emitMatchFound = (match: GameMatch) => {
    for (const sessionId of match.playerIds) {
      io.to(playerRoom(sessionId)).emit('match:found', games.snapshot(match, sessionId))
    }
  }

  const resolveMatch = (sessionId: string) => {
    clearMatchTimer(sessionId)
    const player = games.getPlayer(sessionId)
    if (!player?.connected) {
      games.dequeue(sessionId)
      return
    }

    const existing = games.getMatchForPlayer(sessionId)
    if (existing?.status === 'active') {
      io.to(playerRoom(sessionId)).emit('match:found', games.snapshot(existing, sessionId))
      return
    }

    const opponentId = games.getWaitingOpponent(sessionId)
    if (opponentId && games.shouldCreateHumanMatch()) {
      clearMatchTimer(opponentId)
      const match = games.createHumanMatch(sessionId, opponentId)
      emitMatchFound(match)
      return
    }

    const match = games.createAiMatch(sessionId)
    emitMatchFound(match)
  }

  const beginSearch = (sessionId: string) => {
    clearMatchTimer(sessionId)
    games.enqueue(sessionId)
    io.to(playerRoom(sessionId)).emit('match:searching', { waitMs: MATCH_WINDOW_MS })
    const timer = setTimeout(() => resolveMatch(sessionId), MATCH_WINDOW_MS)
    matchTimers.set(sessionId, timer)
  }

  io.on('connection', (socket: Socket) => {
    const rawSessionId = socket.handshake.query.sessionId
    const sessionId = typeof rawSessionId === 'string' && rawSessionId.length <= 100
      ? rawSessionId
      : socket.id
    const player = games.registerPlayer(sessionId, socket.id)
    socket.join(playerRoom(sessionId))
    logger.info({ socketId: socket.id, sessionId }, '玩家连接')

    socket.emit('player:ready', { codename: player.codename })
    const restored = games.getMatchForPlayer(sessionId)
    if (restored?.status === 'active') {
      socket.emit('match:found', games.snapshot(restored, sessionId))
    } else if (restored?.status === 'revealed') {
      socket.emit('match:revealed', games.snapshot(restored, sessionId, true))
    }

    socket.on('match:join', () => {
      const current = games.getMatchForPlayer(sessionId)
      if (current?.status === 'active') {
        socket.emit('match:found', games.snapshot(current, sessionId))
        return
      }
      beginSearch(sessionId)
    })

    socket.on('typing:update', ({ typing }: { typing: boolean }) => {
      const match = games.getMatchForPlayer(sessionId)
      if (!match || match.status !== 'active' || match.kind !== 'human') return
      const opponent = games.getOpponent(match, sessionId)
      if (opponent) io.to(playerRoom(opponent.sessionId)).emit('opponent:typing', Boolean(typing))
    })

    socket.on('message:send', async ({ content }: { content: string }) => {
      const clean = typeof content === 'string' ? content.trim() : ''
      if (!clean || clean.length > MAX_MESSAGE_LENGTH) {
        socket.emit('error:message', { message: clean ? '消息太长了' : '消息不能为空' })
        return
      }

      const match = games.getMatchForPlayer(sessionId)
      if (!match || match.status !== 'active') {
        socket.emit('error:message', { message: '这段信号已经结束' })
        return
      }

      if (match.kind === 'ai' && aiBusy.has(match.id)) {
        socket.emit('error:message', { message: '对方还在输入，先等这一条抵达' })
        return
      }

      const ownMessage = games.addMessage(match.id, sessionId, clean, 'human')
      socket.emit('message:accepted', {
        id: ownMessage.id,
        side: 'self',
        content: ownMessage.content,
        createdAt: ownMessage.createdAt,
      })

      if (match.kind === 'human') {
        const opponent = games.getOpponent(match, sessionId)
        if (!opponent) return
        io.to(playerRoom(opponent.sessionId)).emit('opponent:typing', false)
        setTimeout(() => {
          io.to(playerRoom(opponent.sessionId)).emit('message:receive', {
            id: ownMessage.id,
            side: 'opponent',
            content: ownMessage.content,
            createdAt: ownMessage.createdAt,
          })
        }, 180 + Math.min(700, clean.length * 7))
        return
      }

      if (!match.aiPersona) return
      aiBusy.add(match.id)
      setTimeout(() => socket.emit('opponent:typing', true), 280)

      const minimumDelay = 1200 + Math.min(2600, clean.length * 35) + Math.random() * 1100
      try {
        const [reply] = await Promise.all([
          dialogue.generatePlayerReply(match.messages, match.aiPersona),
          new Promise((resolve) => setTimeout(resolve, minimumDelay)),
        ])
        if (match.status !== 'active') return
        const aiMessage = games.addMessage(match.id, `ai:${match.id}`, reply, 'ai')
        socket.emit('message:receive', {
          id: aiMessage.id,
          side: 'opponent',
          content: aiMessage.content,
          createdAt: aiMessage.createdAt,
        })
      } catch (error) {
        logger.error({ error, matchId: match.id }, 'AI玩家回复失败')
        socket.emit('error:message', { message: '对方的信号暂时中断' })
      } finally {
        aiBusy.delete(match.id)
        socket.emit('opponent:typing', false)
      }
    })

    socket.on('guess:update', (payload: { guess?: unknown } = {}) => {
      const match = games.getMatchForPlayer(sessionId)
      if (!match || match.status !== 'active') return
      if (payload?.guess !== 'human' && payload?.guess !== 'ai') { socket.emit('error:message', { message: '请先选择真人或 AI。' }); return }
      if (!games.canGuess(match, sessionId)) { socket.emit('error:message', { message: '先发送 3 条消息，再判断身份吧。' }); return }
      const guess = games.updateGuess(match.id, sessionId, payload.guess)
      socket.emit('guess:updated', guess)
    })

    socket.on('match:reveal', (payload: { guess?: unknown } = {}) => {
      const match = games.getMatchForPlayer(sessionId)
      if (!match || match.status !== 'active') return
      if (payload?.guess !== 'human' && payload?.guess !== 'ai') { socket.emit('error:message', { message: '请先选择真人或 AI，再提交判断。' }); return }
      if (!games.canGuess(match, sessionId)) { socket.emit('error:message', { message: '先发送 3 条消息，再判断身份吧。' }); return }
      games.updateGuess(match.id, sessionId, payload.guess)
      const revealed = games.reveal(match.id, sessionId)
      aiBusy.delete(revealed.id)
      for (const playerId of revealed.playerIds) {
        io.to(playerRoom(playerId)).emit('opponent:typing', false)
        io.to(playerRoom(playerId)).emit('match:revealed', games.snapshot(revealed, playerId, true))
      }
    })

    socket.on('disconnect', () => {
      clearMatchTimer(sessionId)
      const match = games.getMatchForPlayer(sessionId)
      games.disconnectPlayer(sessionId)
      if (match?.status === 'active' && match.kind === 'human') {
        const opponent = games.getOpponent(match, sessionId)
        if (opponent) io.to(playerRoom(opponent.sessionId)).emit('opponent:disconnected')
      }
      logger.info({ socketId: socket.id, sessionId }, '玩家断开')
    })
  })
}
