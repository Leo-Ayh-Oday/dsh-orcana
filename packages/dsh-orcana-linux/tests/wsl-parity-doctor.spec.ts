import { describe, expect, it } from 'vitest'
import {
  WSL_PARITY_DOCTOR_SCRIPT,
  buildWslParityDoctorArgs,
  classifyWindowsSpelling,
  mountHasMetadata,
} from '../src/wsl-parity-doctor.ts'

describe('WSL parity path classification', () => {
  it('distinguishes Windows-drive and WSL-native Windows spellings', () => {
    expect(classifyWindowsSpelling('C:\\repo\\project')).toBe('windows-drive')
    expect(classifyWindowsSpelling('D:/repo/project')).toBe('windows-drive')
    expect(classifyWindowsSpelling('\\\\wsl.localhost\\Ubuntu\\home\\leo\\repo')).toBe('linux-native')
    expect(classifyWindowsSpelling('\\\\wsl$\\Debian\\srv\\repo')).toBe('linux-native')
    expect(classifyWindowsSpelling('/unexpected/linux/path')).toBe('unknown')
  })

  it('detects DrvFS metadata as a discrete mount option', () => {
    expect(mountHasMetadata('rw,relatime,metadata,uid=1000')).toBe(true)
    expect(mountHasMetadata('rw;metadata;uid=1000')).toBe(true)
    expect(mountHasMetadata('rw,relatime,nometadata,uid=1000')).toBe(false)
    expect(mountHasMetadata('rw,relatime')).toBe(false)
  })
})

describe('WSL parity doctor command contract', () => {
  it('runs entirely inside the selected Linux cwd without widening network/listen scope', () => {
    const args = buildWslParityDoctorArgs('/mnt/c/work tree', 'Ubuntu-24.04')
    expect(args.slice(0, 7)).toEqual([
      '--distribution', 'Ubuntu-24.04',
      '--cd', '/mnt/c/work tree',
      '--exec', '/bin/sh', '-c',
    ])
    expect(args[7]).toBe(WSL_PARITY_DOCTOR_SCRIPT)
  })

  it('diagnoses TTY, UTF-8, path roundtrip, mount semantics and interop read-only', () => {
    expect(WSL_PARITY_DOCTOR_SCRIPT).toContain('test -t 0')
    expect(WSL_PARITY_DOCTOR_SCRIPT).toContain('locale charmap')
    expect(WSL_PARITY_DOCTOR_SCRIPT).toContain('wslpath -w "$PWD"')
    expect(WSL_PARITY_DOCTOR_SCRIPT).toContain('findmnt -T .')
    expect(WSL_PARITY_DOCTOR_SCRIPT).toContain('drvfs-metadata')
    expect(WSL_PARITY_DOCTOR_SCRIPT).toContain('cmd.exe')
    expect(WSL_PARITY_DOCTOR_SCRIPT).not.toContain('chmod ')
    expect(WSL_PARITY_DOCTOR_SCRIPT).not.toContain('mount -o')
  })
})
