import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const fail = message => { throw new Error(`verify-layout: ${message}`) }

const workspace = readJson('package.json')
const upstream = readJson('upstream.json')
const desktopPlugin = readJson('dsh-plugin-desktop/package.json')
const inventoryPlugin = readJson('plugins/jc-inventory/package.json')
const upstreamPackage = readJson('deepseek-harness/package.json')

if (desktopPlugin.name !== 'dsh-plugin-desktop') fail('the Desktop workspace must retain dsh-plugin-desktop')
if (upstream.activeChannel !== 'stable') fail('the pinned upstream checkout must follow the stable release channel')
const upstreamChannels = Object.keys(upstream.channels ?? {})
if (JSON.stringify(upstreamChannels) !== JSON.stringify(['stable'])) {
  fail('upstream.json must record exactly the stable release channel')
}
const activeUpstream = upstream.channels?.[upstream.activeChannel]
if (activeUpstream === undefined) fail('the active upstream channel is missing')

if (workspace.packageManager !== 'yarn@4.18.0') {
  fail('the product workspace must pin yarn@4.18.0')
}
if (JSON.stringify(workspace.workspaces) !== JSON.stringify([
  'dsh-plugin-desktop',
  'plugins/jc-inventory',
])) {
  fail('the root Yarn workspace must contain exactly the desktop and jc-inventory packages')
}
const owned = new Map([
  ['dsh-plugin-desktop', desktopPlugin],
  ['dsh-plugin-jc-inventory', inventoryPlugin],
])
for (const [name, manifest] of owned) {
  if (manifest.name !== name) fail(`${name} must publish as ${name}`)
  if (manifest.packageManager !== undefined) fail(`${name} must inherit the root Yarn release`)
}

const claudePath = resolve(root, 'CLAUDE.md')
const claudeStat = lstatSync(claudePath)
// Windows checkouts materialize the symlink as a regular file holding the
// target name; accept both forms so the pointer stays verified on every host.
const claudeTarget = claudeStat.isSymbolicLink()
  ? readlinkSync(claudePath)
  : readFileSync(claudePath, 'utf8').trim()
if (claudeTarget !== 'AGENTS.md') {
  fail('CLAUDE.md must link to the outer repository AGENTS.md')
}
for (const legacyFile of [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'dsh-plugin-desktop/pnpm-lock.yaml',
  'dsh-plugin-desktop/pnpm-workspace.yaml',
]) {
  if (existsSync(resolve(root, legacyFile))) fail(`${legacyFile} must not exist`)
}
if (run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.deepseek-harness.path']) !== 'deepseek-harness') {
  fail('the upstream submodule path must be deepseek-harness')
}
if (run('git', ['config', '-f', '.gitmodules', '--get', 'submodule.deepseek-harness.url']) !== upstream.repository) {
  fail('the upstream submodule URL differs from upstream.json')
}
if (typeof upstreamPackage.packageManager !== 'string' || !upstreamPackage.packageManager.startsWith('pnpm@')) {
  fail('the upstream checkout must retain its pnpm package manager')
}

const ownedNames = new Set(owned.keys())
for (const [owner, manifest] of [
  ['root', workspace],
  ['desktop', desktopPlugin],
  ['jc-inventory', inventoryPlugin],
]) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolutions']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range !== 'string') continue
      if (range.startsWith('file:') && range.includes('deepseek-harness')) {
        fail(`${owner} ${field}.${name} bypasses the published DSH package boundary`)
      }
      // Linking an owned workspace member is the intended composition; linking
      // anything else by path would bypass the published DSH package boundary.
      if (/^(?:workspace|portal|link):/u.test(range) && !ownedNames.has(name)) {
        fail(`${owner} ${field}.${name} bypasses the published DSH package boundary`)
      }
    }
  }
}

const [mode, object] = run('git', ['ls-files', '--stage', '--', 'deepseek-harness']).split(/\s+/u)
if (mode !== '160000') fail('deepseek-harness must be tracked as a Git submodule')
if (object !== activeUpstream.commit) fail(`submodule index is ${object}, expected ${activeUpstream.commit}`)

const upstreamDir = resolve(root, 'deepseek-harness')
if (run('git', ['rev-parse', 'HEAD'], upstreamDir) !== activeUpstream.commit) {
  fail('checked-out upstream commit differs from upstream.json')
}
if (run('git', ['status', '--porcelain'], upstreamDir) !== '') {
  fail('deepseek-harness contains local changes')
}
if (run('git', ['remote', 'get-url', 'origin'], upstreamDir) !== upstream.repository) {
  fail('deepseek-harness origin differs from upstream.json')
}
if (upstreamPackage.version !== activeUpstream.sourceVersion) {
  fail('deepseek-harness package version differs from upstream.json')
}
const metadata = upstream.channels?.[upstream.activeChannel]
if (metadata?.package !== desktopPlugin.name) {
  fail(`${upstream.activeChannel} upstream metadata points at the wrong package`)
}
for (const name of Object.keys(desktopPlugin.dependencies).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))) {
  if (desktopPlugin.dependencies[name] !== metadata.runtimePackageVersion) {
    fail(`${desktopPlugin.name} ${name} must use the recorded ${upstream.activeChannel} DSH runtime package family`)
  }
}

process.stdout.write(`verify-layout: the Desktop workspace and upstream ${activeUpstream.commit.slice(0, 10)} are consistent\n`)
