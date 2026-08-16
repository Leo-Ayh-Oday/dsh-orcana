import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WSL_CONFIG_FINGERPRINT_SCRIPT,
  buildWslConfigFingerprintArgs,
  classifyConfigParity,
  fingerprintHostManagedConfig,
  managedConfigParityRows,
  probeWslManagedConfig,
  reportWslManagedConfigDoctor,
  type WslManagedConfigSnapshot,
} from '../src/wsl-config-doctor.ts'

function withTempHome<T>(run: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'dsh-orcana-config-doctor-'))
  try {
    return run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function snapshot(
  settings: WslManagedConfigSnapshot['settings.yaml'],
  credentials: WslManagedConfigSnapshot['.credentials.yaml'],
): WslManagedConfigSnapshot {
  return { 'settings.yaml': settings, '.credentials.yaml': credentials }
}

function fakeWslSnapshot(value: WslManagedConfigSnapshot) {
  return ((command: string, args: readonly string[], options: Record<string, unknown>) => ({
    status: 0,
    error: undefined,
    stdout: JSON.stringify(value),
    stderr: '',
    command,
    args,
    options,
  })) as unknown as typeof import('node:child_process').spawnSync
}

describe('WSL managed-config fingerprint contract', () => {
  it('fingerprints Windows settings/credentials without returning their contents', () => {
    withTempHome((home) => {
      const dshHome = join(home, '.dsh')
      mkdirSync(dshHome)
      const settingsSecret = 'llm-pi-ai:\n  provider: private-model\n'
      const credentialSecret = 'DEEPSEEK_API_KEY: sk-do-not-print\n'
      writeFileSync(join(dshHome, 'settings.yaml'), settingsSecret)
      writeFileSync(join(dshHome, '.credentials.yaml'), credentialSecret)

      const result = fingerprintHostManagedConfig({}, home)
      expect(result['settings.yaml'].state).toBe('present')
      expect(result['settings.yaml'].sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result['.credentials.yaml'].state).toBe('present')
      expect(result['.credentials.yaml'].sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(result)).not.toContain(settingsSecret)
      expect(JSON.stringify(result)).not.toContain(credentialSecret)
      expect(JSON.stringify(result)).not.toContain('sk-do-not-print')
    })
  })

  it('honors an explicit Windows DSH_HOME only on the host side', () => {
    withTempHome((home) => {
      const explicit = join(home, 'custom-dsh-home')
      mkdirSync(explicit)
      writeFileSync(join(explicit, 'settings.yaml'), 'custom: true\n')
      const result = fingerprintHostManagedConfig({ DSH_HOME: explicit }, join(home, 'unused-home'))
      expect(result['settings.yaml'].state).toBe('present')
      expect(result['.credentials.yaml']).toEqual({ state: 'absent' })
    })
  })

  it('runs the WSL probe in the selected distro and keeps values out of argv', () => {
    const args = buildWslConfigFingerprintArgs('Ubuntu-24.04')
    expect(args).toEqual([
      '--distribution', 'Ubuntu-24.04',
      '--exec', 'node', '-e', WSL_CONFIG_FINGERPRINT_SCRIPT,
    ])
    expect(args.join(' ')).not.toContain('settings.yaml:')
    expect(args.join(' ')).not.toContain('DEEPSEEK_API_KEY')
  })

  it('does not forward Windows DSH_HOME through WSLENV during the WSL fingerprint probe', () => {
    let seenEnv: NodeJS.ProcessEnv | undefined
    const fake = ((_: string, __: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      seenEnv = options.env
      return {
        status: 0,
        error: undefined,
        stdout: JSON.stringify(snapshot({ state: 'absent' }, { state: 'absent' })),
        stderr: '',
      }
    }) as unknown as typeof import('node:child_process').spawnSync

    expect(probeWslManagedConfig({ DSH_HOME: 'C:\\Users\\leo\\.dsh', WSLENV: 'DSH_HOME/u' }, 'Ubuntu', 'C:\\repo', fake))
      .toEqual(snapshot({ state: 'absent' }, { state: 'absent' }))
    expect(seenEnv?.WSLENV).toBe('')
  })
})

describe('managed-config parity classification', () => {
  it.each([
    [{ state: 'absent' }, { state: 'absent' }, 'absent'],
    [{ state: 'present', sha256: 'a'.repeat(64) }, { state: 'absent' }, 'host-only'],
    [{ state: 'absent' }, { state: 'present', sha256: 'a'.repeat(64), mode: 0o600 }, 'wsl-only'],
    [{ state: 'present', sha256: 'a'.repeat(64) }, { state: 'present', sha256: 'a'.repeat(64), mode: 0o600 }, 'same'],
    [{ state: 'present', sha256: 'a'.repeat(64) }, { state: 'present', sha256: 'b'.repeat(64), mode: 0o600 }, 'different'],
    [{ state: 'unreadable' }, { state: 'present', sha256: 'a'.repeat(64), mode: 0o600 }, 'unknown'],
  ] as const)('classifies %#', (host, wsl, expected) => {
    expect(classifyConfigParity(host, wsl)).toBe(expected)
  })

  it('keeps each file classification independent', () => {
    const host = snapshot(
      { state: 'present', sha256: 'a'.repeat(64) },
      { state: 'absent' },
    )
    const wsl = snapshot(
      { state: 'present', sha256: 'a'.repeat(64), mode: 0o600 },
      { state: 'present', sha256: 'b'.repeat(64), mode: 0o600 },
    )
    expect(managedConfigParityRows(host, wsl).map(row => [row.file, row.status])).toEqual([
      ['settings.yaml', 'same'],
      ['.credentials.yaml', 'wsl-only'],
    ])
  })
})

describe('managed-config doctor disclosure and permission policy', () => {
  it('keeps host-only/different settings advisory and never prints hashes or secret values', () => {
    withTempHome((home) => {
      const dshHome = join(home, '.dsh')
      mkdirSync(dshHome)
      writeFileSync(join(dshHome, 'settings.yaml'), 'private-host-setting: alpha\n')
      writeFileSync(join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-private-host\n')

      const wsl = snapshot(
        { state: 'present', sha256: 'b'.repeat(64), mode: 0o600 },
        { state: 'absent' },
      )
      const lines: string[] = []
      const status = reportWslManagedConfigDoctor(
        {},
        'Ubuntu',
        'C:\\repo',
        fakeWslSnapshot(wsl),
        line => lines.push(line),
        home,
      )
      const output = lines.join('\n')
      expect(status).toBe(0)
      expect(output).toContain('settings.yaml different')
      expect(output).toContain('.credentials.yaml host-only')
      expect(output).toContain('intentionally not auto-copied')
      expect(output).not.toContain('a'.repeat(64))
      expect(output).not.toContain('b'.repeat(64))
      expect(output).not.toContain('sk-private-host')
      expect(output).not.toContain('private-host-setting')
    })
  })

  it('fails doctor when the WSL credentials document has unsafe group/other permissions', () => {
    const wsl = snapshot(
      { state: 'absent' },
      { state: 'present', sha256: 'c'.repeat(64), mode: 0o644 },
    )
    const lines: string[] = []
    expect(reportWslManagedConfigDoctor(
      {}, 'Ubuntu', 'C:\\repo', fakeWslSnapshot(wsl), line => lines.push(line), 'C:\\Users\\leo',
    )).toBe(73)
    expect(lines.join('\n')).toContain('UNSAFE-MODE 644')
    expect(lines.join('\n')).not.toContain('c'.repeat(64))
  })

  it('accepts an owner-only WSL credentials document', () => {
    const wsl = snapshot(
      { state: 'absent' },
      { state: 'present', sha256: 'd'.repeat(64), mode: 0o600 },
    )
    expect(reportWslManagedConfigDoctor(
      {}, 'Ubuntu', 'C:\\repo', fakeWslSnapshot(wsl), () => {}, 'C:\\Users\\leo',
    )).toBe(0)
  })
})
