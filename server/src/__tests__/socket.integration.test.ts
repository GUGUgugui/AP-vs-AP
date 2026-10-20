import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client'
import pino from 'pino'
import { GameManager } from '../game'
import { setupSocketHandlers } from '../socket'
import type { DialogueModel } from '../deepseek'

const logger = pino({ level: 'silent' })
const dialogue: DialogueModel = {
  generatePlayerReply: async () => '我也不太确定，可能要再聊两句。',
}

function waitFor(socket: ClientSocket, event: string, timeout = 6000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${event}`)), timeout)
    socket.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

describe('Socket.IO 迷雾对局集成', () => {
  let httpServer: ReturnType<typeof createServer>
  let io: Server
  let port: number

  beforeAll(async () => {
    httpServer = createServer()
    io = new Server(httpServer)
    setupSocketHandlers(io, new GameManager(logger), dialogue, logger)
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    const address = httpServer.address()
    port = typeof address === 'object' && address ? address.port : 3001
  })

  afterAll(() => {
    io.close()
    httpServer.close()
  })

  it('单个玩家会匹配到 AI、自由聊天并揭晓', async () => {
    const socket = createClient(`http://localhost:${port}`, { query: { sessionId: 'solo' }, transports: ['websocket'] })
    await waitFor(socket, 'player:ready')
    socket.emit('match:join')
    const match = await waitFor(socket, 'match:found')
    expect(match).not.toHaveProperty('truth')
    expect(match.guess).toBeNull()
    socket.emit('match:reveal', {})
    expect((await waitFor(socket, 'error:message')).message).toContain('请先选择')

    socket.emit('message:send', { content: '你觉得自己像真人吗？' })
    const accepted = await waitFor(socket, 'message:accepted')
    expect(accepted.side).toBe('self')
    const reply = await waitFor(socket, 'message:receive')
    expect(reply.content).toContain('不太确定')

    socket.emit('guess:update', { guess: 'ai' })
    expect((await waitFor(socket, 'error:message')).message).toContain('3 条消息')
    for (const content of ['最近忙什么', '我想再聊一句']) {
      const nextReply = waitFor(socket, 'message:receive')
      socket.emit('message:send', { content })
      await waitFor(socket, 'message:accepted')
      await nextReply
    }

    socket.emit('guess:update', { guess: 'ai' })
    await waitFor(socket, 'guess:updated')
    socket.emit('match:reveal', { guess: 'ai' })
    const result = await waitFor(socket, 'match:revealed')
    expect(result.truth).toBe('ai')
    expect(result.guess).toBe('ai')
    expect(result.correct).toBe(true)
    expect(result).not.toHaveProperty('score')
    socket.disconnect()
  }, 25000)

  it('两个等待玩家可以进入真人对局并互相收发消息', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const a = createClient(`http://localhost:${port}`, { query: { sessionId: 'human-a' }, transports: ['websocket'] })
    const b = createClient(`http://localhost:${port}`, { query: { sessionId: 'human-b' }, transports: ['websocket'] })
    await Promise.all([waitFor(a, 'player:ready'), waitFor(b, 'player:ready')])
    a.emit('match:join'); b.emit('match:join')
    const [matchA, matchB] = await Promise.all([waitFor(a, 'match:found'), waitFor(b, 'match:found')])
    expect(matchA.id).toBe(matchB.id)

    a.emit('message:send', { content: '收到吗？' })
    await waitFor(a, 'message:accepted')
    const received = await waitFor(b, 'message:receive')
    expect(received.content).toBe('收到吗？')

    for (const content of ['收到了', '你那边天气如何', '我这边还不错']) {
      const delivered = waitFor(a, 'message:receive')
      b.emit('message:send', { content })
      await waitFor(b, 'message:accepted')
      await delivered
    }
    b.emit('match:reveal', { guess: 'human' })
    const [result, unjudged] = await Promise.all([waitFor(b, 'match:revealed'), waitFor(a, 'match:revealed')])
    expect(result.truth).toBe('human')
    expect(result.correct).toBe(true)
    expect(unjudged.guess).toBeNull()
    expect(unjudged.correct).toBeNull()
    random.mockRestore()
    a.disconnect(); b.disconnect()
  })
})
