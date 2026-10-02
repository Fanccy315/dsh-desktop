/** Headless bootstrap for the Beta isolated Host experiment. */
import { boot, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createDesktopProfileBoot } from './profile-context.ts'
import { logInactiveStartupEntries } from './startup-audit.ts'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { DESKTOP_PACKAGE_NAME as BIN_NAME } from './product-identity.ts'
import { observeDesktopPreferenceSettings } from './settings-bridge.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { createDesktopWebProfile, listDesktopProfiles, canDeleteDesktopProfile, deleteDesktopProfile, selectDesktopProfile } from './profile-manager.ts'
import { DesktopProfileService } from './profile-service.ts'
import { DesktopActionsService } from './desktop-actions.ts'
import { clearDesktopProfilePluginState, DesktopPluginsService } from './desktop-plugins.ts'
import DesktopSettingsController from './desktop-settings-controller.ts'
import { clearDesktopProfilePreferences, readDesktopProfilePreferences, writeDesktopProfilePreferences, type DesktopProfilePreferences, type DesktopProfilePreferencesStateV2 } from './profile-preferences.ts'
import { clearDesktopProfileUsageHistory } from './profile-channel-admission.ts'
import { desktopInstallAnchor, type PreparedDesktopProfile } from './profile.ts'
import { desktopLanBrowserUrls, desktopLoopbackBrowserUrl } from './desktop-network.ts'
import { DESKTOP_LAN_HTTPS_CA_PATH, type DesktopLanHttpsRuntime } from './lan-https-runtime.ts'
import type { DesktopBrowserAccess } from './desktop-browser-access.ts'
import type { DesktopPnpmBootstrap } from './pnpm.ts'
import type { DesktopRuntime } from './runtime.ts'
import type { DesktopStartupGenerationHost } from './startup-generation.ts'
import { FileExporter } from './file-exporter.ts'
import { installAgentErrorLogging } from './agent-error-logging.ts'
import { LogFileSink } from './log-files.ts'

export interface DesktopHostOptions {
  prepared: PreparedDesktopProfile
  profilePreferences: DesktopProfilePreferences
  homeDir: string
  activeProfileName: string
  pluginManagementStatePath: string
  selectionStatePath: string
  userDataDir: string
  desktopLaunchEnvironment: LaunchEnvironmentSnapshot
  /**
   * Proxy names the supervisor synthesized from the operating system's configuration, keyed
   * lowercase, empty when the user exported a proxy themselves or the machine has none.
   *
   * Passed rather than re-derived: a launch environment snapshot is frozen when it loads, so the
   * supervisor's later writes to `process.env` never reach it, and the Host re-probing on its own
   * could reach a different answer than the window the user is looking at.
   */
  desktopProxyOverlay: Readonly<Record<string, string>>
  desktopPnpmBootstrap: DesktopPnpmBootstrap
  logDirectory: string
}

export async function bootDesktopHost(options: DesktopHostOptions, runtime: DesktopRuntime,
  browserAccess: DesktopBrowserAccess, lanHttps: DesktopLanHttpsRuntime,
  bindHost: (host: DesktopStartupGenerationHost) => void, requestQuit: (code: number) => void,
): Promise<() => void> {
  const { prepared, profilePreferences, homeDir, activeProfileName, pluginManagementStatePath,
    selectionStatePath, userDataDir, desktopLaunchEnvironment,
    desktopPnpmBootstrap } = options
  const createFreshDesktopProfile = (name: string) => {
    const created = createDesktopWebProfile(homeDir, name)
    clearDesktopProfileUsageHistory(userDataDir, created.dir)
    return created
  }
  const logSink = new LogFileSink(options.logDirectory, {
    maxFileBytes: 10 * 1024 * 1024, maxDirectoryBytes: 200 * 1024 * 1024,
  })
  let fileExporter: FileExporter | undefined
    let currentProfilePreferences: DesktopProfilePreferences = profilePreferences
    let profilePreferencesWriteTail: Promise<void> = Promise.resolve()
    let profilePreferencesStopping = false
    // Setup saves from the Electron process after this Host booted; follow the
    // durable file so its choices are neither reverted nor hidden.
    const latestProfilePreferences = (): DesktopProfilePreferences =>
      readDesktopProfilePreferences(userDataDir, prepared.profile.dir) ?? currentProfilePreferences
    const enqueueProfilePreferencesWrite = (
      update: (current: DesktopProfilePreferences) => DesktopProfilePreferences,
    ): Promise<DesktopProfilePreferencesStateV2> => {
      if (profilePreferencesStopping) {
        return Promise.reject(new Error(`${BIN_NAME}: Profile preferences are stopping`))
      }
      const write = profilePreferencesWriteTail.then(async () => {
        const next = update(latestProfilePreferences())
        const stored = await writeDesktopProfilePreferences(
          userDataDir,
          prepared.profile.dir,
          next,
        )
        currentProfilePreferences = stored
        return stored
      })
      profilePreferencesWriteTail = write.then(() => undefined, () => undefined)
      return write
    }
    const flushProfilePreferencesWrites = async (): Promise<void> => {
      profilePreferencesStopping = true
      await profilePreferencesWriteTail
    }
    const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    const profileBoot = createDesktopProfileBoot(prepared, desktopPnpmBootstrap)
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async (hostCtx) => {
        profileBoot.prepare(hostCtx)
        // Keep Host imports and browser bundle discovery on the same public
        // profile-overlay resolver used by packaged Electron.
        hostCtx.loader.internal = undefined
        bindHost(hostCtx)
        hostCtx.effect(() => () => logSink.close(), 'dsh-plugin-desktop: Host log sink')
        hostCtx.effect(
          () => async () => { await flushProfilePreferencesWrites() },
          'dsh-plugin-desktop: flush Profile preference writes',
        )
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-plugin-desktop: profile package resolution',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, desktopLaunchEnvironment)
        hostCtx.provide('desktopBrowserAccess', browserAccess)
        hostCtx.provide('desktopLanHttps', lanHttps)
        hostCtx.provide('desktopRuntime', runtime)
        hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
        await hostCtx.plugin(DesktopActionsService, {
          openTerminal: () => { runtime.openTerminal() },
          requestRestart: () => runtime.requestRestart(),
        })
        await hostCtx.plugin(DesktopPluginsService, {
          profileName: activeProfileName,
          homeDir,
          statePath: pluginManagementStatePath,
          installAnchor: desktopInstallAnchor(),
        })
        if (logSink !== undefined) {
          fileExporter = new FileExporter(logSink)
          hostCtx.logger.exporter(fileExporter)
        }
        // Registered before the plugin tree mounts, so no agent can fail unrecorded.
        installAgentErrorLogging(hostCtx)
        await hostCtx.plugin(DesktopProfileService, {
          current: {
            name: activeProfileName,
            dir: prepared.profile.dir,
          },
          create: name => createFreshDesktopProfile(name),
          list: () => listDesktopProfiles(homeDir),
          canDelete: name => canDeleteDesktopProfile({
            home: homeDir,
            selectionStatePath,
            currentProfileName: activeProfileName,
          }, name),
          delete: async name => {
            const profileDir = resolveProfileDir(name, homeDir)
            await deleteDesktopProfile({
              home: homeDir,
              selectionStatePath,
              currentProfileName: activeProfileName,
              clearDisabledState: () => clearDesktopProfilePluginState(pluginManagementStatePath, name),
              clearCheckpoint: async () => {
                clearDesktopProfileUsageHistory(userDataDir, profileDir)
              },
            }, name)
            try {
              await clearDesktopProfilePreferences(userDataDir, profileDir)
            } catch (cause) {
              hostCtx.logger.error(
                `${BIN_NAME}: deleted Profile left stale preference state: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
            }
          },
          persistSelection: name => { selectDesktopProfile(selectionStatePath, homeDir, name) },
          requestRestart: () => runtime.requestRestart(),
        })
        let pendingSettingsRestart: ReturnType<typeof setImmediate> | undefined
        const scheduleSettingsRestart = (): void => {
          pendingSettingsRestart ??= setImmediate(() => {
            pendingSettingsRestart = undefined
            void runtime.requestRestart().catch((cause: unknown) => {
              hostCtx.logger.error(
                `${BIN_NAME}: failed to restart after Desktop setting change: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
            })
          })
        }
        hostCtx.effect(() => () => {
          if (pendingSettingsRestart !== undefined) clearImmediate(pendingSettingsRestart)
          pendingSettingsRestart = undefined
        }, 'dsh-plugin-desktop: pending Desktop settings restart')
        hostCtx.provide('desktopSettingsController', new DesktopSettingsController({
          profiles: hostCtx.desktopProfiles,
          readWeb: () => {
            const lan = lanHttps.snapshot()
            const lanOrigins = lan.state === 'ready' && lan.actualPort !== null
              ? desktopLanBrowserUrls(lan.actualPort, lan.addresses)
              : []
            return {
              localUrl: hostCtx.connection.authenticatedUrl(
                desktopLoopbackBrowserUrl(hostCtx.webServer.port),
              ),
              lanUrls: lanOrigins.map(url => hostCtx.connection.authenticatedUrl(url)),
              lanState: lan.state,
              lanError: lan.errorCode,
              lanCaFingerprint: lan.caFingerprint,
              lanCaUrls: lanOrigins.map((origin) => {
                return new URL(DESKTOP_LAN_HTTPS_CA_PATH, origin).href
              }),
            }
          },
          scheduleRestart: scheduleSettingsRestart,
          scheduleRecoveryRestart: () => {
            void runtime.requestRecoveryRestart().catch((cause: unknown) => {
              hostCtx.logger.error(
                `${BIN_NAME}: failed to restart in recovery mode: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
            })
          },
          openTerminal: () => { runtime.openTerminal() },
          reloadRenderer: () => { runtime.reloadRenderer() },
          toggleDeveloperTools: () => { runtime.toggleDeveloperTools() },
          exportDiagnostics: () => runtime.exportDiagnostics(),
        }))
        provideCmdline(hostCtx, {
          args: [
            '--port',
            String(prepared.port),
          ],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    })
    bindHost(ctx)
    profileBoot.markReady()
    observeDesktopPreferenceSettings(ctx, fileExporter, enqueueProfilePreferencesWrite)
    void logInactiveStartupEntries(ctx, BIN_NAME)
  return () => {}
}
