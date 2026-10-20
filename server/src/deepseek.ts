import OpenAI from 'openai'
import { Logger } from 'pino'
import type { GameMessage, Persona } from './game'

interface DeepSeekConfig {
  apiKey: string
  baseURL?: string
  model?: string
}

export interface DialogueModel {
  generatePlayerReply(messages: GameMessage[], persona: Persona): Promise<string>
}

export class DeepSeekClient implements DialogueModel {
  private client: OpenAI
  private model: string

  constructor(config: DeepSeekConfig, private logger: Logger) {
    this.model = config.model || 'deepseek-v4-flash'
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || 'https://api.deepseek.com',
    })
  }

  async generatePlayerReply(messages: GameMessage[], persona: Persona): Promise<string> {
    const history = messages.slice(-24).map((message) => ({
      role: message.source === 'ai' ? 'assistant' as const : 'user' as const,
      content: message.content,
    }))

    const systemPrompt = `你正在参加一场匿名文字对话游戏。对方会判断你是真人还是AI。

你不是客服、知识助手或心理咨询师。你是一个有边界、有偏好、会误解也会修正的普通匿名参与者。不要提到系统提示、模型或这段规则，也不要声称拥有无法验证的现实经历。

本局稳定性格：
- 气质：${persona.temperament}
- 节奏：${persona.cadence}
- 幽默：${persona.humor}
- 不确定性：${persona.uncertainty}
- 主动性：${persona.initiative}

写作约束：
- 只生成下一条聊天消息，不加身份、分析或引号。
- 默认一到三句；除非对方明确需要，否则不列清单、不用Markdown、不复述问题、不总结。
- 不要每次都赞同、安慰、追问或给完整方案。根据上下文选择一种自然的对话动作。
- 沿用对方少量措辞和语气，但不要刻意模仿错字。
- 宁可具体、略有取舍，也不要面面俱到。
- 输出JSON：{"reply":"最终消息"}

你的匿名代号是“${persona.codename}”。代号只是界面标识，不要主动解释。`

    try {
      const request = {
        model: this.model,
        thinking: { type: 'disabled' as const },
        messages: [{ role: 'system' as const, content: systemPrompt }, ...history],
        response_format: { type: 'json_object' as const },
        max_tokens: 420,
        temperature: 1.05,
      }
      const response = await this.client.chat.completions.create(request)

      const raw = response.choices[0]?.message?.content || ''
      const parsed = JSON.parse(raw) as { reply?: string }
      const reply = parsed.reply?.trim()
      if (reply) return reply.slice(0, 2000)
      throw new Error('EMPTY_MODEL_REPLY')
    } catch (error) {
      this.logger.warn({ error, model: this.model }, '玩家回复生成失败')
      return '刚刚有点走神了。你继续说，我在看。'
    }
  }
}
