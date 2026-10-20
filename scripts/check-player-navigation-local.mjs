// Local-only integration coverage for guest upgrades and account-seat conflicts.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const WebSocket = require(require.resolve('ws', { paths: [fileURLToPath(new URL('../server', import.meta.url))] }))
const base = 'http://localhost:8787'
const suffix = Date.now().toString(36)
const password = 'navigation-local-only-password'
const sockets = []
const checks = []
async function api(mode, body, cookie) {
  const response = await fetch(`${base}/api/auth/${mode}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'CF-Connecting-IP': `navigation-${suffix}`, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, player: (await response.json()).player, cookie: response.headers.get('Set-Cookie')?.split(';')[0] }
}
function connect(cookie) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Origin: base, Cookie: cookie } })
  sockets.push(socket)
  const queue = [], pending = []
  socket.on('message', raw => {
    const envelope = JSON.parse(String(raw)), index = pending.findIndex(item => item.type === envelope.type)
    if (index < 0) queue.push(envelope)
    else { const [item] = pending.splice(index, 1); clearTimeout(item.timer); item.resolve(envelope.payload) }
  })
  socket.on('error', () => {})
  return { socket, send: (type, payload = {}) => socket.send(JSON.stringify({ type, payload })), next(type) {
    const index = queue.findIndex(item => item.type === type)
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0].payload)
    return new Promise((resolve, reject) => {
      const item = { type, resolve, timer: setTimeout(() => { pending.splice(pending.indexOf(item), 1); reject(new Error(`Timeout ${type}`)) }, 12000) }
      pending.push(item)
    })
  } }
}
try {
  const guest = await api('guest', {})
  const first = connect(guest.cookie), ready = await first.next('player:ready')
  first.send('match:join', { styleOptIn: false })
  await first.next('match:searching')
  const closed = new Promise(resolve => first.socket.once('close', code => resolve(code)))
  const upgraded = await api('register', { username: `nav_${suffix}`, password }, guest.cookie)
  assert.equal(upgraded.status, 201)
  assert.equal(upgraded.player.kind, 'account')
  assert.equal(upgraded.player.id, guest.player.id)
  assert.equal(await closed, 4001)
  assert.equal((await api('session', undefined, guest.cookie)).player, null)
  const continued = connect(upgraded.cookie)
  assert.equal((await continued.next('player:ready')).codename, ready.codename)
  await continued.next('match:searching')
  const match = await continued.next('match:found')
  checks.push('registration preserves guest seat, codename and queue; old token is revoked')
  continued.send('message:send', { content: '本地身份升级后的消息' })
  await continued.next('message:accepted')
  const otherDevice = await api('login', { username: `nav_${suffix}`, password })
  assert.equal(otherDevice.player.id, guest.player.id)
  const resumed = connect(otherDevice.cookie)
  await resumed.next('player:ready')
  const restored = await resumed.next('match:found')
  assert.equal(restored.id, match.id)
  assert.equal(restored.messages[0].content, '本地身份升级后的消息')
  checks.push('another device login resumes upgraded account conversation and messages')

  const guestB = await api('guest', {})
  const second = connect(guestB.cookie)
  await second.next('player:ready')
  second.send('match:join', { styleOptIn: false })
  const secondMatch = await second.next('match:found')
  assert.notEqual(secondMatch.id, match.id)
  const conflict = await api('login', { username: `nav_${suffix}`, password }, guestB.cookie)
  assert.equal(conflict.status, 409)
  assert.equal((await api('session', undefined, guestB.cookie)).player.id, guestB.player.id)
  assert.equal(second.socket.readyState, WebSocket.OPEN)
  checks.push('two ongoing conversations reject login without replacing either guest or account seat')

  const idleGuest = await api('guest', {})
  const resumedAccount = await api('login', { username: `nav_${suffix}`, password }, idleGuest.cookie)
  assert.equal(resumedAccount.status, 200)
  assert.equal(resumedAccount.player.id, upgraded.player.id)
  checks.push('idle guest can log in and resume the existing active account conversation')

  const idleAccount = await api('register', { username: `idle_${suffix}`, password })
  const idleSocket = connect(idleAccount.cookie)
  await idleSocket.next('player:ready')
  const idleClosed = new Promise(resolve => idleSocket.socket.once('close', code => resolve(code)))
  const adopted = await api('login', { username: `idle_${suffix}`, password }, guestB.cookie)
  assert.equal(adopted.status, 200)
  assert.equal(adopted.player.id, guestB.player.id)
  assert.equal(await idleClosed, 4001)
  assert.equal((await api('session', undefined, idleAccount.cookie)).player.id, guestB.player.id)
  const adoptedSocket = connect(adopted.cookie)
  await adoptedSocket.next('player:ready')
  assert.equal((await adoptedSocket.next('match:found')).id, secondMatch.id)
  checks.push('idle account adopts guest conversation; existing account devices are securely relocated')
  console.log(JSON.stringify({ passed: checks.length, checks }))
} finally { for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close() }
