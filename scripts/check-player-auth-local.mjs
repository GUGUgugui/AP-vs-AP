// Integration smoke against the local Worker only; never creates production users.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const WebSocket = require(require.resolve('ws', { paths: [fileURLToPath(new URL('../server', import.meta.url))] }))
const base = 'http://localhost:8787'
const username = `qa_${Date.now().toString(36)}`
const password = 'qa-only-independent-password'
const results = []
const sockets = []

async function api(path, body, cookie, origin = base, ip = 'local-auth-integration') {
  const response = await fetch(`${base}/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json()
  return { status: response.status, payload, cookie: response.headers.get('Set-Cookie')?.split(';')[0], setCookie: response.headers.get('Set-Cookie') }
}

function connect(cookie, claimedId = 'spoofed-browser-id') {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?sessionId=${claimedId}`, { headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) } })
  sockets.push(socket)
  const queue = []
  const pending = []
  socket.on('message', (raw) => {
    const envelope = JSON.parse(String(raw))
    const index = pending.findIndex((entry) => entry.type === envelope.type)
    if (index >= 0) { const [entry] = pending.splice(index, 1); clearTimeout(entry.timer); entry.resolve(envelope.payload) }
    else queue.push(envelope)
  })
  socket.on('error', () => {})
  return {
    socket,
    send: (type, payload = {}) => socket.send(JSON.stringify({ type, payload })),
    next(type) {
      const index = queue.findIndex((entry) => entry.type === type)
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0].payload)
      return new Promise((resolve, reject) => {
        const entry = { type, resolve, timer: setTimeout(() => { pending.splice(pending.indexOf(entry), 1); reject(new Error(`Timeout ${type}`)) }, 12000) }
        pending.push(entry)
      })
    },
  }
}

try {
  assert.equal((await api('session')).payload.player, null)
  assert.equal((await api('register', { username, password }, undefined, 'https://foreign.invalid')).status, 403)
  assert.equal((await api('register', { username, password: 'short' })).status, 400)
  results.push('session defaults empty; cross-origin and short-password registration rejected')
  const registered = await api('register', { username, password })
  assert.equal(registered.status, 201)
  assert.equal(registered.payload.player.kind, 'account')
  assert.ok(registered.setCookie.includes('HttpOnly'))
  assert.ok(registered.setCookie.includes('SameSite=Strict'))
  assert.equal((await api('register', { username: username.toUpperCase(), password })).status, 409)
  results.push('registration, secure cookie attributes and case-insensitive uniqueness')
  const wrong = await api('login', { username, password: 'wrong-long-password' })
  const unknown = await api('login', { username: `${username}x`, password })
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401)
  assert.equal(wrong.payload.error, unknown.payload.error)
  const loggedIn = await api('login', { username: username.toUpperCase(), password })
  assert.equal(loggedIn.status, 200)
  assert.equal(loggedIn.payload.player.id, registered.payload.player.id)
  assert.notEqual(loggedIn.payload.player.sessionKey, registered.payload.player.sessionKey)
  results.push('login, stable account identity, token rotation and generic credential errors')

  const noAuth = connect()
  assert.equal(await new Promise((resolve) => noAuth.socket.on('unexpected-response', (_request, response) => { response.resume(); noAuth.socket.terminate(); resolve(response.statusCode) })), 401)
  const client = connect(loggedIn.cookie)
  const ready = await client.next('player:ready')
  client.send('match:join', { styleOptIn: false })
  const found = await client.next('match:found')
  assert.equal(found.minimumMessages, 3)
  assert.equal(found.guess, null)
  assert.equal(Object.hasOwn(found, 'truth'), false)
  const spoof = connect(loggedIn.cookie, 'another-player-session')
  assert.equal((await spoof.next('player:ready')).codename, ready.codename)
  assert.equal((await spoof.next('match:found')).id, found.id)
  results.push('WebSocket rejects anonymous spoofing and ignores browser-claimed player IDs')
  for (let count = 0; count < 3; count++) {
    client.send('guess:update', { guess: 'ai' })
    assert.ok((await client.next('error:message')).message.includes('3 条消息'))
    client.send('match:reveal', { guess: 'ai' })
    assert.ok((await client.next('error:message')).message.includes('3 条消息'))
    client.send('message:send', { content: `本地测试消息 ${count + 1}` })
    await client.next('message:accepted')
    // No API key exists in this local fixture. The provider is never called.
    assert.ok((await client.next('error:message')).message.includes('对话暂时中断'))
    await client.next('opponent:typing')
  }
  client.send('guess:update', { guess: 'ai' })
  assert.equal((await client.next('guess:updated')).guess, 'ai')
  client.send('match:reveal', { guess: 'ai' })
  const revealed = await client.next('match:revealed')
  assert.equal(revealed.truth, 'ai'); assert.equal(revealed.correct, true)
  results.push('server enforces the three-message threshold, then permits binary judgment')

  const closed = new Promise((resolve) => client.socket.once('close', (code) => resolve(code)))
  assert.equal((await api('logout', {}, loggedIn.cookie)).status, 200)
  assert.equal(await closed, 4001)
  assert.equal((await api('session', undefined, loggedIn.cookie)).payload.player, null)
  results.push('logout revokes the old session and already-open WebSocket')
  const guest = await api('guest', {})
  assert.equal(guest.payload.player.kind, 'guest')
  assert.equal((await api('session', undefined, guest.cookie)).payload.player.id, guest.payload.player.id)
  assert.equal((await api('guest', {}, guest.cookie)).payload.player.id, guest.payload.player.id)
  await api('logout', {}, guest.cookie)
  results.push('guest access, refresh persistence and idempotent guest selection')

  for (let count = 0; count < 7; count++) {
    const attempt = await api('register', { username: 'bad name', password }, undefined, base, 'local-rate-limit-fixture')
    assert.equal(attempt.status, count < 6 ? 400 : 429)
  }
  results.push('registration rate limiting')
  console.log(JSON.stringify({ passed: results.length, checks: results }))
} finally {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close()
}
