/** Launcher-backed controller for the private Desktop settings API. */

import type { DesktopProfileSummary } from './profile-manager.ts'
import type { DesktopProfiles } from './profile-service.ts'
import type {
  DesktopDeveloperToolsToggleResponse,
  DesktopDiagnosticsExportResponse,
  DesktopProfileCreateResponse,
  DesktopProfileDeleteResponse,
  DesktopProfileSelectResponse,
  DesktopRestartResponse,
  DesktopRecoveryRestartResponse,
  DesktopRendererReloadResponse,
  DesktopSettingsProfileView,
  DesktopSettingsResponse,
  DesktopSettingsWebView,
  DesktopTerminalOpenResponse,
} from './desktop-settings-contract.ts'

/** Launcher capabilities used without exposing their filesystem roots. */
export interface DesktopSettingsControllerBootstrap {
  /** Generation-scoped profile service. */
  readonly profiles: Pick<DesktopProfiles, 'current' | 'list' | 'create' | 'prepareSelection'>
    & Partial<Pick<DesktopProfiles, 'canDelete' | 'delete'>>
  /** Read marker-free URLs from the generation's actual WebServer and LAN snapshot. */
  readWeb(): DesktopSettingsWebView
  /** Queue an orderly restart after a response confirms persisted selection. */
  scheduleRestart(): void
  /** Queue an orderly restart into the pre-Host recovery assistant. */
  scheduleRecoveryRestart(): void
  /** Open the launcher-owned DSH terminal. */
  openTerminal(): void
  /** Reload the mounted renderer after its HTTP acknowledgement is delivered. */
  reloadRenderer(): void
  /** Toggle Developer Tools for the mounted renderer. */
  toggleDeveloperTools(): void
  /** Export diagnostics through the launcher-owned privacy flow. */
  exportDiagnostics(): void | Promise<void>
}

/** A persisted response plus work that must run only after `res.end()`. */
export interface DesktopSettingsPostResponse<T extends object> {
  readonly response: T
  readonly afterResponse?: () => void | Promise<void>
}

/** Remove paths, bundle identities, and parser diagnostics from a profile. */
export function projectDesktopSettingsProfile(
  profile: DesktopProfileSummary,
  deletable = false,
): DesktopSettingsProfileView {
  return Object.freeze({
    name: profile.name,
    exists: profile.exists,
    webCapable: profile.webCapable,
    selectable: profile.exists && profile.webCapable && profile.problem === undefined,
    deletable,
  })
}

/**
 * Generation-scoped controller for Profile preferences.
 */
export class DesktopSettingsController {
  constructor(private readonly bootstrap: DesktopSettingsControllerBootstrap) {}

  /** Read a fresh, renderer-safe settings projection. */
  read(): DesktopSettingsResponse {
    const web = this.bootstrap.readWeb()
    return Object.freeze({
      current: this.bootstrap.profiles.current.name,
      profiles: Object.freeze(
        this.bootstrap.profiles.list().map(profile => projectDesktopSettingsProfile(
          profile,
          this.bootstrap.profiles.canDelete?.(profile.name) ?? false,
        )),
      ),
      web: Object.freeze({
        localUrl: web.localUrl,
        lanUrls: Object.freeze([...web.lanUrls]),
        lanState: web.lanState,
        lanError: web.lanError,
        lanCaFingerprint: web.lanCaFingerprint,
        lanCaUrls: Object.freeze([...web.lanCaUrls]),
      }),
    })
  }

  /** Create one safe profile without selecting it or requesting restart. */
  createProfile(name: string): DesktopProfileCreateResponse {
    this.bootstrap.profiles.create(name)
    return this.read()
  }

  /** Delete one inactive user profile and return the fresh settings state. */
  async deleteProfile(name: string): Promise<DesktopProfileDeleteResponse> {
    if (this.bootstrap.profiles.delete === undefined) {
      throw new Error('dsh-plugin-desktop: profile deletion is unavailable')
    }
    await this.bootstrap.profiles.delete(name)
    return this.read()
  }

  /** Persist a fresh compatible profile, deferring restart until after response. */
  async selectProfile(
    name: string,
  ): Promise<DesktopSettingsPostResponse<DesktopProfileSelectResponse>> {
    const selection = await this.bootstrap.profiles.prepareSelection(name)
    return Object.freeze({
      response: Object.freeze({ accepted: true, restartRequired: selection.restartRequired }),
      ...(selection.restartRequired ? { afterResponse: () => selection.restart() } : {}),
    })
  }

  /** Open the native terminal through the launcher-owned action. */
  openTerminal(): DesktopTerminalOpenResponse {
    this.bootstrap.openTerminal()
    return Object.freeze({ accepted: true })
  }

  /** Acknowledge the renderer before queueing an orderly Desktop relaunch. */
  restart(): DesktopSettingsPostResponse<DesktopRestartResponse> {
    return Object.freeze({
      response: Object.freeze({ accepted: true }),
      afterResponse: () => { this.bootstrap.scheduleRestart() },
    })
  }

  /** Acknowledge the renderer before queueing a recovery-mode relaunch. */
  restartToRecovery(): DesktopSettingsPostResponse<DesktopRecoveryRestartResponse> {
    return Object.freeze({
      response: Object.freeze({ accepted: true }),
      afterResponse: () => { this.bootstrap.scheduleRecoveryRestart() },
    })
  }

  /** Acknowledge the renderer before replacing its current document. */
  reloadRenderer(): DesktopSettingsPostResponse<DesktopRendererReloadResponse> {
    return Object.freeze({
      response: Object.freeze({ accepted: true }),
      afterResponse: () => { this.bootstrap.reloadRenderer() },
    })
  }

  /** Toggle Developer Tools without exposing an Electron bridge to the page. */
  toggleDeveloperTools(): DesktopDeveloperToolsToggleResponse {
    this.bootstrap.toggleDeveloperTools()
    return Object.freeze({ accepted: true })
  }

  /** Export diagnostics through the native confirmation and reveal flow. */
  async exportDiagnostics(): Promise<DesktopDiagnosticsExportResponse> {
    await this.bootstrap.exportDiagnostics()
    return Object.freeze({ accepted: true })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned controller behind the private loopback settings API. */
    desktopSettingsController: DesktopSettingsController
  }
}

export default DesktopSettingsController
