// Keep the opaque game seat separate from account identity. A guest can claim
// their own seat without rewriting messages, guesses, AI jobs or queued alarms.
export function chooseAccountSeat(input: {
  accountSeat: string
  guestSeat: string | null
  accountBusy: boolean
  guestBusy: boolean
  guestOwnedByAnotherAccount: boolean
}): string | null {
  if (!input.guestSeat || input.guestSeat === input.accountSeat) return input.accountSeat
  if (input.guestOwnedByAnotherAccount || (input.accountBusy && input.guestBusy)) return null
  return input.accountBusy ? input.accountSeat : input.guestSeat
}
