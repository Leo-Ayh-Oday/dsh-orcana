// Hidden reproducer for dayjs issue #1118 (PR #3012): updateLocale with a
// partial nested object must MERGE into the existing object, not replace it
// — keys not mentioned in the update (formats.LT here) must survive.
// Runs against the built artifacts (dayjs.min.js + plugin/updateLocale.js),
// which is exactly what the agent must keep in sync after editing src.
const dayjs = require('./dayjs.min.js')
const updateLocale = require('./plugin/updateLocale.js')

dayjs.extend(updateLocale)

// 1) Seed a locale with formats.LT, then 2) partially update formats.L.
dayjs.updateLocale('en', { formats: { LT: '[testFormat]' } })
dayjs.updateLocale('en', { formats: { L: 'DD/MM/YYYY' } })

const formats = dayjs.Ls.en.formats
let failed = 0
const check = (name, actual, expected) => {
  if (actual !== expected) {
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    failed += 1
  } else {
    console.log(`ok ${name}`)
  }
}
check('formats.L updated', formats.L, 'DD/MM/YYYY')
check('formats.LT preserved', formats.LT, '[testFormat]')
check('formats has both keys', Object.keys(formats).length, 2)

process.exit(failed === 0 ? 0 : 1)
