import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { hostCwdForWslSpawn } from './wsl-bridge.js'

const RELAY_SERVER_SCRIPT = [
  'const net=require("node:net")',
  'const token=process.argv[1]',
  'if(!token||!/^[a-f0-9]+$/.test(token))process.exit(64)',
  'let served=false',
  'const server=net.createServer(socket=>{served=true;socket.end(token+"\\n");server.close()})',
  'server.on("error",error=>{console.error(error&&error.message?error.message:String(error));process.exitCode=2})',
  'server.listen(0,"127.0.0.1",()=>{const address=server.address();if(!address||typeof address==="string")process.exit(65);process.stdout.write(String(address.port)+"\\n")})',
  'const timer=setTimeout(()=>{server.close();if(!served)process.exitCode=3},5000)',
  'timer.unref()',
].join(';')

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function buildWslWebRelayProbeArgs(token: string, distro?: string): string[] {
  return [
    ...distroPrefix(distro),
    '--exec', 'node', '-e', RELAY_SERVER_SCRIPT, token,
  ]
}

async function waitForPort(child: ReturnType<typeof spawn>): Promise<number | undefined> {
  return await new Promise<number | undefined>((resolve) => {
    let buffer = ''
    let settled = false
    const finish = (port?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(port)
    }
    const timer = setTimeout(() => finish(), 2500)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const value = Number(buffer.slice(0, newline).trim())
      finish(Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined)
    })
    child.once('error', () => finish())
    child.once('close', () => finish())
  })
}

async function hostReceivesToken(port: number, token: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false
    let buffer = ''
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1800)
    socket.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
      if (buffer.includes('\n')) finish(buffer.trim() === token)
    })
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(buffer.trim() === token))
  })
}

async function reapRelayProbe(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      // This process exists only for a localhost doctor probe. If its own
      // five-second lease failed to close it, terminating wsl.exe is safer than
      // leaving an unowned diagnostics process behind.
      try { child.kill() } catch { /* already gone */ }
      finish()
    }, 6000)
    child.once('close', finish)
    child.once('error', finish)
  })
}

/**
 * Prove that a service bound to WSL 127.0.0.1 is reachable through Windows
 * 127.0.0.1. This is the exact transport DSH Web uses by default. No model,
 * profile, external network, browser, or LAN listener is involved.
 */
export async function probeWslWebLocalhostRelay(
  env: NodeJS.ProcessEnv = process.env,
  distro?: string,
  cwd = process.cwd(),
): Promise<boolean> {
  if (process.platform !== 'win32') return true

  const token = randomUUID().replaceAll('-', '')
  const childEnv = { ...env, WSLENV: '' }
  const child = spawn('wsl.exe', buildWslWebRelayProbeArgs(token, distro), {
    cwd: hostCwdForWslSpawn(cwd, env),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const port = await waitForPort(child)
  const reachable = port !== undefined && await hostReceivesToken(port, token)
  await reapRelayProbe(child)
  return reachable
}

export async function reportWslWebDoctor(
  env: NodeJS.ProcessEnv = process.env,
  distro?: string,
  cwd = process.cwd(),
  write: (line: string) => void = line => console.error(line),
): Promise<number> {
  const reachable = await probeWslWebLocalhostRelay(env, distro, cwd)
  if (reachable) {
    write('[orcana-wsl] web-localhost: Windows 127.0.0.1 can reach WSL 127.0.0.1')
    return 0
  }
  write('[orcana-wsl] web-localhost: FAILED — Windows cannot reach a WSL service bound to 127.0.0.1')
  write('[orcana-wsl] web-localhost: DSH Web intentionally stays on loopback; check WSL2 localhost forwarding/network configuration instead of widening the server to 0.0.0.0')
  return 72
}

export const WSL_WEB_RELAY_SERVER_SCRIPT = RELAY_SERVER_SCRIPT
