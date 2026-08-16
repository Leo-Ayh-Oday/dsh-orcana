import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMoney } from '../src/format.js'

test('formats positive integer amounts', () => {
  assert.equal(formatMoney(5), '$5.00')
  assert.equal(formatMoney(0), '$0.00')
})

test('formats positive decimal amounts', () => {
  assert.equal(formatMoney(1.5), '$1.50')
  assert.equal(formatMoney(0.05), '$0.05')
})
