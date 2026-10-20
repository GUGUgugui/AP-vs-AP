import test from 'node:test'
import assert from 'node:assert/strict'
import { constantTimeEqual, digestToken, hashPassword, normalizeUsername, playerCookie, validPassword, verifyPassword } from '../cloudflare/player-auth.ts'

test('usernames normalize without accepting whitespace, Unicode impersonation or SQL syntax', () => {
  assert.deepEqual(normalizeUsername('  Player_1  '), { username: 'Player_1', key: 'player_1' })
  for (const value of ['ab', 'a'.repeat(25), '汉字玩家', "a';--", 'a b', null, {}, 42]) assert.equal(normalizeUsername(value), null)
})

test('passwords allow long phrases and Unicode but enforce safe input limits', () => {
  assert.equal(validPassword('a'.repeat(10)), true)
  assert.equal(validPassword('一句话也能成为好密码多写一点'), true)
  for (const value of ['short', 'a'.repeat(129), '😀'.repeat(5), null, {}]) assert.equal(validPassword(value), false)
})

test('password hashes use independent salts, verify correctly and require the separate pepper secret', async () => {
  const password = 'test-only-long-password'
  const secret = 'test-only-player-pepper'
  const first = await hashPassword(password, secret)
  const second = await hashPassword(password, secret)
  assert.notEqual(first, second)
  assert.equal(first.includes(password), false)
  assert.equal(first.includes(secret), false)
  assert.equal(await verifyPassword(password, first, secret), true)
  assert.equal(await verifyPassword('wrong-password', first, secret), false)
  assert.equal(await verifyPassword(password, first, 'wrong-pepper'), false)
  assert.equal(await verifyPassword(password, 'bad hash', secret), false)
})

test('session cookies are host-only HttpOnly and secure in production; token digests hide the bearer', async () => {
  const prod = playerCookie(new Request('https://example.com/'), 'a'.repeat(64))
  assert.match(prod, /^__Host-apvsap_player=/)
  for (const attribute of ['HttpOnly', '; Secure', 'SameSite=Strict', 'Path=/']) assert.ok(prod.includes(attribute))
  assert.equal(prod.includes('Domain='), false)
  assert.match(playerCookie(new Request('http://localhost:8787/'), null), /Max-Age=0/)
  const digest = await digestToken('token')
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.notEqual(digest, 'token')
  assert.equal(constantTimeEqual('abc', 'abc'), true)
  assert.equal(constantTimeEqual('abc', 'abcd'), false)
  assert.equal(constantTimeEqual('abc', 'abd'), false)
})
