import assert from 'node:assert/strict'
import test from 'node:test'
import { AI_GENERATION_PARAMETERS, AI_REPLY_MAX_TOKENS, aiReadPauseMs, aiReplyDelayMs, aiReplyCharacterLimit, aiReplyIssues, aiReplyRetryHint, buildAiSystemPrompt } from '../cloudflare/ai-behavior.ts'
import { AI_PERSONAS } from '../cloudflare/ai-personas.ts'

test('AI delay follows its own reply length, not the incoming message length', () => {
  const short = aiReplyDelayMs('好，明白了。', 0)
  const long = aiReplyDelayMs('这件事我可能会先放两天。现在硬做决定，反而容易把气头上的想法当成真的。', 0)
  assert.ok(short >= 2_000)
  assert.ok(long > short + 3_000)
  assert.ok(long <= 18_000)
})

test('reading pause varies with incoming message and remains bounded', () => {
  assert.ok(aiReadPauseMs(100, 0) > aiReadPauseMs(2, 0))
  assert.ok(aiReadPauseMs(10_000, 1) <= 2_500)
})

test('prompt prioritizes the conversation without claiming human identity', () => {
  const prompt = buildAiSystemPrompt({
    temperament: '直接', cadence: '短句', preferences: '咸食', friction: '不爱盘问',
  }, ['对方喜欢散步'])
  assert.match(prompt, /对方刚说的具体内容/)
  assert.match(prompt, /不声称自己是真人/)
  assert.match(prompt, /对方喜欢散步/)
  assert.doesNotMatch(prompt, /这一轮优先采用的对话动作/)
})

test('greetings and first contact have stricter Unicode character budgets than ongoing chat', () => {
  assert.equal(aiReplyCharacterLimit({ playerMessages: 1, latestUserMessage: '你好！' }), 16)
  assert.equal(aiReplyCharacterLimit({ playerMessages: 8, latestUserMessage: ' Hi! ' }), 16)
  assert.equal(aiReplyCharacterLimit({ playerMessages: 3, latestUserMessage: '平时都做些什么' }), 36)
  assert.equal(aiReplyCharacterLimit({ playerMessages: 4, latestUserMessage: '平时都做些什么' }), 60)
  assert.equal(aiReplyCharacterLimit({ playerMessages: 1, latestUserMessage: '你好，我想聊最近的事情' }), 36)
  assert.deepEqual(aiReplyIssues('😀'.repeat(36)), [])
  assert.deepEqual(aiReplyIssues('字'.repeat(37)), ['too_long'])
  assert.equal(AI_REPLY_MAX_TOKENS, 320)
})

test('first greetings never become an automatic interview or service welcome', () => {
  const context = { playerMessages: 1, latestUserMessage: '你好' }
  assert.deepEqual(aiReplyIssues('你好。', context), [])
  assert.deepEqual(aiReplyIssues('嗨', context), [])
  assert.ok(aiReplyIssues('你好。想聊什么？', context).includes('opening_followup'))
  assert.ok(aiReplyIssues('很高兴认识你！', context).includes('overfamiliar_template'))
  assert.ok(aiReplyIssues('哇！！你好！', context).includes('too_enthusiastic'))
  assert.ok(aiReplyIssues('你多大？在哪？').includes('too_many_questions'))
  assert.ok(aiReplyIssues('- 首先\n- 其次').includes('formatted_reply'))
})

test('learned verbosity cannot override first-contact restraint or mutate real statistics', () => {
  const profile = { matchCount: 12, messageCount: 96, averageLength: 80, shortRatio: 0.1, questionRatio: 0.6, averageReplyDelayMs: 7200 }
  const prompt = buildAiSystemPrompt(AI_PERSONAS[1], [], profile, { playerMessages: 1, latestUserMessage: '我刚下班' })
  assert.match(prompt, /参考长度不超过 20 字/)
  assert.match(prompt, /最多 36 个字符/)
  assert.match(prompt, /慢热、低主动/)
  assert.match(prompt, /简短关心/)
  assert.doesNotMatch(prompt, /确实需要时可以稍长/)
  assert.equal(profile.averageLength, 80)
})

test('all four production personalities remain restrained with bounded retry guidance', () => {
  assert.equal(AI_PERSONAS.length, 4)
  for (const persona of AI_PERSONAS) {
    const prompt = buildAiSystemPrompt(persona, [], null, { playerMessages: 1, latestUserMessage: '你好' })
    assert.match(prompt, /最多 16 个字符/)
    assert.match(prompt, /不声称自己是真人/)
    assert.match(prompt, /不设“需要时更长”的例外/)
  }
  assert.match(aiReplyRetryHint({ playerMessages: 1, latestUserMessage: '你好' }), /最多 16 个字符/)
  assert.match(aiReplyRetryHint({ playerMessages: 1 }), /不.*解释或道歉/)
})

test('production and live evaluation share bounded generation settings without forced JSON mode', () => {
  assert.deepEqual(AI_GENERATION_PARAMETERS, { thinking: { type: 'disabled' }, max_tokens: 320, temperature: 0.9 })
  assert.equal(Object.hasOwn(AI_GENERATION_PARAMETERS, 'response_format'), false)
})
