import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WSL_WORKSPACE_DOCTOR_SCRIPT } from '../src/wsl-workspace-doctor.ts'

const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0

function withRepo<T>(origin: string, run: (dir: string, env: NodeJS.ProcessEnv) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orcana-git-auth-'))
  try {
    expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0)
    expect(spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir }).status).toBe(0)
    const home = join(dir, 'home')
    const xdg = join(dir, 'xdg')
    mkdirSync(home, { recursive: true })
    mkdirSync(xdg, { recursive: true })
    return run(dir, {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      SSH_AUTH_SOCK: '',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32' || !hasGit)('WSL Git authentication doctor', () => {
  it('recognizes a visible credential manager without exposing its path or credentials', () => {
    withRepo('https://token@example.invalid/private/repo.git', (dir, env) => {
      const tools = join(dir, 'tools')
      mkdirSync(tools)
      const gcm = join(tools, 'git-credential-manager.exe')
      writeFileSync(gcm, '#!/bin/sh\nexit 0\n')
      chmodSync(gcm, 0o755)
      env.PATH = `${tools}:${process.env.PATH ?? ''}`

      const result = spawnSync('/bin/sh', ['-c', WSL_WORKSPACE_DOCTOR_SCRIPT], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('git-origin-auth: https')
      expect(result.stdout).toContain('git-https-credentials: helper-available-not-configured')
      expect(result.stdout).not.toContain('token@example.invalid')
      expect(result.stdout).not.toContain(gcm)
    })
  })

  it('distinguishes a local SSH key from a live agent without printing the key name', () => {
    withRepo('git@example.invalid:private/repo.git', (dir, env) => {
      const sshDir = join(env.HOME!, '.ssh')
      mkdirSync(sshDir, { recursive: true })
      const key = join(sshDir, 'id_ed25519')
      writeFileSync(key, 'private-test-material-that-must-never-be-printed\n', { mode: 0o600 })

      const result = spawnSync('/bin/sh', ['-c', WSL_WORKSPACE_DOCTOR_SCRIPT], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('git-origin-auth: ssh')
      expect(result.stdout).toContain('git-ssh-auth: local-key-present-no-agent')
      expect(result.stdout).not.toContain('id_ed25519')
      expect(result.stdout).not.toContain('private-test-material')
    })
  })
})
