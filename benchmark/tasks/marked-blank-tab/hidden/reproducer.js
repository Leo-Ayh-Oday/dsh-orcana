// Hidden reproducer for marked issue #4007: a line of only tabs (or tabs +
// spaces) must terminate a paragraph under gfm: false — base joins the lines
// into a single paragraph, the official fix splits them.
import { marked } from './lib/marked.esm.js'

const cases = [
  ['foo\n\t\nbar', '<p>foo</p>\n<p>bar</p>\n'],
  ['a\n\t\nb\n\t\nc', '<p>a</p>\n<p>b</p>\n<p>c</p>\n'],
  ['foo\n  \t  \nbar', '<p>foo</p>\n<p>bar</p>\n'],
]

let failed = 0
for (const [input, expected] of cases) {
  const actual = marked(input, { gfm: false })
  if (actual !== expected) {
    console.error(`FAIL input=${JSON.stringify(input)}:`)
    console.error(`  expected ${JSON.stringify(expected)}`)
    console.error(`  actual   ${JSON.stringify(actual)}`)
    failed += 1
  } else {
    console.log(`ok ${JSON.stringify(input)}`)
  }
}
process.exit(failed === 0 ? 0 : 1)
