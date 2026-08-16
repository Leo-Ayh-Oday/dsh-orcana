/**
 * Hidden reproducer (Gate B): the negative-amount path the existing suite
 * never exercises. Base implementation drops the sign via Math.floor toward
 * negative infinity: formatMoney(-1.5) → '$-2.50' instead of '-$1.50'.
 */
import { formatMoney } from './src/format.js'

const cases = [
  [-1.5, '-$1.50'],
  [-0.05, '-$0.05'],
]

let failed = 0
for (const [amount, expected] of cases) {
  const actual = formatMoney(amount)
  if (actual !== expected) {
    console.error(`FAIL formatMoney(${amount}): expected ${expected}, got ${actual}`)
    failed += 1
  } else {
    console.log(`ok formatMoney(${amount}) → ${actual}`)
  }
}
process.exit(failed === 0 ? 0 : 1)
