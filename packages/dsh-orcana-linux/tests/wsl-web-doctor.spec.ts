import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  WSL_WEB_RELAY_SERVER_SCRIPT,
  buildWslWebRelayProbeArgs,
} from '../src/wsl-web-doctor.ts'

async function readPort(child: ReturnType<typeof spawn>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('relay server did not publish a port')), 2_000)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      resolve(Number(buffer.slice(0, newline).trim()))
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function readToken(port: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const socket = createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('relay token timed out'))
    }, 2_000)
    socket.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('end', () => {
      clearTimeout(timer)
      resolve(buffer.trim())
    })
  })
}

describe('WSL Web localhost relay probe contract', () => {
  it('builds a loopback-only Node server in the selected distro', () => {
    const token = 'a'.repeat(32)
    const args = buildWslWebRelayProbeArgs(token, 'Ubuntu-24.04')
    expect(args.slice(0, 5)).toEqual([
      '--distribution', 'Ubuntu-24.04', '--exec', 'node', '-e',
    ])
    expect(args.at(-1)).toBe(token)
    expect(WSL_WEB_RELAY_SERVER_SCRIPT).toContain('server.listen(0,"127.0.0.1"')
    expect(WSL_WEB_RELAY_SERVER_SCRIPT).not.toContain('0.0.0.0')
  })

  it.skipIf(process.platform === 'win32')('serves one token on loopback and exits cleanly', async () => {
    const token = 'b'.repeat(32)
    const child = spawn(process.execPath, ['-e', WSL_WEB_RELAY_SERVER_SCRIPT, token], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const port = await readPort(child)
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
    expect(await readToken(port)).toBe(token)

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    expect(result).toEqual({ code: 0, signal: null })
  }, 5_000)
})
