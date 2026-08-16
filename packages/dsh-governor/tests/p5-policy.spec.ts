/**
 * P5 adapter tests: the capability router — profile tool sets (PLAN 3.4),
 * the safe allow-list resolution (unknown names filtered before restrict),
 * and the always-available core.
 */
import { describe, expect, it } from 'vitest'
import { CORE_TOOL_NAMES, PROFILE_TOOL_NAMES, resolveToolRestriction } from '../src/index.ts'

describe('CORE_TOOL_NAMES (always available)', () => {
  it('is the stable core set of PLAN 3.4', () => {
    expect(CORE_TOOL_NAMES).toEqual(['read', 'write', 'edit', 'bash', 'todo_write'])
  })
})

describe('PROFILE_TOOL_NAMES', () => {
  it('coding = core + search/editor/delegation instruments', () => {
    expect(PROFILE_TOOL_NAMES.coding).toEqual([
      ...CORE_TOOL_NAMES,
      'grep',
      'glob',
      'str_replace_editor',
      'subagent',
      'workflow',
    ])
  })

  it('research = core + web tools', () => {
    expect(PROFILE_TOOL_NAMES.research).toEqual([...CORE_TOOL_NAMES, 'web_search', 'web_fetch'])
  })

  it('minimal is exactly the core', () => {
    expect(PROFILE_TOOL_NAMES.minimal).toEqual(CORE_TOOL_NAMES)
  })

  it('every profile keeps the core tool set', () => {
    for (const profile of ['coding', 'research', 'minimal'] as const) {
      for (const core of CORE_TOOL_NAMES) {
        expect(PROFILE_TOOL_NAMES[profile]).toContain(core)
      }
    }
  })
})

describe('resolveToolRestriction', () => {
  it('restricts to the profile names actually registered', () => {
    expect(resolveToolRestriction('coding', ['read', 'bash', 'grep', 'subagent']))
      .toEqual({ allow: ['read', 'bash', 'grep', 'subagent'] })
  })

  it('unknown profile names are filtered before restrict (which fails loudly on them)', () => {
    // `subagent` is not registered at application time → left out of allow.
    expect(resolveToolRestriction('coding', CORE_TOOL_NAMES))
      .toEqual({ allow: CORE_TOOL_NAMES })
  })

  it('is undefined when nothing of the profile is present (no restriction)', () => {
    expect(resolveToolRestriction('coding', [])).toBeUndefined()
    expect(resolveToolRestriction('minimal', ['other_tool'])).toBeUndefined()
  })

  it('research surfaces the web instruments', () => {
    expect(resolveToolRestriction('research', ['read', 'web_search', 'web_fetch']))
      .toEqual({ allow: ['read', 'web_search', 'web_fetch'] })
  })
})
