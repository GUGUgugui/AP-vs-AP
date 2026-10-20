export interface StyleMessage {
  authorId: string
  content: string
  createdAt: number
  source: 'human' | 'ai' | 'admin'
}

export interface HumanStyleSample {
  messageCount: number
  totalChars: number
  shortCount: number
  questionCount: number
  replyDelayCount: number
  totalReplyDelayMs: number
}

export interface HumanStyleTotals extends HumanStyleSample {
  matchCount: number
}

export interface HumanStyleProfile {
  matchCount: number
  messageCount: number
  averageLength: number
  shortRatio: number
  questionRatio: number
  averageReplyDelayMs: number
}

export const STYLE_MIN_MATCHES = 12
export const STYLE_MIN_MESSAGES = 72

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function summarizeHumanStyle(messages: readonly StyleMessage[], playerIds: readonly string[]): HumanStyleSample | null {
  if (playerIds.length !== 2 || playerIds[0] === playerIds[1]) return null
  const accepted = new Set(playerIds)
  const counts = new Map(playerIds.map((id) => [id, 0]))
  const unique = new Map(playerIds.map((id) => [id, new Set<string>()]))
  const selected: StyleMessage[] = []

  for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
    if (message.source !== 'human' || !accepted.has(message.authorId)) continue
    const content = message.content.trim()
    const length = Array.from(content).length
    if (length < 2 || length > 160 || (counts.get(message.authorId) || 0) >= 20) continue
    counts.set(message.authorId, (counts.get(message.authorId) || 0) + 1)
    unique.get(message.authorId)?.add(content)
    selected.push(message)
  }

  if (selected.length < 6 || playerIds.some((id) => (counts.get(id) || 0) < 2)) return null
  if (playerIds.some((id) => (unique.get(id)?.size || 0) < Math.ceil((counts.get(id) || 0) / 2))) return null

  const sample: HumanStyleSample = {
    messageCount: selected.length,
    totalChars: 0,
    shortCount: 0,
    questionCount: 0,
    replyDelayCount: 0,
    totalReplyDelayMs: 0,
  }

  for (let index = 0; index < selected.length; index++) {
    const message = selected[index]
    const length = Array.from(message.content.trim()).length
    sample.totalChars += length
    if (length <= 18) sample.shortCount++
    if (/[?？]/.test(message.content)) sample.questionCount++
    const previous = selected[index - 1]
    if (previous && previous.authorId !== message.authorId) {
      const delay = message.createdAt - previous.createdAt
      if (delay >= 1000 && delay <= 60_000) {
        sample.replyDelayCount++
        sample.totalReplyDelayMs += delay
      }
    }
  }

  return sample
}

export function humanStyleProfile(totals: HumanStyleTotals): HumanStyleProfile | null {
  if (totals.matchCount < STYLE_MIN_MATCHES || totals.messageCount < STYLE_MIN_MESSAGES) return null
  const messageCount = totals.messageCount
  const averageReplyDelayMs = totals.replyDelayCount > 0
    ? clamp(Math.round(totals.totalReplyDelayMs / totals.replyDelayCount), 3000, 12_000)
    : 6500
  return {
    matchCount: totals.matchCount,
    messageCount,
    averageLength: Math.round(clamp(totals.totalChars / messageCount, 8, 80)),
    shortRatio: clamp(totals.shortCount / messageCount, 0.1, 0.75),
    questionRatio: clamp(totals.questionCount / messageCount, 0, 0.6),
    averageReplyDelayMs,
  }
}
