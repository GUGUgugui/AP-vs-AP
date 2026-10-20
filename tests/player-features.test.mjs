import test from 'node:test'
import assert from 'node:assert/strict'
import { feedbackTags, validReport, summarizeResults, earnedBadges } from '../cloudflare/player-rules.ts'
import { trainingExamples } from '../cloudflare/training-dataset.ts'
import { uniqueMessages,appendMessage } from '../client/src/message-log.ts'
test('snapshot and streamed acknowledgments cannot produce duplicate message IDs',()=>{
  const messages=[{id:'one',content:'你好'},{id:'two',content:'嗨'}]
  assert.equal(appendMessage(messages,messages[0]),messages)
  assert.equal(appendMessage(messages,{id:'three'}).length,3)
  assert.equal(uniqueMessages([...messages,...messages]).length,2)
})
test('feedback accepts only known tags and never trains on contradictory natural/problem labels', () => {
  assert.deepEqual(feedbackTags(['formal','formal','too_fast']), ['formal','too_fast'])
  for (const value of [[],null,['bad'],['__proto__'],['toString'],['natural','formal'],Array(6).fill('formal')]) assert.equal(feedbackTags(value),null)
  assert.deepEqual(feedbackTags(['natural']),['natural'])
})
test('report validates reason and bounded text without trusting object prototypes', () => {
  assert.deepEqual(validReport({ reason: 'spam', description: ' 广告 ' }),{ reason: 'spam', description: '广告' })
  for (const value of [{ reason: '__proto__' },{ reason:'other',description:[] },{ reason:'other',description:'a'.repeat(401) }]) assert.equal(validReport(value),null)
})
const result = (index, correct=1, extra={}) => ({ id: String(index), truth:'ai',correct,end_reason:'judged',intervention_count:0,created_at:index,...extra })
test('aborted, unanswered and operator-assisted games cannot award accuracy or badges', () => {
  const rows=[result(1,1,{end_reason:'left'}),result(2,1,{end_reason:'skipped'}),result(3,0,{end_reason:'reported'}),result(4,1,{intervention_count:1}),result(5,null)]
  assert.equal(summarizeResults(rows).judged,0); assert.equal(summarizeResults(rows).accuracy,null); assert.deepEqual(earnedBadges(rows),[])
  assert.equal(summarizeResults(rows).skipped,3)
})
test('badges use real results and a previous five-win streak remains earned after a loss', () => {
  const rows=Array.from({length:10},(_,index)=>result(index,index===9?0:1))
  assert.equal(summarizeResults(rows).accuracy,90); assert.equal(summarizeResults(rows).streak,0)
  assert.deepEqual(earnedBadges(rows),['first_judgment','first_ai','ten_judgments','streak_five'])
})
const humanMessages = Array.from({length:6},(_,index)=>({author_id:index%2?'p2':'p1',source:'human',content:`第${index}句自然对话`}))
test('raw-text dataset builds two anonymous perspectives with only genuine human targets', () => {
  const examples=trainingExamples(humanMessages,['p1','p2']); assert.equal(examples.length,2)
  for(const example of examples) { assert.equal(example.messages[1].role,'user'); assert.equal(example.messages.at(-1).role,'assistant'); assert.equal(JSON.stringify(example).includes('p1'),false) }
  assert.ok(examples[0].messages.some(message=>message.content===humanMessages[2].content))
})
test('training screens incomplete, AI, admin and obvious personal-information samples', () => {
  assert.deepEqual(trainingExamples(humanMessages.slice(0,3),['p1','p2']),[])
  for (const replacement of [{source:'ai'},{source:'admin'},{content:'邮箱 test@example.com'},{content:'我的手机号 13800138000'},{content:'https://example.com'}]) assert.deepEqual(trainingExamples(humanMessages.map((message,index)=>index===2?{...message,...replacement}:message),['p1','p2']),[])
})
