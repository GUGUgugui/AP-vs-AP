import test from 'node:test'
import assert from 'node:assert/strict'
import { canPlayerGuess, MIN_MESSAGES_BEFORE_GUESS, guessFromPayload, legacyGuessValue, parseIdentityGuess, readIdentityGuess } from '../cloudflare/identity-guess.ts'

test('new choices accept only human or ai, and explicit invalid input cannot fall back', () => {
  assert.equal(parseIdentityGuess('human'), 'human')
  assert.equal(parseIdentityGuess('ai'), 'ai')
  for (const value of [null, undefined, 0, 100, 'bot', '', true, {}]) assert.equal(parseIdentityGuess(value), null)
  assert.equal(guessFromPayload({ guess: 'human' }), 'human')
  assert.equal(guessFromPayload({ guess: 'ai' }), 'ai')
  assert.equal(guessFromPayload({}), null)
  assert.equal(guessFromPayload({ guess: null, humanProbability: 100 }), null)
  assert.equal(guessFromPayload({ guess: 'bot', humanProbability: 100 }), null)
})

test('old probabilities preserve existing choices without assigning neutral or malformed records', () => {
  assert.equal(readIdentityGuess({ humanProbability: 85 }), 'human')
  assert.equal(readIdentityGuess({ humanProbability: 15 }), 'ai')
  for (const value of [50, -1, 101, NaN, Infinity, '85', null, undefined]) {
    assert.equal(readIdentityGuess({ humanProbability: value }), null)
  }
  assert.equal(readIdentityGuess(), null)
})

test('new archive codes represent only binary choices or unanswered', () => {
  for (const choice of ['human', 'ai', null]) {
    assert.equal(readIdentityGuess({ humanProbability: legacyGuessValue(choice) }), choice)
  }
  assert.equal(legacyGuessValue('human'), 100)
  assert.equal(legacyGuessValue('ai'), 0)
  assert.equal(legacyGuessValue(null), 50)
})

test('only three accepted human messages by this player unlock a verdict', () => {
  assert.equal(MIN_MESSAGES_BEFORE_GUESS, 3)
  const messages = [
    { authorId: 'other', source: 'human' }, { authorId: 'p1', source: 'admin' }, { authorId: 'p1', source: 'ai' },
  ]
  for (let count = 0; count < 3; count++) {
    assert.equal(canPlayerGuess(messages, 'p1'), false)
    messages.push({ authorId: 'p1', source: 'human' })
  }
  assert.equal(canPlayerGuess(messages, 'p1'), true)
})
