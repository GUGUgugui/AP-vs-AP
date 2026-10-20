interface TrainingMessage { author_id: string; content: string; source: string }
export function trainingExamples(messages: TrainingMessage[], players: string[]) {
  if (players.length !== 2 || new Set(players).size !== 2 || messages.length < 6 || messages.some(message => message.source !== 'human' || !players.includes(message.author_id))) return []
  if (players.some(player => messages.filter(message => message.author_id === player).length < 2)) return []
  // This is a conservative screen, not a claim of complete automatic anonymization.
  const sensitive = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)|(?:微信|手机号|电话号码|家庭住址|身份证)\s*[:：]/
  if (messages.some(message => sensitive.test(message.content))) return []
  return players.flatMap(player => {
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const message of messages.slice(-24)) {
      const role = message.author_id === player ? 'assistant' : 'user'
      if (!turns.length && role === 'assistant') continue
      if (turns.at(-1)?.role === role) turns[turns.length - 1].content += '\n' + message.content
      else turns.push({ role, content: message.content })
    }
    if (turns.at(-1)?.role === 'user') turns.pop()
    return turns.length >= 2 ? [{ messages: [{ role: 'system', content: '你是匿名聊天游戏中的虚构角色。用自然口语回应，不自称真人，不编造可验证身份。' }, ...turns] }] : []
  })
}
export async function refreshTrainingSample(db: D1Database, matchId: string) {
  const match = await db.prepare("SELECT id,message_count FROM matches WHERE id=? AND kind='human' AND end_reason='judged' AND intervention_count=0 AND NOT EXISTS(SELECT 1 FROM player_reports WHERE match_id=?)").bind(matchId, matchId).first<{ message_count: number }>()
  if (!match) return
  const participants = await db.prepare('SELECT session_id FROM participants WHERE match_id=?').bind(matchId).all<{ session_id: string }>()
  const players = (participants.results || []).map(row => row.session_id)
  const consents = await db.prepare('SELECT player_id FROM training_consents WHERE match_id=? AND consent=1 AND consent_version=1').bind(matchId).all<{ player_id: string }>()
  if (players.length !== 2 || !players.every(player => consents.results?.some(row => row.player_id === player))) return
  const messages = await db.prepare('SELECT author_id,content,source FROM messages WHERE match_id=? ORDER BY message_index,created_at,id').bind(matchId).all<TrainingMessage>()
  if ((messages.results || []).length !== match.message_count) return
  const examples = trainingExamples(messages.results || [], players)
  if (!examples.length) return
  // Consent checks are repeated in the INSERT to prevent a concurrent revocation
  // from being undone by a slower sample-generation request.
  await db.prepare(`INSERT OR IGNORE INTO training_samples(match_id,examples_json,created_at)
    SELECT ?,?,? WHERE (SELECT COUNT(*) FROM training_consents WHERE match_id=? AND consent=1 AND consent_version=1)=2
      AND NOT EXISTS(SELECT 1 FROM player_reports WHERE match_id=?)`).bind(matchId, JSON.stringify(examples), Date.now(), matchId, matchId).run()
}
