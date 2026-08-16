/**
 * Money formatting for a fictional invoicing widget.
 * Official fix (Gate C): negative amounts keep their sign on the dollar.
 */
export function formatMoney(amount) {
  const cents = Math.round(amount * 100)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
