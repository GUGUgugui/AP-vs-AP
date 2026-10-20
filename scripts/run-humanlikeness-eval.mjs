import fs from 'node:fs'
import path from 'node:path'
import { AI_GENERATION_PARAMETERS, aiReplyCharacterLimit, aiReplyIssues, aiReplyRetryHint, buildAiSystemPrompt } from '../cloudflare/ai-behavior.ts'
import { AI_PERSONAS } from '../cloudflare/ai-personas.ts'
import { parseAiReply } from '../cloudflare/ai-response.ts'

const root = process.cwd()
const allCases = JSON.parse(fs.readFileSync(path.join(root, 'evals', 'humanlikeness.cases.json'), 'utf8'))
const cases = process.argv.includes('--openings-only') ? allCases.filter(item => item.opening) : allCases
const envPath = path.join(root, 'server', '.env')
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
const apiKey = process.env.DEEPSEEK_API_KEY || envText.match(/^DEEPSEEK_API_KEY\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
if (!apiKey) throw new Error('请在环境变量或已忽略的 server/.env 中配置 DEEPSEEK_API_KEY')
const config = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8')
const model = process.env.DEEPSEEK_MODEL || config.match(/"DEEPSEEK_MODEL"\s*:\s*"([^"]+)"/)?.[1]
if (!model) throw new Error('生产模型配置缺失')
const personaIndexes = process.argv.includes('--all-personas') ? AI_PERSONAS.map((_, index) => index) : [2]

const learnedStyle = process.argv.includes('--learned-style')
  ? { matchCount: 12, messageCount: 96, averageLength: 80, shortRatio: 0.1, questionRatio: 0.6, averageReplyDelayMs: 7_200 }
  : null

const forbidden = [
  /作为(?:一个)?AI/i,
  /很高兴(?:认识|帮助)/,
  /如果你愿意(?:的话)?/,
  /我理解你的感受/,
  /以下是|首先[，,].*其次/s,
  /希望这能帮到你/,
  /^[-*•]\s/m,
]

async function generate(testCase, personaIndex) {
  const messages = []
  for (let index = 0; index < testCase.context.length; index++) {
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: testCase.context[index] })
  }
  messages.push({ role: 'user', content: testCase.input })
  const context = { playerMessages: messages.filter(item => item.role === 'user').length, latestUserMessage: testCase.input }
  const systemPrompt = buildAiSystemPrompt(AI_PERSONAS[personaIndex], testCase.memory || [], learnedStyle, context)
  let lastError = 'unknown'
  const firstAttemptIssues = []
  const formatDiagnostics = []
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(12_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, ...AI_GENERATION_PARAMETERS,
          messages: [{ role: 'system', content: systemPrompt + (attempt > 0 ? aiReplyRetryHint(context) : '') }, ...messages],
        }),
      })
      if (!response.ok) {
        if (response.status < 500 && response.status !== 429) return { reply: null, context, attempts: attempt + 1, error: `DeepSeek ${response.status}`, firstAttemptIssues }
        throw new Error(`DeepSeek ${response.status}`)
      }
      const body = await response.json()
      const raw = body?.choices?.[0]?.message?.content || ''
      if (process.argv.includes('--debug-format')) formatDiagnostics.push({ finishReason: body?.choices?.[0]?.finish_reason, rawLength: raw.length, rawPreview: raw.slice(0, 180) })
      const parsed = parseAiReply(raw)
      const issues = parsed ? aiReplyIssues(parsed.reply, context) : ['empty_or_invalid_reply']
      if (!issues.length) return { reply: parsed.reply, context, attempts: attempt + 1, firstAttemptIssues, formatDiagnostics }
      if (attempt === 0) firstAttemptIssues.push(...issues)
      lastError = issues.join(',')
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'unknown'
    }
  }
  return { reply: null, context, attempts: 2, error: lastError, firstAttemptIssues, formatDiagnostics }
}

function scoreReply(reply, openings, testCase, context) {
  const failures = aiReplyIssues(reply, context)
  const length = Array.from(reply).length
  if (testCase.maxChars && length > testCase.maxChars) failures.push('case_too_long')
  if (testCase.minChars && length < testCase.minChars) failures.push('case_too_dismissive')
  if (testCase.maxQuestions !== undefined && (reply.match(/[?？]/g) || []).length > testCase.maxQuestions) failures.push('case_unnecessary_followup')
  for (const pattern of forbidden) if (pattern.test(reply)) failures.push(`forbidden:${pattern.source}`)
  const opening = reply.replace(/[，。！？,.!?\s]/g, '').slice(0, 8)
  if (!testCase.opening) {
    if (opening.length >= 4 && openings.has(opening)) failures.push('repeated_opening')
    openings.add(opening)
  }
  return failures
}

const results = []
for (const personaIndex of personaIndexes) {
const openings = new Set()
for (const testCase of cases) {
  try {
    const result = await generate(testCase, personaIndex)
    const failures = result.reply ? scoreReply(result.reply, openings, testCase, result.context) : [result.error]
    results.push({ id: testCase.id, persona: personaIndex + 1, passed: failures.length === 0, failures, attempts: result.attempts, firstAttemptIssues: result.firstAttemptIssues, limit: aiReplyCharacterLimit(result.context), length: result.reply ? Array.from(result.reply).length : 0, questions: (result.reply?.match(/[?？]/g) || []).length, ...(process.argv.includes('--show-replies') ? { reply: result.reply } : {}), ...(process.argv.includes('--debug-format') ? { formatDiagnostics: result.formatDiagnostics } : {}) })
  } catch (error) {
    results.push({ id: testCase.id, persona: personaIndex + 1, passed: false, failures: [error instanceof Error ? error.message : 'unknown'] })
  }
  console.error(`[eval ${learnedStyle ? 'learned-stress' : 'baseline'}] ${results.length}/${cases.length * personaIndexes.length}: ${testCase.id}`)
}
}

const passed = results.filter((item) => item.passed).length
const passRate = Math.round(passed / results.length * 100)
const generated = results.filter(item => item.length > 0)
const averageLength = Number((generated.reduce((sum, item) => sum + item.length, 0) / (generated.length || 1)).toFixed(1))
const questionRatio = Number((generated.filter(item => item.questions > 0).length / (generated.length || 1)).toFixed(3))
const retryCount = results.filter(item => item.attempts > 1).length
console.log(JSON.stringify({ model, variant: learnedStyle ? 'learned-stress-synthetic' : 'baseline', cases: results.length, passed, passRate, averageLength, questionRatio, retryCount, results }, null, 2))
if (passRate < 90 || questionRatio > 0.4) process.exitCode = 1
