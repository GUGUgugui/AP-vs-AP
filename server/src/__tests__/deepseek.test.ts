import { beforeEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'

const mockCreate = vi.hoisted(() => vi.fn())
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockCreate } }
  },
}))

import { DeepSeekClient } from '../deepseek'
import type { Persona } from '../game'

const logger = pino({ level: 'silent' })
const persona: Persona = {
  codename: '失眠的电台',
  temperament: '克制', cadence: '短句', humor: '干冷', uncertainty: '直接承认', initiative: '偶尔追问',
}

describe('DeepSeekClient — 匿名玩家生成', () => {
  beforeEach(() => vi.clearAllMocks())

  it('使用当前模型并解析 JSON 回复', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"reply":"也许吧，你为什么突然问这个？"}' } }] })
    const client = new DeepSeekClient({ apiKey: 'test', model: 'deepseek-v4-flash' }, logger)
    const reply = await client.generatePlayerReply([
      { id: '1', authorId: 'p1', content: '你相信运气吗', source: 'human', createdAt: 1 },
    ], persona)
    expect(reply).toBe('也许吧，你为什么突然问这个？')
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    }))
  })

  it('把稳定人格写入系统提示', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"reply":"不知道。"}' } }] })
    const client = new DeepSeekClient({ apiKey: 'test' }, logger)
    await client.generatePlayerReply([], persona)
    const request = mockCreate.mock.calls[0][0]
    expect(request.messages[0].content).toContain('失眠的电台')
    expect(request.messages[0].content).toContain('克制')
  })

  it('接口失败时返回可显示的自然兜底消息', async () => {
    mockCreate.mockRejectedValueOnce(new Error('offline'))
    const client = new DeepSeekClient({ apiKey: 'test' }, logger)
    const reply = await client.generatePlayerReply([], persona)
    expect(reply.length).toBeGreaterThan(0)
  })
})
