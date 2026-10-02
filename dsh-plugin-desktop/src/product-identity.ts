/** Stable release-channel identities that must stay aligned with electron-builder. */

import { readFileSync } from 'node:fs'

export const DESKTOP_PRODUCT_IDENTITY = Object.freeze({
  releaseChannel: 'stable' as const,
  packageName: 'dsh-plugin-desktop',
  productName: 'DSH Desktop',
  appId: 'ai.deepseek.dsh.desktop',
  homeDirectoryName: '.dsh',
})

export type DesktopProductIdentity = typeof DESKTOP_PRODUCT_IDENTITY

export const DESKTOP_PACKAGE_NAME = DESKTOP_PRODUCT_IDENTITY.packageName
export const DESKTOP_PRODUCT_NAME = DESKTOP_PRODUCT_IDENTITY.productName
export const DESKTOP_APP_ID = DESKTOP_PRODUCT_IDENTITY.appId
export const DESKTOP_RELEASE_CHANNEL = DESKTOP_PRODUCT_IDENTITY.releaseChannel
export const DESKTOP_HOME_DIRECTORY_NAME = DESKTOP_PRODUCT_IDENTITY.homeDirectoryName

/** The Desktop package identity is launcher-owned, never a Profile plugin. */
export const DESKTOP_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  DESKTOP_PACKAGE_NAME,
])

/**
 * Read the desktop package version instead of Electron's development-app version.
 *
 * Lives beside the release identity so the headless Host and the Electron runtime
 * resolve the same number without the Host importing the Electron module.
 * @param moduleUrl - module below the package's `src` or `lib` directory.
 * @returns validated desktop product version.
 */
export function desktopProductVersion(moduleUrl: string = import.meta.url): string {
  const value: unknown = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8'))
  if (value === null || typeof value !== 'object' || typeof (value as { version?: unknown }).version !== 'string') {
    throw new Error('dsh-plugin-desktop: package.json has no product version')
  }
  return (value as { version: string }).version
}
