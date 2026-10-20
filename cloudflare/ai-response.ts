/** Preserve a complete reply, even when only the trailing JSON memory was cut off. */
export function parseAiReply(raw: string): { reply: string; memory: string[] } | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (!cleaned) return null
  try {
    const parsed = JSON.parse(cleaned) as { reply?: unknown; memory?: unknown } | null
    if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
      const memory = Array.isArray(parsed.memory)
        ? parsed.memory.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim().slice(0, 160)).slice(0, 6)
        : []
      return { reply: parsed.reply.trim().slice(0, 2000), memory }
    }
  } catch {
    const replyMatch = cleaned.match(/"reply"\s*:\s*("(?:\\.|[^"\\])*")/s)
    if (replyMatch) {
      try {
        const reply = JSON.parse(replyMatch[1]) as unknown
        if (typeof reply === 'string' && reply.trim()) return { reply: reply.trim().slice(0, 2000), memory: [] }
      } catch { /* An incomplete reply string must not become a displayed fragment. */ }
    }
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) return { reply: cleaned.slice(0, 2000), memory: [] }
  }
  return null
}
