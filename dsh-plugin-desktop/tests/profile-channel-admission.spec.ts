import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDesktopProfileUsageHistory,
  hasDesktopProfileUsageHistory,
} from '../src/profile-channel-admission.ts'
import { DesktopProfileCheckpoint } from '../src/profile-checkpoint.ts'
import {
  completeOrSkipDesktopSetupWizard,
  desktopSetupWizardStatePath,
  readDesktopSetupWizardState,
} from '../src/setup-wizard-state.ts'
import { DESKTOP_PACKAGE_NAME, DESKTOP_RELEASE_CHANNEL } from '../src/product-identity.ts'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-channel-'))
  roots.push(root)
  const userData = join(root, 'user-data')
  const home = join(root, '.dsh')
  const profile = join(home, 'profiles', 'work')
  const other = join(home, 'profiles', 'other')
  mkdirSync(userData)
  mkdirSync(profile, { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"name":"work"}\n')
  return { root, userData, home, profile, other }
}

function capture(
  target: ReturnType<typeof fixture>,
  recordedAt: string,
  desktopVersion = '2.0.4',
): string {
  const checkpoint = new DesktopProfileCheckpoint({
    userDataDir: target.userData,
    profileDir: target.profile,
    homeDir: target.home,
    profileName: 'work',
    provider: 'desktop-profile',
    appVersion: desktopVersion,
    desktopPackageName: DESKTOP_PACKAGE_NAME,
    releaseChannel: DESKTOP_RELEASE_CHANNEL,
    dshVersion: '0.1.2-rc.1',
    now: () => Date.parse(recordedAt),
  })
  const result = checkpoint.captureHealthy()
  if (result.status !== 'captured') throw new Error('expected a captured checkpoint')
  return join(result.snapshotDirectory, 'manifest.json')
}

const VERSIONS = { desktopVersion: '2.0.4', dshVersion: '0.1.2-rc.1', setupRevision: 1 }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Desktop Profile usage history', () => {
  it('requires a genuinely unused Profile, not just an existing directory or another Profile history', async () => {
    const target = fixture()
    expect(hasDesktopProfileUsageHistory(target.userData, target.profile, 'work')).toBe(false)
    await completeOrSkipDesktopSetupWizard(target.userData, target.other, 'completed', VERSIONS)
    expect(hasDesktopProfileUsageHistory(target.userData, target.profile, 'work')).toBe(false)
  })

  it.each(['completed', 'skipped'] as const)('honors %s Setup evidence without rewriting it', async outcome => {
    const target = fixture()
    const state = await completeOrSkipDesktopSetupWizard(target.userData, target.profile, outcome, VERSIONS)
    const path = desktopSetupWizardStatePath(target.userData, target.profile)
    const original = readFileSync(path, 'utf8')
    expect(hasDesktopProfileUsageHistory(target.userData, target.profile, 'work')).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(original)
    writeFileSync(path, JSON.stringify({ version: 1, profileHash: state.profileHash, outcome }))
    expect(hasDesktopProfileUsageHistory(target.userData, target.profile, 'work')).toBe(true)
  })

  it('recognizes older successful launches without Setup markers', () => {
    const target = fixture()
    capture(target, '2026-09-02T01:00:00.000Z', '1.0.0')
    expect(readDesktopSetupWizardState(target.userData, target.profile)).toBeUndefined()
    expect(hasDesktopProfileUsageHistory(target.userData, target.profile, 'work')).toBe(true)
  })

  it('does not mistake corrupt history for first use', () => {
    const target = fixture()
    const manifestPath = capture(target, '2026-09-02T01:00:00.000Z')
    writeFileSync(manifestPath, '{broken')
    expect(() => hasDesktopProfileUsageHistory(target.userData, target.profile, 'work')).toThrow()
  })

  it('clears only this Profile evidence and leaves the Profile itself intact', async () => {
    const target = fixture()
    capture(target, '2026-09-02T01:00:00.000Z')
    await completeOrSkipDesktopSetupWizard(target.userData, target.profile, 'completed', VERSIONS)
    const profileManifest = readFileSync(join(target.profile, 'package.json'), 'utf8')

    clearDesktopProfileUsageHistory(target.userData, target.profile)

    expect(hasDesktopProfileUsageHistory(target.userData, target.profile, 'work')).toBe(false)
    expect(readDesktopSetupWizardState(target.userData, target.profile)).toBeUndefined()
    expect(existsSync(target.profile)).toBe(true)
    expect(readFileSync(join(target.profile, 'package.json'), 'utf8')).toBe(profileManifest)
  })

  it('rejects relative evidence paths', () => {
    const target = fixture()
    expect(() => hasDesktopProfileUsageHistory('relative', target.profile, 'work'))
      .toThrow('absolute path')
    expect(() => clearDesktopProfileUsageHistory(target.userData, 'relative'))
      .toThrow('absolute path')
  })
})
