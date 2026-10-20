import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAiReply } from '../cloudflare/ai-response.ts'

test('AI response parser handles valid JSON, fences and plain text without adding a fake reply', () => {
  assert.deepEqual(parseAiReply('{"reply":"你好。","memory":["对方喜欢散步"]}'), { reply: '你好。', memory: ['对方喜欢散步'] })
  assert.deepEqual(parseAiReply('```json\n{"reply":"你好。"}\n```'), { reply: '你好。', memory: [] })
  assert.deepEqual(parseAiReply('  嗨。  '), { reply: '嗨。', memory: [] })
  for (const raw of ['', '      ', 'null', '{}', '{"reply":null}', '{"reply":"   "}', '[]']) assert.equal(parseAiReply(raw), null)
})

test('cut-off JSON memory can recover a complete reply but a partial reply is never shown', () => {
  assert.deepEqual(parseAiReply('{"reply":"挺累的。","memory":["对方'), { reply: '挺累的。', memory: [] })
  assert.equal(parseAiReply('{"reply":"话还没说完'), null)
  assert.deepEqual(parseAiReply('{"reply":"他说\\"慢点\\"。","memory":['), { reply: '他说"慢点"。', memory: [] })
})
