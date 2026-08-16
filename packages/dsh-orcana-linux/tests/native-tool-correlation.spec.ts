import { describe, expect, it } from 'vitest'
import type { ToolDispatchExecution } from '@deepseek-ai/dsh-tools'
import {
  correlationFromToolExecution,
  currentNativeToolCorrelation,
  runWithNativeToolCorrelation,
  type NativeToolCorrelation,
} from '../src/native-tool-correlation.ts'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function correlation(id: string): NativeToolCorrelation {
  return {
    sessionId: `session-${id}`,
    callId: `call-${id}`,
    rootCallId: `root-${id}`,
    toolName: 'bash',
  }
}

describe('native ToolRuntime correlation', () => {
  it('copies stable tool/session identity without retaining the Agent object', () => {
    const agent = { id: 'session-1' }
    const exec = {
      callId: 'call-1',
      rootCallId: 'root-1',
      name: 'bash',
      agent,
    } as unknown as Pick<ToolDispatchExecution, 'callId' | 'rootCallId' | 'name' | 'agent'>

    const result = correlationFromToolExecution(exec)
    expect(result).toEqual({
      sessionId: 'session-1',
      callId: 'call-1',
      rootCallId: 'root-1',
      toolName: 'bash',
    })
    expect('agent' in result).toBe(false)
  })

  it('keeps two concurrent Agent/tool chains isolated across awaits', async () => {
    const seen: Array<NativeToolCorrelation | undefined> = []
    await Promise.all([
      runWithNativeToolCorrelation(correlation('a'), async () => {
        await wait(20)
        seen.push(currentNativeToolCorrelation())
        await wait(5)
        expect(currentNativeToolCorrelation()).toEqual(correlation('a'))
      }),
      runWithNativeToolCorrelation(correlation('b'), async () => {
        await wait(5)
        seen.push(currentNativeToolCorrelation())
        await wait(25)
        expect(currentNativeToolCorrelation()).toEqual(correlation('b'))
      }),
    ])

    expect(seen).toHaveLength(2)
    expect(seen).toContainEqual(correlation('a'))
    expect(seen).toContainEqual(correlation('b'))
    expect(currentNativeToolCorrelation()).toBeUndefined()
  })

  it('shadows nested Code-Mode style dispatch and restores the root call context', async () => {
    const outer = correlation('outer')
    const inner = { ...correlation('inner'), rootCallId: outer.rootCallId, toolName: 'read' }

    await runWithNativeToolCorrelation(outer, async () => {
      expect(currentNativeToolCorrelation()).toEqual(outer)
      await runWithNativeToolCorrelation(inner, async () => {
        expect(currentNativeToolCorrelation()).toEqual(inner)
      })
      expect(currentNativeToolCorrelation()).toEqual(outer)
    })
    expect(currentNativeToolCorrelation()).toBeUndefined()
  })

  it('represents direct/agentless dispatch without inventing a session id', () => {
    const exec = {
      callId: 'call-direct',
      rootCallId: 'call-direct',
      name: 'bash',
      agent: undefined,
    } as unknown as Pick<ToolDispatchExecution, 'callId' | 'rootCallId' | 'name' | 'agent'>

    expect(correlationFromToolExecution(exec)).toEqual({
      callId: 'call-direct',
      rootCallId: 'call-direct',
      toolName: 'bash',
    })
  })
})
