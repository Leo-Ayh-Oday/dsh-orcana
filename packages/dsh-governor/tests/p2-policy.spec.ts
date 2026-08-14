/**
 * P2 adapter tests: the governor steering policy (pure function) — threshold
 * hits, mode gating, the forced-continuation cap, and the tiered text.
 */
import { describe, expect, it } from 'vitest'
import {
  GENTLE_TURN_REMINDER,
  REEVALUATE_TURN_REMINDER,
} from '@orcana/governor-core'
import type { TurnVerdict } from '@orcana/governor-core'
import { decideSteer } from '../src/index.ts'

const CONFIG = {
  enabled: true,
  mode: 'warn-steer' as const,
  thresholds: [2, 3, 4],
  maxForced: 3,
}

function verdict(zeroProgress: boolean, chainLength: number, repeatedPattern?: { tool: string; canonicalArgs: string }): TurnVerdict {
  return { zeroProgress, chainLength, repeatedPattern }
}

describe('decideSteer', () => {
  it('steers at each threshold with the tiered text', () => {
    expect(decideSteer(verdict(true, 2), CONFIG, 0)).toMatchObject({ action: 'steer', text: GENTLE_TURN_REMINDER })
    expect(decideSteer(verdict(true, 3), CONFIG, 0)).toMatchObject({ action: 'steer', text: REEVALUATE_TURN_REMINDER })
    expect(decideSteer(verdict(true, 4), CONFIG, 0).action).toBe('steer')
  })

  it('the strong steer names the repeated pattern', () => {
    const decision = decideSteer(verdict(true, 4, { tool: 'read', canonicalArgs: '{"path":"a"}' }), CONFIG, 0)
    expect(decision.text).toContain('Repeated pattern: read {"path":"a"}')
  })

  it('passes on progress rounds and on chain lengths outside the thresholds', () => {
    expect(decideSteer(verdict(false, 0), CONFIG, 0)).toEqual({ action: 'pass', text: undefined, chainLength: 0 })
    expect(decideSteer(verdict(true, 1), CONFIG, 0)).toMatchObject({ action: 'pass' })
    expect(decideSteer(verdict(true, 5), CONFIG, 0)).toMatchObject({ action: 'pass' })
  })

  it('passes when disabled or in observe mode', () => {
    expect(decideSteer(verdict(true, 2), { ...CONFIG, enabled: false }, 0)).toMatchObject({ action: 'pass' })
    expect(decideSteer(verdict(true, 2), { ...CONFIG, mode: 'observe' }, 0)).toMatchObject({ action: 'pass' })
  })

  it('the forced-continuation cap bounds steering', () => {
    expect(decideSteer(verdict(true, 2), CONFIG, 3)).toMatchObject({ action: 'pass' })
    expect(decideSteer(verdict(true, 2), CONFIG, 2)).toMatchObject({ action: 'steer' })
    expect(decideSteer(verdict(true, 4), CONFIG, 2)).toMatchObject({ action: 'steer' })
  })
})
