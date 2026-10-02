/** Read-only Desktop Profile usage detection backed by the launcher's private state. */

import { isAbsolute, resolve } from 'node:path'
import {
  clearDesktopProfileCheckpoint,
  inspectLatestDesktopProfileCheckpointUsage,
} from './profile-checkpoint.ts'
import {
  clearDesktopSetupWizardStateSync,
  readDesktopSetupWizardState,
} from './setup-wizard-state.ts'
import { DESKTOP_PACKAGE_NAME, DESKTOP_RELEASE_CHANNEL } from './product-identity.ts'

function absolute(label: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`dsh-plugin-desktop: ${label} must be an absolute path without NUL`)
  }
  return resolve(value)
}

/**
 * Setup is shared by Profile identity. Read legacy completion/skip markers too;
 * their missing version is irrelevant here. Never stamp a new usage time merely
 * because another Profile was used.
 */
export function hasDesktopProfileUsageHistory(
  userDataDir: string,
  profileDir: string,
  profileName: string,
): boolean {
  const userData = absolute('user-data directory', userDataDir)
  const profile = absolute('Profile directory', profileDir)
  let problem: Error | undefined
  try {
    if (readDesktopSetupWizardState(userData, profile) !== undefined) return true
  } catch (cause) {
    problem ??= cause instanceof Error ? cause : new Error(String(cause))
  }
  const checkpoint = inspectLatestDesktopProfileCheckpointUsage({
    userDataDir: userData,
    profileDir: profile,
    profileName,
    legacyDesktopPackageName: DESKTOP_PACKAGE_NAME,
    legacyReleaseChannel: DESKTOP_RELEASE_CHANNEL,
  })
  if (checkpoint.status === 'valid') return true
  if (checkpoint.status === 'invalid') problem ??= new Error(checkpoint.problem)
  // Corruption is not proof that a Profile is new; keep the recovery path.
  if (problem !== undefined) throw problem
  return false
}

/** Clear only this Profile's evidence after deletion or fresh creation. */
export function clearDesktopProfileUsageHistory(
  userDataDir: string,
  profileDir: string,
): void {
  const userData = absolute('user-data directory', userDataDir)
  const profile = absolute('Profile directory', profileDir)
  clearDesktopProfileCheckpoint(userData, profile)
  clearDesktopSetupWizardStateSync(userData, profile)
}
