import assert from 'node:assert/strict'
import test from 'node:test'
import { humanStyleProfile, summarizeHumanStyle } from '../cloudflare/style-learning.ts'
import { aiReplyDelayMs, buildAiSystemPrompt } from '../cloudflare/ai-behavior.ts'

const players = ['one', 'two']
const messages = [
  { authorId: 'one', content: '你好啊', createdAt: 1_000, source: 'human' },
  { authorId: 'two', content: '你好，你在干嘛？', createdAt: 5_000, source: 'human' },
  { authorId: 'one', content: '刚下班，等车呢。', createdAt: 11_000, source: 'human' },
  { authorId: 'two', content: '这么晚还没回去？', createdAt: 15_000, source: 'human' },
  { authorId: 'one', content: '今天收尾有点慢。', createdAt: 21_000, source: 'human' },
  { authorId: 'two', content: '那路上小心。', createdAt: 26_000, source: 'human' },
]

test('only a substantial two-person human exchange produces aggregate features', () => {
  const sample = summarizeHumanStyle(messages, players)
  assert.ok(sample)
  assert.equal(sample.messageCount, 6)
  assert.equal(sample.questionCount, 2)
  assert.equal(sample.replyDelayCount, 5)
  assert.equal(sample.totalReplyDelayMs, 25_000)
  assert.equal(JSON.stringify(sample).includes('刚下班'), false)
  assert.equal(summarizeHumanStyle(messages.slice(0, 3), players), null)
  assert.equal(summarizeHumanStyle(messages, ['one']), null)
})

test('admin and AI messages cannot contaminate the human sample', () => {
  const extra = [
    ...messages,
    { authorId: 'admin:one', content: '管理员介入', createdAt: 27_000, source: 'admin' },
    { authorId: 'ai:x', content: '机器回复', createdAt: 28_000, source: 'ai' },
  ]
  assert.deepEqual(summarizeHumanStyle(extra, players), summarizeHumanStyle(messages, players))
})

test('learning remains inactive below the threshold and bounded after activation', () => {
  const totals = {
    matchCount: 11, messageCount: 110, totalChars: 2_200, shortCount: 70,
    questionCount: 30, replyDelayCount: 80, totalReplyDelayMs: 720_000,
  }
  assert.equal(humanStyleProfile(totals), null)
  const profile = humanStyleProfile({ ...totals, matchCount: 12 })
  assert.ok(profile)
  assert.equal(profile.averageLength, 20)
  assert.equal(profile.averageReplyDelayMs, 9000)
  const prompt = buildAiSystemPrompt({ temperament: '平静', cadence: '短句', preferences: '咸食', friction: '不爱盘问' }, [], profile)
  assert.match(prompt, /交流节奏参考/)
  assert.doesNotMatch(prompt, /刚下班/)
  assert.ok(aiReplyDelayMs('这句话有一点长度。', 0, profile) > aiReplyDelayMs('这句话有一点长度。', 0))
})
