import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseAccountSeat } from '../cloudflare/account-seat.ts'
const defaults = { accountSeat: 'account-seat', guestSeat: 'guest-seat', accountBusy: false, guestBusy: false, guestOwnedByAnotherAccount: false }
test('guest upgrades keep the same game seat without rewriting their conversation', () => {
  assert.equal(chooseAccountSeat(defaults), 'guest-seat')
  assert.equal(chooseAccountSeat({ ...defaults, guestBusy: true }), 'guest-seat')
})
test('account-only login and reconnect resolve the account seat', () => {
  assert.equal(chooseAccountSeat({ ...defaults, guestSeat: null }), 'account-seat')
  assert.equal(chooseAccountSeat({ ...defaults, guestSeat: 'account-seat', accountBusy: true, guestBusy: true }), 'account-seat')
})
test('an idle guest resumes an existing account conversation but two busy seats cannot merge', () => {
  assert.equal(chooseAccountSeat({ ...defaults, accountBusy: true }), 'account-seat')
  assert.equal(chooseAccountSeat({ ...defaults, accountBusy: true, guestBusy: true }), null)
})
test('one guest seat cannot be claimed by a second account', () => {
  assert.equal(chooseAccountSeat({ ...defaults, guestOwnedByAnotherAccount: true }), null)
})
