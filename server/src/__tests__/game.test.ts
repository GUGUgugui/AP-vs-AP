import { describe, expect, it } from 'vitest'
import pino from 'pino'
import { GameManager, codenameFor } from '../game'

const logger = pino({ level: 'silent' })
function chatThree(games: GameManager, matchId: string, playerId: string) {
  for (const content of ['你好', '今天怎么样', '我还想多聊聊']) games.addMessage(matchId, playerId, content, 'human')
}

describe('GameManager — 迷雾对局领域', () => {
  it('为同一会话生成稳定代号', () => {
    expect(codenameFor('player-a')).toBe(codenameFor('player-a'))
    expect(codenameFor('player-a')).not.toBe(codenameFor('player-b'))
  })

  it('重连时保留玩家身份并更新 socket', () => {
    const games = new GameManager(logger)
    const first = games.registerPlayer('p1', 'socket-1')
    games.disconnectPlayer('p1')
    const restored = games.registerPlayer('p1', 'socket-2')
    expect(restored.codename).toBe(first.codename)
    expect(restored.socketId).toBe('socket-2')
    expect(restored.connected).toBe(true)
  })

  it('创建真人对局并在揭晓前隐藏来源', () => {
    const games = new GameManager(logger)
    games.registerPlayer('p1', 's1')
    games.registerPlayer('p2', 's2')
    games.enqueue('p1'); games.enqueue('p2')
    const match = games.createHumanMatch('p1', 'p2')
    games.addMessage(match.id, 'p2', '你觉得呢？', 'human')

    const hidden = games.snapshot(match, 'p1')
    expect(hidden).not.toHaveProperty('truth')
    expect(hidden.messages[0]).not.toHaveProperty('source')
    expect(hidden.messages[0].side).toBe('opponent')

    chatThree(games, match.id, 'p1')
    games.updateGuess(match.id, 'p1', 'human')
    games.reveal(match.id, 'p1')
    const revealed = games.snapshot(match, 'p1', true)
    expect(revealed.truth).toBe('human')
    expect(revealed.guess).toBe('human')
    expect(revealed).not.toHaveProperty('score')
    expect(revealed.correct).toBe(true)
    expect(revealed.messages[0].source).toBe('human')
  })

  it('创建带稳定人格的 AI 对局', () => {
    const games = new GameManager(logger)
    games.registerPlayer('p1', 's1')
    const match = games.createAiMatch('p1')
    expect(match.kind).toBe('ai')
    expect(match.aiPersona?.codename).toBeTruthy()
    expect(games.getOpponentCodename(match, 'p1')).toBe(match.aiPersona?.codename)
  })

  it('AI 二选一判断可更改，揭晓后不能再修改', () => {
    const games = new GameManager(logger)
    games.registerPlayer('p1', 's1')
    const match = games.createAiMatch('p1')
    expect(games.snapshot(match, 'p1').guess).toBeNull()
    chatThree(games, match.id, 'p1')
    games.updateGuess(match.id, 'p1', 'human')
    games.updateGuess(match.id, 'p1', 'ai')
    games.reveal(match.id, 'p1')
    const result = games.snapshot(match, 'p1', true)
    expect(result.truth).toBe('ai')
    expect(result.guess).toBe('ai')
    expect(result).not.toHaveProperty('score')
    expect(result.correct).toBe(true)
    expect(() => games.updateGuess(match.id, 'p1', 'human')).toThrow('MATCH_NOT_ACTIVE')
    expect(games.snapshot(match, 'p1', true).guess).toBe('ai')
  })

  it('未选择不能主动揭晓，对方先揭晓时未选择仍为未判断', () => {
    const games = new GameManager(logger)
    games.registerPlayer('p1', 's1')
    games.registerPlayer('p2', 's2')
    const match = games.createHumanMatch('p1', 'p2')
    expect(() => games.reveal(match.id, 'p1')).toThrow('CHOICE_REQUIRED')
    expect(() => games.updateGuess(match.id, 'p1', 'bot' as any)).toThrow('CHOICE_REQUIRED')
    expect(match.status).toBe('active')
    chatThree(games, match.id, 'p2')
    games.updateGuess(match.id, 'p2', 'ai')
    games.reveal(match.id, 'p2')
    expect(games.snapshot(match, 'p1', true).correct).toBeNull()
    expect(games.snapshot(match, 'p1', true).guess).toBeNull()
    expect(games.snapshot(match, 'p2', true).correct).toBe(false)
  })

  it('揭晓后可以重新进入匹配队列', () => {
    const games = new GameManager(logger)
    games.registerPlayer('p1', 's1')
    const match = games.createAiMatch('p1')
    chatThree(games, match.id, 'p1')
    games.updateGuess(match.id, 'p1', 'ai')
    games.reveal(match.id, 'p1')
    games.enqueue('p1')
    expect(games.getWaitingOpponent('someone-else')).toBe('p1')
    expect(games.getMatchForPlayer('p1')).toBeUndefined()
  })

  it('判断必须由自己发送三条消息解锁，对手和 AI 的消息不计入', () => {
    const games = new GameManager(logger)
    games.registerPlayer('p1', 's1'); games.registerPlayer('p2', 's2')
    const match = games.createHumanMatch('p1', 'p2')
    chatThree(games, match.id, 'p2')
    expect(games.canGuess(match, 'p1')).toBe(false)
    expect(() => games.updateGuess(match.id, 'p1', 'human')).toThrow('CHAT_REQUIRED')
    games.addMessage(match.id, 'p1', '第一条', 'human')
    games.addMessage(match.id, 'p1', '第二条', 'human')
    expect(() => games.updateGuess(match.id, 'p1', 'human')).toThrow('CHAT_REQUIRED')
    games.addMessage(match.id, 'p1', '第三条', 'human')
    expect(games.canGuess(match, 'p1')).toBe(true)
    expect(games.updateGuess(match.id, 'p1', 'human').guess).toBe('human')
  })
})
