/**
 * Money formatting for a fictional invoicing widget.
 * Existing suite covers positive amounts only.
 */
export function formatMoney(amount) {
  if (Number.isInteger(amount)) {
    return `$${amount}.00`
  }
  const cents = Math.round(amount * 100)
  return `$${Math.floor(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`
}
