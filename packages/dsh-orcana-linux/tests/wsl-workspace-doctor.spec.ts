import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WSL_WORKSPACE_DOCTOR_SCRIPT,
  buildWslWorkspaceDoctorArgs,
  runWslWorkspaceDoctor,
} from '../src/wsl-workspace-doctor.ts'

const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-orcana-workspace-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('WSL workspace doctor argv', () => {
  it('runs directly in the mapped Linux cwd and selected distro', () => {
    expect(buildWslWorkspaceDoctorArgs('/home/leo/repo', 'Ubuntu-24.04')).toEqual([
      '--distribution', 'Ubuntu-24.04',
      '--cd', '/home/leo/repo',
      '--exec', '/bin/sh', '-c', WSL_WORKSPACE_DOCTOR_SCRIPT,
    ])
  })

  it('treats a failed doctor transport as advisory because core WSL doctor owns transport errors', () => {
    const fake = (() => ({ status: null, error: new Error('transport failed') })) as unknown as typeof import('node:child_process').spawnSync
    expect(runWslWorkspaceDoctor('/repo', {}, 'Ubuntu', fake)).toBe(0)
  })
})

describe.skipIf(process.platform === 'win32' || !hasGit)('workspace doctor shell integration', () => {
  it('rejects WSL1 when the official wslinfo probe reports it', () => {
    withTempDir((dir) => {
      const tools = join(dir, 'tools')
      mkdirSync(tools)
      const wslinfo = join(tools, 'wslinfo')
      writeFileSync(wslinfo, '#!/bin/sh\nprintf "%s\\n" "wsl1"\n')
      chmodSync(wslinfo, 0o755)

      const result = spawnSync('/bin/sh', ['-c', WSL_WORKSPACE_DOCTOR_SCRIPT], {
        cwd: dir,
        env: { ...process.env, PATH: `${tools}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      })

      expect(result.status).toBe(71)
      expect(result.stdout).toContain('wsl-networking: wsl1')
      expect(result.stdout).toContain('wsl-runtime: UNSUPPORTED')
    })
  })

  it('recognizes a usable Git worktree without printing configured identity or remote URL', () => {
    withTempDir((dir) => {
      expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0)
      expect(spawnSync('git', ['config', 'user.name', 'Private Test Name'], { cwd: dir }).status).toBe(0)
      expect(spawnSync('git', ['config', 'user.email', 'private-test@example.invalid'], { cwd: dir }).status).toBe(0)
      expect(spawnSync('git', ['remote', 'add', 'origin', 'https://token@example.invalid/private/repo.git'], { cwd: dir }).status).toBe(0)
      expect(spawnSync('git', ['config', 'credential.helper', 'cache'], { cwd: dir }).status).toBe(0)

      const result = spawnSync('/bin/sh', ['-c', WSL_WORKSPACE_DOCTOR_SCRIPT], {
        cwd: dir,
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('git-worktree: OK')
      expect(result.stdout).toContain('git-identity: configured')
      expect(result.stdout).toContain('git-origin-auth: https')
      expect(result.stdout).toContain('git-https-credentials: helper-configured')
      expect(result.stdout).not.toContain('Private Test Name')
      expect(result.stdout).not.toContain('private-test@example.invalid')
      expect(result.stdout).not.toContain('token@example.invalid')
    })
  })

  it('keeps missing identity/credential helper advisory', () => {
    withTempDir((dir) => {
      expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0)
      expect(spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/repo.git'], { cwd: dir }).status).toBe(0)
      const env = {
        ...process.env,
        HOME: join(dir, 'isolated-home'),
        XDG_CONFIG_HOME: join(dir, 'isolated-xdg'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      }
      mkdirSync(env.HOME, { recursive: true })
      mkdirSync(env.XDG_CONFIG_HOME, { recursive: true })

      const result = spawnSync('/bin/sh', ['-c', WSL_WORKSPACE_DOCTOR_SCRIPT], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('git-identity: MISSING')
      expect(result.stdout).toContain('git-https-credentials: NO-HELPER')
    })
  })

  it('fails when repository metadata exists but Git cannot open it', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, '.git'))
      const result = spawnSync('/bin/sh', ['-c', WSL_WORKSPACE_DOCTOR_SCRIPT], {
        cwd: dir,
        encoding: 'utf8',
      })
      expect(result.status).toBe(70)
      expect(result.stdout).toContain('git-worktree: UNUSABLE')
    })
  })

  it('does not require the workspace to be a Git repository', () => {
    withTempDir((dir) => {
      const result = spawnSync('/bin/sh', ['-c', WSL_WORKSPACE_DOCTOR_SCRIPT], {
        cwd: dir,
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('git-worktree: not-a-repository')
    })
  })
})
