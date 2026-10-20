export type IdentityGuess = 'human' | 'ai'

export const MIN_MESSAGES_BEFORE_GUESS = 3

export function canPlayerGuess(messages: readonly { authorId: string; source: string }[], playerId: string): boolean {
  return messages.filter((message) => message.authorId === playerId && message.source === 'human').length >= MIN_MESSAGES_BEFORE_GUESS
}

export function parseIdentityGuess(value: unknown): IdentityGuess | null {
  return value === 'human' || value === 'ai' ? value : null
}

// Preserve existing Durable Object state and historical records during rollout.
export function readIdentityGuess(state?: { guess?: unknown; humanProbability?: unknown }): IdentityGuess | null {
  if (!state) return null
  if (Object.hasOwn(state, 'guess')) return parseIdentityGuess(state.guess)
  const value = state.humanProbability
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || value === 50) return null
  return value > 50 ? 'human' : 'ai'
}

export function guessFromPayload(payload: Record<string, unknown>): IdentityGuess | null {
  return readIdentityGuess(payload)
}

// D1's existing column remains for backward compatibility; new entries are
// binary codes only (100=human, 0=ai, 50=unanswered), not confidence ratings.
export function legacyGuessValue(guess: IdentityGuess | null): number {
  return guess === 'human' ? 100 : guess === 'ai' ? 0 : 50
}
