export const FEEDBACK_TAGS = { natural: '很自然', too_fast: '回复太快', formal: '说话太正式', repetitive: '复读', incoherent: '不连贯' } as const
export const REPORT_REASONS = { harassment: '骚扰或辱骂', privacy: '索取或泄露隐私', spam: '广告或刷屏', unsafe: '危险或违法内容', other: '其他问题' } as const
export const BADGES = [
  { code: 'first_judgment', title: '初次观察', description: '完成一次有效身份判断' },
  { code: 'first_ai', title: '识破机器', description: '首次正确识别 AI' },
  { code: 'ten_judgments', title: '十次观察', description: '完成十次有效身份判断' },
  { code: 'streak_five', title: '连续洞察', description: '连续五次有效判断正确' },
] as const
export type EndReason = 'judged' | 'left' | 'skipped' | 'reported'
export function feedbackTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5 || value.some(tag => typeof tag !== 'string' || !Object.hasOwn(FEEDBACK_TAGS, tag))) return null
  const tags = [...new Set(value)] as string[]
  return tags.includes('natural') && tags.length > 1 ? null : tags
}
export function validReport(value: Record<string, unknown>) {
  if (typeof value.reason !== 'string' || !Object.hasOwn(REPORT_REASONS, value.reason)) return null
  if (value.description !== undefined && typeof value.description !== 'string') return null
  const description = String(value.description || '').trim()
  return description.length <= 400 ? { reason: value.reason, description } : null
}
export interface ResultRow { id: string; truth: string; correct: number | null; end_reason: string; intervention_count: number; created_at: number }
export function validJudgment(row: ResultRow): boolean { return row.end_reason === 'judged' && !Number(row.intervention_count) && row.correct !== null }
export function summarizeResults(rows: ResultRow[]) {
  const judged = rows.filter(validJudgment).sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
  const correct = judged.filter(row => Number(row.correct) === 1).length
  let streak = 0
  for (const row of judged) { if (Number(row.correct) !== 1) break; streak++ }
  return { total: rows.length, judged: judged.length, correct, accuracy: judged.length ? Math.round(correct / judged.length * 1000) / 10 : null, skipped: rows.filter(row => row.end_reason !== 'judged').length, interventions: rows.filter(row => Number(row.intervention_count) > 0).length, unanswered: rows.filter(row => row.end_reason === 'judged' && row.correct === null).length, streak }
}
export function earnedBadges(rows: ResultRow[]): string[] {
  const summary = summarizeResults(rows)
  const codes: string[] = []
  if (summary.judged > 0) codes.push('first_judgment')
  if (rows.some(row => validJudgment(row) && row.truth === 'ai' && Number(row.correct) === 1)) codes.push('first_ai')
  if (summary.judged >= 10) codes.push('ten_judgments')
  // Detect an achieved run anywhere in retained history, not only the current run.
  let run = 0
  for (const row of rows.filter(validJudgment).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))) {
    run = Number(row.correct) === 1 ? run + 1 : 0
    if (run >= 5) { codes.push('streak_five'); break }
  }
  return codes
}
