import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const WebSocket = require(require.resolve('ws', { paths: [fileURLToPath(new URL('../server', import.meta.url))] }))
const base = 'http://localhost:8787', suffix = Date.now().toString(36), sockets = [], checks = []
async function api(path, body, cookie, method, origin = base) {
  const response = await fetch(base + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Origin: origin, 'Content-Type':'application/json', 'CF-Connecting-IP':`feature-${suffix}`, ...(cookie ? { Cookie:cookie } : {}) }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) })
  const raw = await response.text()
  return { status:response.status, data: raw ? (response.headers.get('Content-Type')?.includes('json') && !response.headers.get('Content-Type')?.includes('ndjson') ? JSON.parse(raw) : raw) : null, cookie:response.headers.get('Set-Cookie')?.split(';')[0] }
}
function connect(cookie, admin = false) {
  const socket=new WebSocket(`${base.replace('http','ws')}/${admin?'admin/ws':'ws'}`,{headers:{Origin:base,Cookie:cookie}}), queue=[], pending=[]
  sockets.push(socket); socket.on('error',()=>{})
  socket.on('message',raw=>{const item=JSON.parse(String(raw)),index=pending.findIndex(entry=>entry.type===item.type);if(index<0)queue.push(item);else{const[entry]=pending.splice(index,1);clearTimeout(entry.timer);entry.resolve(item.payload)}})
  return {socket,send:(type,payload={})=>socket.send(JSON.stringify({type,payload})),next(type){const index=queue.findIndex(item=>item.type===type);if(index>=0)return Promise.resolve(queue.splice(index,1)[0].payload);return new Promise((resolve,reject)=>{const entry={type,resolve,timer:setTimeout(()=>{pending.splice(pending.indexOf(entry),1);reject(new Error('Timeout '+type))},12000)};pending.push(entry)})}}
}
try {
  assert.equal((await api('/api/player/profile')).status,401)
  const ga=await api('/api/auth/guest',{}),gb=await api('/api/auth/guest',{}),outsider=await api('/api/auth/guest',{})
  const a=connect(ga.cookie),b=connect(gb.cookie);await Promise.all([a.next('player:ready'),b.next('player:ready')])
  let first, second
  for(let attempt=0;attempt<8;attempt++){
    a.send('match:join',{styleOptIn:false});b.send('match:join',{styleOptIn:false});[first,second]=await Promise.all([a.next('match:found'),b.next('match:found')])
    if(first.id===second.id)break
    a.send('match:leave',{matchId:first.id});b.send('match:leave',{matchId:second.id});const ended=await Promise.all([a.next('match:revealed'),b.next('match:revealed')]);assert.ok(ended.every(match=>match.correct===null&&match.endReason==='left'))
  }
  assert.equal(first.id,second.id,'real human pair');assert.equal(Object.hasOwn(first,'truth'),false)
  assert.equal((await api(`/api/player/history/${first.id}`,undefined,ga.cookie)).status,404)
  assert.equal((await api('/api/player/report',{matchId:first.id,reason:'spam'},outsider.cookie)).status,404)
  assert.equal((await api('/api/player/feedback',{matchId:first.id,tags:['natural']},ga.cookie)).status,409)
  checks.push('authentication, active-room identity concealment and foreign-player report/read rejection')
  for(let index=0;index<3;index++){
    a.send('message:send',{content:`feature_${suffix}_甲_${index}`});await a.next('message:accepted');await b.next('message:receive')
    b.send('message:send',{content:`feature_${suffix}_乙_${index}`});await b.next('message:accepted');await a.next('message:receive')
  }
  b.send('guess:update',{guess:'human'});await b.next('guess:updated');a.send('match:reveal',{guess:'human'})
  const[resultA,resultB]=await Promise.all([a.next('match:revealed'),b.next('match:revealed')]);assert.equal(resultA.correct,true);assert.equal(resultB.correct,true)
  const detail=await api(`/api/player/history/${first.id}`,undefined,ga.cookie);assert.equal(detail.status,200);assert.equal(detail.data.messages.length,6);assert.equal(detail.data.messages.filter(message=>message.side==='self').length,3)
  assert.equal(Object.hasOwn(detail.data.match,'viewer_id'),false);assert.equal((await api(`/api/player/history/${first.id}`,undefined,outsider.cookie)).status,404)
  const profile=await api('/api/player/profile',undefined,ga.cookie);assert.equal(profile.data.stats.judged,1);assert.equal(profile.data.stats.accuracy,100);assert.ok(profile.data.badges.find(badge=>badge.code==='first_judgment').unlockedAt)
  checks.push('private complete history, accurate results and real first-judgment achievement')
  assert.equal((await api('/api/player/feedback',{matchId:first.id,tags:['natural','formal']},ga.cookie)).status,400)
  assert.equal((await api('/api/player/feedback',{matchId:first.id,tags:['formal','too_fast']},ga.cookie)).status,200)
  assert.equal((await api('/api/player/feedback',{matchId:first.id,tags:['natural']},ga.cookie)).status,200)
  assert.deepEqual((await api(`/api/player/history/${first.id}`,undefined,ga.cookie)).data.feedback,['natural'])
  assert.equal((await api('/api/player/feedback',{matchId:first.id,tags:['natural']},outsider.cookie)).status,404)
  assert.equal((await api('/api/player/feedback',{matchId:first.id,tags:['natural']},ga.cookie,undefined,'https://evil.invalid')).status,403)
  checks.push('validated, updateable feedback, ownership enforcement and same-origin writes')
  const admin=await api('/admin/api/login',{password:'local-qa-features'});assert.equal(admin.status,200)
  assert.equal((await api('/admin/api/community',undefined,ga.cookie)).status,401)
  await api('/api/player/training-consent',{matchId:first.id,consent:true},ga.cookie)
  assert.ok(!(await api('/admin/api/community',undefined,admin.cookie)).data.samples.some(sample=>sample.match_id===first.id))
  await api('/api/player/training-consent',{matchId:first.id,consent:true},gb.cookie)
  const community=(await api('/admin/api/community',undefined,admin.cookie)).data
  assert.equal(community.samples.find(sample=>sample.match_id===first.id).status,'pending')
  let exported=await api('/admin/api/training/export',undefined,admin.cookie);assert.ok(!String(exported.data).includes(`feature_${suffix}`))
  assert.equal((await api(`/admin/api/training/${first.id}`,{status:'approved'},admin.cookie,'PATCH')).status,200)
  exported=await api('/admin/api/training/export',undefined,admin.cookie);const lines=String(exported.data).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.ok(lines.some(line=>JSON.stringify(line).includes(`feature_${suffix}`)));assert.ok(!String(exported.data).includes(ga.data.player.id))
  await api('/api/player/training-consent',{matchId:first.id,consent:false},gb.cookie)
  assert.ok(!String((await api('/admin/api/training/export',undefined,admin.cookie)).data).includes(`feature_${suffix}`))
  checks.push('both-party raw-text consent, pending moderation, authenticated JSONL export and effective withdrawal')
  const report=await api('/api/player/report',{matchId:first.id,reason:'spam',description:'本地举报验证'},ga.cookie);assert.equal(report.status,200)
  assert.equal((await api('/api/player/report',{matchId:first.id,reason:'spam'},ga.cookie)).data.duplicate,true)
  const reported=(await api('/admin/api/community',undefined,admin.cookie)).data.reports.find(item=>item.match_id===first.id)
  assert.equal(reported.status,'pending');assert.equal((await api(`/admin/api/reports/${reported.id}`,{status:'resolved'},ga.cookie,'PATCH')).status,401)
  assert.equal((await api(`/admin/api/reports/${reported.id}`,{status:'resolved'},admin.cookie,'PATCH')).status,200)
  checks.push('idempotent reporting, admin-only review queue and auditable resolution')
  a.send('match:join',{styleOptIn:false});let next=await a.next('match:found');a.send('match:skip',{matchId:next.id,styleOptIn:false})
  const skipped=await a.next('match:revealed');assert.equal(skipped.endReason,'skipped');assert.equal(skipped.correct,null);next=await a.next('match:found');assert.notEqual(next.id,skipped.id)
  assert.equal((await api('/api/player/report',{matchId:next.id,reason:'harassment'},ga.cookie)).status,200)
  const ended=await a.next('match:revealed');assert.equal(ended.endReason,'reported');assert.equal(ended.correct,null)
  assert.equal((await api('/api/player/profile',undefined,ga.cookie)).data.stats.judged,1)
  checks.push('skip creates a replacement room, active report ends safely and neither counts as a loss')
  const registered=await api('/api/auth/register',{username:`features_${suffix}`,password:'feature-local-only-password'},ga.cookie);assert.equal(registered.status,201);assert.equal(registered.data.player.id,ga.data.player.id)
  assert.equal((await api(`/api/player/history/${first.id}`,undefined,registered.cookie)).status,200)
  const login=await api('/api/auth/login',{username:`features_${suffix}`,password:'feature-local-only-password'});assert.equal((await api('/api/player/profile',undefined,login.cookie)).data.stats.judged,1)
  checks.push('guest registration and another-device login preserve history, results and badges')
  console.log(JSON.stringify({passed:checks.length,checks}))
} finally {for(const socket of sockets)socket.terminate()}
