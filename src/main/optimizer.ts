import { app, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join, parse } from 'path'
import os from 'os'
import type {
  AppSettings,
  AppSnapshot,
  ApplyNvidiaProfileRequest,
  CleanResult,
  CleanTarget,
  CommandLogEntry,
  FeatureToggle,
  InstalledApp,
  LeftoverCandidate,
  LeftoverRemovalResult,
  NvidiaProfile,
  NvidiaState,
  OperationProgress,
  RestoreEntry,
  ScheduledTaskRow,
  SystemInfo,
  UninstallLaunchResult
} from '../shared/types'

interface CleanEstimate {
  bytes: number
  partial: boolean
  files: number
}

interface CommandOptions {
  kind: CommandLogEntry['kind']
  label: string
  dryRun?: boolean
  elevated?: boolean
  timeoutMs?: number
}

interface TaskVerification {
  matches: boolean
  found: boolean
  enabled: boolean | null
  state: string
  source: string
  stdout: string
  stderr: string
}

const defaultSettings: AppSettings = {
  preferredResolution: '2560x1440',
  lastTab: 'tasks'
}

const criticalTaskHints = [
  '\\Microsoft\\Windows\\Defrag',
  '\\Microsoft\\Windows\\Windows Defender',
  '\\Microsoft\\Windows\\UpdateOrchestrator',
  '\\Microsoft\\Windows\\WaaSMedic',
  '\\Microsoft\\Windows\\Servicing',
  '\\Microsoft\\Windows\\BitLocker',
  '\\Microsoft\\Windows\\Security'
]

export class OptimizerService {
  private readonly dataDir: string
  private readonly logFile: string
  private readonly restoreFile: string
  private readonly settingsFile: string
  private logs: CommandLogEntry[] = []
  private restoreHistory: RestoreEntry[] = []
  private settings: AppSettings = defaultSettings
  private installedApps = new Map<string, InstalledApp>()
  private uninstallLeftovers = new Map<string, LeftoverCandidate>()

  constructor() {
    this.dataDir = join(app.getPath('userData'), 'optimizer-guard')
    this.logFile = join(this.dataDir, 'actions.json')
    this.restoreFile = join(this.dataDir, 'restore-history.json')
    this.settingsFile = join(this.dataDir, 'settings.json')
    mkdirSync(this.dataDir, { recursive: true })
    this.logs = this.readJson<CommandLogEntry[]>(this.logFile, [])
    this.restoreHistory = this.readJson<RestoreEntry[]>(this.restoreFile, [])
    this.settings = { ...defaultSettings, ...this.readJson<Partial<AppSettings>>(this.settingsFile, {}) }
  }

  getSettings(): AppSettings {
    return this.settings
  }

  saveSettings(settings: AppSettings): AppSettings {
    this.settings = settings
    this.writeJson(this.settingsFile, settings)
    return settings
  }

  getSnapshot(): AppSnapshot {
    return {
      settings: this.settings,
      logs: this.logs.slice(-300).reverse(),
      restoreHistory: this.restoreHistory.slice(-200).reverse()
    }
  }

  getLogPath(): string {
    return this.logFile
  }

  async openLogPath(): Promise<void> {
    await shell.showItemInFolder(this.logFile)
  }

  async isAdmin(): Promise<boolean> {
    const result = await this.runCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
      ],
      { kind: 'system', label: 'Check administrator state' }
    )
    return result.stdout.trim().toLowerCase().includes('true')
  }

  async queryTasks(): Promise<ScheduledTaskRow[]> {
    const exactRows = await this.queryTasksPowerShellFallback('primary exact task state')
    if (exactRows.length > 0) return exactRows

    const result = await this.runCommand('schtasks.exe', ['/query', '/fo', 'CSV', '/v'], {
      kind: 'task',
      label: 'Query scheduled tasks'
    })
    if (!result.success) return this.queryTasksPowerShellFallback('schtasks failed')
    const byPath = new Map<string, ScheduledTaskRow>()
    for (const row of parseCsv(result.stdout)) {
      const taskName = pick(row, 'TaskName', 'Task Name')
      if (!taskName || byPath.has(taskName)) continue
      const scheduledState = pick(row, 'Scheduled Task State') || pick(row, 'Status')
      const runtimeStatus = pick(row, 'Status')
      const normalizedState = normalizeStatus(scheduledState)
      const enabled = !['disabled', 'desactive'].includes(normalizedState)
      const status = enabled && normalizeStatus(runtimeStatus).includes('running') ? runtimeStatus : scheduledState
      const microsoft = taskName.toLowerCase().startsWith('\\microsoft\\')
      const critical = criticalTaskHints.some((hint) => taskName.toLowerCase().startsWith(hint.toLowerCase()))
      const split = taskName.lastIndexOf('\\')
      byPath.set(taskName, {
        name: split >= 0 ? taskName.slice(split + 1) : taskName,
        path: taskName,
        status,
        nextRun: pick(row, 'Next Run Time', 'Next Run'),
        lastRun: pick(row, 'Last Run Time', 'Last Run'),
        author: pick(row, 'Author'),
        taskToRun: pick(row, 'Task To Run'),
        enabled,
        microsoft,
        critical
      })
    }
    const parsed = [...byPath.values()]
    if (parsed.length > 0) return parsed
    const positional = parseSchtasksCsvByPosition(result.stdout)
    if (positional.length > 0) {
      this.addLog({
        kind: 'task',
        label: 'Parsed scheduled tasks by CSV column position',
        command: 'internal',
        args: ['schtasks CSV fallback'],
        stdout: `Parsed ${positional.length} tasks without relying on localized CSV headers.`,
        stderr: '',
        exitCode: 0,
        success: true,
        dryRun: false,
        elevated: false
      })
      return positional
    }
    return this.queryTasksPowerShellFallback('schtasks CSV parser returned 0 tasks')
  }

  private async queryTasksPowerShellFallback(reason: string): Promise<ScheduledTaskRow[]> {
    const result = await this.runPowerShell(scheduledTasksFallbackScript(), {
      kind: 'task',
      label: `Query scheduled tasks fallback (${reason})`
    })
    if (!result.success || !result.stdout.trim()) return []
    try {
      const parsed = JSON.parse(result.stdout.trim()) as Array<{
        name?: string
        path?: string
        status?: string
        nextRun?: string
        lastRun?: string
        author?: string
        taskToRun?: string
        enabled?: boolean
      }>
      return parsed.map((task) => {
        const path = String(task.path ?? '')
        const microsoft = path.toLowerCase().startsWith('\\microsoft\\')
        const critical = criticalTaskHints.some((hint) => path.toLowerCase().startsWith(hint.toLowerCase()))
        return {
          name: String(task.name ?? path.split('\\').filter(Boolean).at(-1) ?? 'Unknown task'),
          path,
          status: String(task.status ?? 'Unknown'),
          nextRun: String(task.nextRun ?? ''),
          lastRun: String(task.lastRun ?? ''),
          author: String(task.author ?? ''),
          taskToRun: String(task.taskToRun ?? ''),
          enabled: Boolean(task.enabled),
          microsoft,
          critical
        }
      }).filter((task) => task.path)
    } catch {
      return []
    }
  }

  async setTaskState(taskPath: string, enable: boolean, dryRun: boolean): Promise<CommandLogEntry> {
    const normalizedTaskPath = normalizeTaskPath(taskPath)
    const args = ['/Change', '/TN', normalizedTaskPath, enable ? '/Enable' : '/Disable']
    if (!enable) {
      await this.runCommand('schtasks.exe', ['/End', '/TN', normalizedTaskPath], {
        kind: 'task',
        label: `Stop running scheduled task ${normalizedTaskPath}`,
        dryRun
      })
    }

    let log = await this.runCommand('schtasks.exe', args, {
      kind: 'task',
      label: `${enable ? 'Enable' : 'Disable'} scheduled task ${normalizedTaskPath}`,
      dryRun
    })

    let verification = await this.verifyTaskState(normalizedTaskPath, enable)
    if (!log.success || !verification.matches) {
      const script = taskStateScript(normalizedTaskPath, enable)
      log = await this.runPowerShell(script, {
        kind: 'task',
        label: `${enable ? 'Enable' : 'Disable'} scheduled task ${normalizedTaskPath} via ScheduledTasks`,
        dryRun
      })
      verification = await this.verifyTaskState(normalizedTaskPath, enable)
    }

    if (!log.success || !verification.matches) {
      const elevatedScript = taskStateScript(normalizedTaskPath, enable)
      log = await this.runElevatedPowerShell(elevatedScript, `${enable ? 'Enable' : 'Disable'} scheduled task ${normalizedTaskPath}`, dryRun, 'task')
      verification = await this.verifyTaskState(normalizedTaskPath, enable)
    }

    if (log.success && !verification.matches) {
      log = this.addLog({
        kind: 'task',
        label: `Verify scheduled task ${normalizedTaskPath}`,
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', taskStateQueryScript(normalizedTaskPath)],
        stdout: [
          `Expected task to be ${enable ? 'enabled' : 'disabled'}, but Windows reported ${verification.found ? verification.state : 'not found'}.`,
          `Verification source: ${verification.source}.`,
          verification.enabled === null ? 'Detected enabled: unknown.' : `Detected enabled: ${verification.enabled}.`,
          'Last action stdout:',
          log.stdout || '(empty)'
        ].join('\n'),
        stderr: [
          verification.stderr,
          'Last action stderr:',
          log.stderr || '(empty)',
          updaterTaskHint(normalizedTaskPath)
        ]
          .filter(Boolean)
          .join('\n'),
        exitCode: 1,
        success: false,
        dryRun: false,
        elevated: log.elevated
      })
    }

    if (log.success && !dryRun) {
      const restoreScript = taskStateScript(normalizedTaskPath, !enable)
      this.addRestore({
        kind: 'task',
        label: `Undo: ${enable ? 'disable' : 're-enable'} ${normalizedTaskPath}`,
        command: log.elevated ? 'powershell.exe' : 'schtasks.exe',
        args: log.elevated
          ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', restoreScript]
          : ['/Change', '/TN', normalizedTaskPath, enable ? '/Disable' : '/Enable'],
        elevated: log.elevated
      })
    }
    return log
  }

  private async verifyTaskState(taskPath: string, enabled: boolean): Promise<TaskVerification> {
    const normalizedTaskPath = normalizeTaskPath(taskPath)
    const result = await this.runPowerShell(taskStateQueryScript(normalizedTaskPath), {
      kind: 'task',
      label: `Verify exact scheduled task ${normalizedTaskPath}`
    })

    try {
      const parsed = JSON.parse(result.stdout.trim()) as { found?: boolean; enabled?: boolean | null; state?: string; source?: string }
      const detectedEnabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : null
      return {
        matches: detectedEnabled === enabled,
        found: Boolean(parsed.found),
        enabled: detectedEnabled,
        state: String(parsed.state ?? 'Unknown'),
        source: String(parsed.source ?? 'Get-ScheduledTask'),
        stdout: result.stdout,
        stderr: result.stderr
      }
    } catch {
      const tasks = await this.queryTasks()
      const task = tasks.find((item) => normalizeTaskPath(item.path).toLowerCase() === normalizedTaskPath.toLowerCase())
      const detectedEnabled = task ? task.enabled : null
      return {
        matches: detectedEnabled === enabled,
        found: Boolean(task),
        enabled: detectedEnabled,
        state: task?.status ?? 'Unknown',
        source: 'task table fallback',
        stdout: result.stdout,
        stderr: [result.stderr, 'Unable to parse exact task verification JSON.'].filter(Boolean).join('\n')
      }
    }
  }

  async queryFeatures(): Promise<FeatureToggle[]> {
    const script = hyperVStateScript()
    const result = await this.runPowerShell(script, { kind: 'system', label: 'Query Hyper-V optional feature' })
    const state = result.stdout.trim() || 'Unknown'
    return [
      {
        id: 'hyperv',
        label: 'Hyper-V',
        featureName: 'Microsoft-Hyper-V-All',
        state,
        restartLikely: true,
        description: 'Windows hypervisor platform. Disabling can help some anti-cheat/game latency setups, but affects VMs, WSL2, emulators, and Docker.'
      }
    ]
  }

  async setFeature(featureName: string, enable: boolean, dryRun: boolean): Promise<CommandLogEntry> {
    const verb = enable ? 'Enable-WindowsOptionalFeature' : 'Disable-WindowsOptionalFeature'
    const script = `${verb} -Online -FeatureName '${escapePowerShellSingle(featureName)}' -NoRestart`
    const log = await this.runElevatedPowerShell(script, `${enable ? 'Enable' : 'Disable'} ${featureName}`, dryRun, 'feature')
    if (log.success && !dryRun) {
      this.addRestore({
        kind: 'feature',
        label: `Undo: ${enable ? 'disable' : 're-enable'} ${featureName}`,
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `${enable ? 'Disable' : 'Enable'}-WindowsOptionalFeature -Online -FeatureName '${featureName}' -NoRestart`
        ],
        elevated: true
      })
    }
    return log
  }

  async querySystemInfo(): Promise<SystemInfo> {
    const [admin, cim, gpu, resizable, perCore] = await Promise.all([
      this.isAdmin(),
      this.runPowerShellJson(systemInfoScript(), 'Read system hardware information'),
      this.queryNvidiaQuery(),
      this.queryResizableBar(),
      this.queryPerCoreUsage()
    ])

    const cpuName = String(cim?.cpu?.Name ?? os.cpus()[0]?.model ?? 'Unknown CPU')
    const displays = Array.isArray(cim?.displays) ? cim.displays.map(normalizeDisplay) : []
    return {
      isAdmin: admin,
      biosVendor: String(cim?.bios?.Manufacturer ?? 'Unknown'),
      biosVersion: String(cim?.bios?.SMBIOSBIOSVersion ?? cim?.bios?.Name ?? 'Unknown'),
      biosDate: formatWmiDate(String(cim?.bios?.ReleaseDate ?? '')),
      motherboardManufacturer: String(cim?.board?.Manufacturer ?? 'Unknown'),
      motherboardModel: String(cim?.board?.Product ?? 'Unknown'),
      memoryGb: numberOrNull(cim?.memoryGb),
      cpu: {
        name: cpuName,
        cores: Number(cim?.cpu?.NumberOfCores ?? os.cpus().length),
        threads: Number(cim?.cpu?.NumberOfLogicalProcessors ?? os.cpus().length),
        baseClockMhz: numberOrNull(cim?.cpu?.CurrentClockSpeed),
        maxClockMhz: numberOrNull(cim?.cpu?.MaxClockSpeed),
        currentClockMhz: numberOrNull(cim?.cpu?.CurrentClockSpeed),
        usagePercent: numberOrNull(cim?.cpuLoad),
        perCoreUsage: perCore,
        overclockNote: detectOverclockable(cpuName, String(cim?.board?.Manufacturer ?? ''))
      },
      gpu: {
        name: gpu.name || String(cim?.gpu?.Name ?? 'Unknown GPU'),
        vramMb: gpu.vramMb ?? numberOrNull(cim?.gpu?.AdapterRAM ? Math.round(Number(cim.gpu.AdapterRAM) / 1024 / 1024) : null),
        driverVersion: gpu.driverVersion || String(cim?.gpu?.DriverVersion ?? 'Unknown'),
        usagePercent: gpu.usagePercent,
        temperatureC: gpu.temperatureC,
        graphicsClockMhz: gpu.graphicsClockMhz,
        memoryClockMhz: gpu.memoryClockMhz,
        maxGraphicsClockMhz: gpu.maxGraphicsClockMhz,
        resizableBar: resizable,
        frameGeneration: detectFrameGeneration(gpu.name || String(cim?.gpu?.Name ?? ''))
      },
      displays,
      powerPlan: String(cim?.powerPlan ?? 'Unknown'),
      gameMode: registryDwordToState(cim?.gameMode),
      hags: hagsStateFromRegistry(cim?.hags)
    }
  }

  async scanCleaningTargets(progress?: (progress: OperationProgress) => void): Promise<CleanTarget[]> {
    progress?.({ operation: 'clean-scan', current: 0, total: 1, label: 'Checking safe cleanup locations...', state: 'running' })
    try {
      const result = await this.buildCleanTargets(this.getCleanDefinitions())
      progress?.({ operation: 'clean-scan', current: 1, total: 1, label: 'Scan finished', state: 'finished' })
      return result
    } catch (error) {
      progress?.({ operation: 'clean-scan', current: 1, total: 1, label: 'Scan failed', state: 'failed' })
      throw error
    }
  }

  private async buildCleanTargets(targets: CleanTarget[]): Promise<CleanTarget[]> {
    const estimates = await this.estimateTargets(targets.filter((target) => !target.commandOnly))
    return targets.map((target) => {
      const estimate = estimates[target.id]
      const estimatedBytes = target.commandOnly ? 0 : estimate?.bytes ?? 0
      return {
        ...target,
        estimatedBytes,
        detected: target.commandOnly ? true : estimatedBytes > 0 || Boolean(estimate?.partial),
        scanNote: estimate?.partial ? `Fast scan capped after ${estimate.files.toLocaleString()} files. Size is approximate.` : undefined
      }
    })
  }

  async cleanTargets(ids: string[], dryRun: boolean, progress?: (progress: OperationProgress) => void): Promise<CleanResult> {
    const definitions = this.getCleanDefinitions().filter((target) => ids.includes(target.id))
    const total = Math.max(1, definitions.length + 2)
    try {
      progress?.({ operation: 'clean-run', current: 0, total, label: 'Measuring selected targets...', state: 'running' })
      const targets = await this.buildCleanTargets(definitions)
      const beforeBytes = targets.reduce((sum, target) => sum + target.estimatedBytes, 0)
      const logs: CommandLogEntry[] = []

      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index]
        progress?.({ operation: 'clean-run', current: index + 1, total, label: `Cleaning ${target.label}...`, state: 'running' })
        if (target.commandOnly) {
          logs.push(await this.runCleaningCommand(target, dryRun))
        } else {
          const expandedPaths = target.paths.map(expandEnv)
          const script = safeDeleteScript(expandedPaths)
          const run = target.requiresAdmin
            ? await this.runElevatedPowerShell(script, `Clean ${target.label}`, dryRun, 'clean', 180_000)
            : await this.runPowerShell(script, { kind: 'clean', label: `Clean ${target.label}`, dryRun, timeoutMs: 120_000 })
          logs.push(run)
        }
      }

      progress?.({ operation: 'clean-run', current: total - 1, total, label: 'Measuring freed space...', state: 'running' })
      const afterTargets = await this.buildCleanTargets(definitions)
      const afterBytes = afterTargets.reduce((sum, target) => sum + target.estimatedBytes, 0)
      const failed = logs.filter((log) => !log.success)
      progress?.({
        operation: 'clean-run',
        current: total,
        total,
        label: failed.length ? `Cleanup finished with ${failed.length} failed target${failed.length === 1 ? '' : 's'}` : 'Cleanup finished',
        state: failed.length ? 'failed' : 'finished'
      })
      return { beforeBytes, afterBytes, savedBytes: Math.max(0, beforeBytes - afterBytes), logs, targets: afterTargets }
    } catch (error) {
      progress?.({ operation: 'clean-run', current: total, total, label: 'Cleanup stopped with an error', state: 'failed' })
      throw error
    }
  }

  async queryInstalledApps(): Promise<InstalledApp[]> {
    const result = await this.runPowerShell(installedAppsScript(), {
      kind: 'uninstall',
      label: 'Query installed applications',
      timeoutMs: 45_000
    })
    if (!result.success || !result.stdout.trim()) return []
    try {
      const parsed = JSON.parse(result.stdout.trim())
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>
      this.installedApps.clear()
      return rows
        .map((row) => {
          const app: InstalledApp = {
            id: cryptoId(),
            name: String(row.name ?? '').trim(),
            publisher: String(row.publisher ?? '').trim(),
            version: String(row.version ?? '').trim(),
            installDate: formatInstallDate(String(row.installDate ?? '')),
            installLocation: String(row.installLocation ?? '').trim(),
            uninstallString: String(row.uninstallString ?? '').trim(),
            quietUninstallString: String(row.quietUninstallString ?? '').trim(),
            estimatedSizeBytes: Math.max(0, Number(row.estimatedSizeKb ?? 0) * 1024),
            registryPath: String(row.registryPath ?? '').replace(/^Microsoft\.PowerShell\.Core\\Registry::/i, ''),
            systemComponent: Number(row.systemComponent ?? 0) === 1
          }
          this.installedApps.set(app.id, app)
          return app
        })
        .filter((item) => item.name && item.uninstallString && !item.systemComponent)
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }

  async launchUninstaller(appId: string): Promise<UninstallLaunchResult> {
    const installedApp = this.installedApps.get(appId)
    if (!installedApp) throw new Error('This application record is stale. Refresh the installed app list and try again.')
    const command = parseUninstallCommand(installedApp.uninstallString)
    if (!command) throw new Error('Windows did not provide a usable uninstall command for this application.')
    const expandedExecutable = expandEnv(command.executable)
    const executable = expandedExecutable.toLowerCase().endsWith('msiexec.exe') ? 'msiexec.exe' : expandedExecutable
    const args = executable.toLowerCase().endsWith('msiexec.exe')
      ? command.args.map((arg) => (/^\/i(?=\{)/i.test(arg) ? arg.replace(/^\/i/i, '/x') : arg))
      : command.args
    const argumentLine = args.map(quoteWindowsArgument).join(' ')
    const script = [
      `$file = '${escapePowerShellSingle(executable)}'`,
      `$argumentLine = '${escapePowerShellSingle(argumentLine)}'`,
      "Start-Process -FilePath $file -ArgumentList $argumentLine -Verb RunAs",
      `'Launched registered uninstaller for ${escapePowerShellSingle(installedApp.name)}.'`
    ].join('\n')
    const log = await this.runPowerShell(script, {
      kind: 'uninstall',
      label: `Launch uninstaller for ${installedApp.name}`,
      timeoutMs: 30_000
    })
    return { app: installedApp, log }
  }

  async scanUninstallLeftovers(appId: string, progress?: (progress: OperationProgress) => void): Promise<LeftoverCandidate[]> {
    const installedApp = this.installedApps.get(appId)
    if (!installedApp) throw new Error('Refresh the installed app list before scanning leftovers.')
    progress?.({ operation: 'uninstall-scan', current: 0, total: 1, label: `Scanning leftovers for ${installedApp.name}...`, state: 'running' })
    const definitions = buildLeftoverDefinitions(installedApp)
    const fileDefinitions = definitions.filter((item) => item.kind === 'file')
    const registryDefinitions = definitions.filter((item) => item.kind === 'registry')
    const estimateJson = JSON.stringify(fileDefinitions.map((item) => ({ id: item.id, paths: [item.path] })))
    const estimates = fileDefinitions.length > 0 ? await this.estimateArbitraryTargets(estimateJson) : {}
    const existingRegistryIds = await this.findExistingRegistryCandidates(registryDefinitions)
    this.uninstallLeftovers.clear()
    const candidates = definitions
      .filter((item) => item.kind === 'registry' ? existingRegistryIds.has(item.id) : Boolean(estimates[item.id]?.exists))
      .map((item) => ({
        ...item,
        sizeBytes: item.kind === 'file' ? Number(estimates[item.id]?.bytes ?? 0) : 0
      }))
    for (const candidate of candidates) this.uninstallLeftovers.set(candidate.id, candidate)
    progress?.({ operation: 'uninstall-scan', current: 1, total: 1, label: `Found ${candidates.length} reviewable leftovers`, state: 'finished' })
    return candidates
  }

  private async findExistingRegistryCandidates(candidates: LeftoverCandidate[]): Promise<Set<string>> {
    if (candidates.length === 0) return new Set()
    const payload = JSON.stringify(candidates.map((item) => ({ id: item.id, path: item.path })))
    const script = `
$itemsJson = @'
${payload}
'@
$items = $itemsJson | ConvertFrom-Json
$found = foreach ($item in $items) {
  if (Test-Path -LiteralPath ('Registry::' + $item.path)) { [string]$item.id }
}
@($found) | ConvertTo-Json -Compress
`
    const result = await this.runPowerShell(script, {
      kind: 'uninstall',
      label: 'Check uninstall registry leftovers',
      timeoutMs: 15_000
    })
    if (!result.success || !result.stdout.trim()) return new Set()
    try {
      const parsed = JSON.parse(result.stdout.trim())
      return new Set((Array.isArray(parsed) ? parsed : [parsed]).map(String))
    } catch {
      return new Set()
    }
  }

  async removeUninstallLeftovers(ids: string[], progress?: (progress: OperationProgress) => void): Promise<LeftoverRemovalResult> {
    const candidates = ids.map((id) => this.uninstallLeftovers.get(id)).filter((item): item is LeftoverCandidate => Boolean(item))
    if (candidates.length === 0) return { removed: 0, failed: 0, quarantinedBytes: 0, logs: [] }
    if (candidates.some((item) => item.protected)) throw new Error('Protected personal-data candidates cannot be removed by Optimizer Guard.')
    const quarantine = join(this.dataDir, 'uninstall-quarantine', new Date().toISOString().replace(/[:.]/g, '-'))
    const payload = JSON.stringify(candidates.map((item) => ({ ...item, quarantineName: `${item.id}-${safeFileName(item.path.split('\\').pop() || 'leftover')}` })))
    progress?.({ operation: 'uninstall-remove', current: 0, total: 1, label: 'Quarantining selected leftovers...', state: 'running' })
    const script = uninstallLeftoverRemovalScript(payload, quarantine)
    const requiresAdmin = candidates.some((item) => item.path.startsWith('HKEY_LOCAL_MACHINE') || isAdminPath(item.path))
    const log = requiresAdmin
      ? await this.runElevatedPowerShell(script, 'Quarantine uninstall leftovers', false, 'uninstall', 180_000)
      : await this.runPowerShell(script, { kind: 'uninstall', label: 'Quarantine uninstall leftovers', timeoutMs: 180_000 })
    let summary = { removed: 0, failed: candidates.length, quarantinedBytes: 0 }
    try {
      const parsed = JSON.parse(log.stdout.trim())
      summary = {
        removed: Number(parsed.removed ?? 0),
        failed: Number(parsed.failed ?? 0),
        quarantinedBytes: Number(parsed.quarantinedBytes ?? 0)
      }
    } catch {}
    if (log.success && summary.removed > 0) {
      this.addRestore({
        kind: 'registry',
        label: `Restore quarantined leftovers from ${quarantine}`,
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', uninstallLeftoverRestoreScript(quarantine)],
        elevated: requiresAdmin
      })
    }
    progress?.({
      operation: 'uninstall-remove',
      current: 1,
      total: 1,
      label: log.success ? 'Leftover cleanup finished' : 'Leftover cleanup failed',
      state: log.success ? 'finished' : 'failed'
    })
    return { ...summary, logs: [log] }
  }

  async queryNvidiaState(): Promise<NvidiaState> {
    const system = await this.querySystemInfo()
    const primary = system.displays.find((display) => display.primary) ?? system.displays[0]
    const width = primary?.width || 2560
    const height = primary?.height || 1440
    const detectedResolution = `${width}x${height}`
    const savedProfile = this.settings.nvidiaProfile ?? {}
    const preferredResolution = savedProfile.preferredResolution || this.settings.preferredResolution || detectedResolution
    const recommendedProfile: NvidiaProfile = {
      gpuName: system.gpu.name,
      driverVersion: system.gpu.driverVersion,
      detectedResolution,
      preferredResolution,
      dlssMode: recommendDlss(width, height),
      dlssPreset: 'Transformer if available',
      reflex: 'On + Boost',
      frameGeneration: system.gpu.frameGeneration === 'Supported' ? 'On if supported' : 'Off',
      useCase: 'Balanced',
      notes: [
        '1440p usually wants DLSS Quality for visuals or Balanced when FPS is weak.',
        'RTX 30-series supports DLSS Super Resolution and Reflex, but not DLSS 3 Frame Generation.',
        'Preset letters are suggestions for tools such as NVIDIA Profile Inspector; the app will not force-edit game files.'
      ]
    }
    const profile: NvidiaProfile = {
      ...recommendedProfile,
      ...savedProfile,
      gpuName: system.gpu.name,
      driverVersion: system.gpu.driverVersion,
      detectedResolution,
      preferredResolution
    }
    const patchStatus = await this.inspectNvidiaPatchStatus(preferredResolution)
    const tweakState = await this.queryGamingTweaksState()
    return {
      profile,
      actions: [
        {
          id: 'patch-nvidia-resolution',
          label: 'Patch NVIDIA App recommendation resolution',
          description: 'Backs up NVIDIA App game metadata and replaces 3840x2160 recommendations with your preferred resolution where safe.',
          requiresAdmin: false,
          dangerous: false,
          status: patchStatus.folderFound
            ? patchStatus.unpatched4kFiles > 0
              ? `${patchStatus.unpatched4kFiles} metadata files still contain 3840x2160.`
              : patchStatus.patchedFiles > 0
                ? `${patchStatus.patchedFiles} metadata files already target ${patchStatus.targetResolution}.`
                : 'No NVIDIA App game metadata with resolution entries found.'
            : 'NVIDIA App metadata folder was not found.'
        },
        {
          id: 'disable-overlay',
          label: 'Disable NVIDIA overlay',
          description: 'Turns off common NVIDIA Share/In-game overlay registry flags and stops overlay helper processes if they are running.',
          requiresAdmin: false,
          dangerous: false,
          status: tweakState.overlayDisabled ? 'Overlay registry flags are already disabled.' : 'Overlay appears enabled or unset.'
        },
        {
          id: 'game-mode',
          label: 'Enable Game Mode',
          description: 'Enables Windows Game Mode for foreground game prioritization.',
          requiresAdmin: false,
          dangerous: false,
          status: system.gameMode === 'Enabled' ? 'Game Mode is already enabled.' : `Game Mode is ${system.gameMode.toLowerCase()}.`
        },
        {
          id: 'disable-game-dvr',
          label: 'Disable Xbox Game DVR capture',
          description: 'Disables background recording/Game DVR registry flags. This is reversible from Windows settings.',
          requiresAdmin: false,
          dangerous: false,
          status: tweakState.gameDvrDisabled ? 'Game DVR capture is already disabled.' : 'Game DVR capture appears enabled or unset.'
        },
        {
          id: 'disable-delivery-optimization',
          label: 'Disable Delivery Optimization',
          description: 'Sets HKLM\\SYSTEM\\CurrentControlSet\\Services\\DoSvc\\Start to 4 and stops DoSvc. This can reduce background network/disk activity, but may affect Microsoft Store and Windows update delivery behavior.',
          requiresAdmin: true,
          dangerous: false,
          status: tweakState.deliveryOptimizationDisabled
            ? `Delivery Optimization is already disabled (Start=${tweakState.deliveryOptimizationStart ?? 'unknown'}).`
            : `Delivery Optimization Start=${tweakState.deliveryOptimizationStart ?? 'unknown'}, service ${tweakState.deliveryOptimizationStatus}.`
        }
      ],
      patchStatus
    }
  }

  async applyNvidiaProfile(request: ApplyNvidiaProfileRequest, dryRun: boolean): Promise<CommandLogEntry[]> {
    this.settings = { ...this.settings, preferredResolution: request.profile.preferredResolution, nvidiaProfile: request.profile }
    this.writeJson(this.settingsFile, this.settings)

    const logs: CommandLogEntry[] = [
      this.addLog({
        kind: 'nvidia',
        label: 'Save NVIDIA/DLSS optimizer profile',
        command: 'internal',
        args: [request.profile.dlssMode, request.profile.dlssPreset, request.profile.reflex, request.profile.useCase],
        stdout: JSON.stringify(request.profile, null, 2),
        stderr: '',
        exitCode: 0,
        success: true,
        dryRun,
        elevated: false
      })
    ]

    if (request.disableOverlay) {
      logs.push(await this.runPowerShell(disableNvidiaOverlayScript(), { kind: 'nvidia', label: 'Disable NVIDIA overlay', dryRun }))
    }
    if (request.setGameMode) {
      logs.push(await this.runPowerShell(setGameModeScript(), { kind: 'nvidia', label: 'Enable Windows Game Mode', dryRun }))
    }
    if (request.disableGameDvr) {
      logs.push(await this.runPowerShell(disableGameDvrScript(), { kind: 'nvidia', label: 'Disable Xbox Game DVR', dryRun }))
    }
    if (request.disableDeliveryOptimization) {
      logs.push(await this.disableDeliveryOptimization(dryRun))
    }
    if (request.patchNvidiaAppResolution) {
      logs.push(await this.patchNvidiaAppResolution(request.profile.preferredResolution, dryRun))
    }
    return logs
  }

  async restore(id: string, dryRun: boolean): Promise<CommandLogEntry | null> {
    const entry = this.restoreHistory.find((item) => item.id === id)
    if (!entry) return null
    const log = entry.elevated
      ? await this.runElevatedPowerShell(entry.args.at(-1) ?? '', `Restore ${entry.label}`, dryRun, 'restore')
      : await this.runCommand(entry.command, entry.args, { kind: 'restore', label: `Restore ${entry.label}`, dryRun })
    if (log.success && !dryRun) {
      entry.applied = true
      this.writeJson(this.restoreFile, this.restoreHistory)
    }
    return log
  }

  exportSnapshot(): string {
    const file = join(this.dataDir, `optimizer-guard-export-${Date.now()}.json`)
    this.writeJson(file, this.getSnapshot())
    return file
  }

  private async runCleaningCommand(target: CleanTarget, dryRun: boolean): Promise<CommandLogEntry> {
    if (target.id === 'dism-component-store') {
      return this.runElevatedPowerShell('DISM /Online /Cleanup-Image /StartComponentCleanup', 'DISM component store cleanup', dryRun, 'clean', 15 * 60_000)
    }
    if (target.id === 'cleanmgr') {
      return this.runCommand('cleanmgr.exe', ['/sagerun:1'], {
        kind: 'clean',
        label: 'Run Disk Cleanup profile 1',
        dryRun,
        timeoutMs: 10 * 60_000
      })
    }
    if (target.id === 'cleanmgr-sageset') {
      return this.runCommand('cleanmgr.exe', ['/sageset:1'], {
        kind: 'clean',
        label: 'Open Disk Cleanup sageset UI',
        dryRun,
        timeoutMs: 30_000
      })
    }
    if (target.id === 'recycle-bin') {
      return this.runPowerShell('Clear-RecycleBin -Force -ErrorAction SilentlyContinue; "Recycle Bin emptied."', {
        kind: 'clean',
        label: 'Empty Recycle Bin',
        dryRun
      })
    }
    if (target.id === 'branch-cache') {
      return this.runElevatedPowerShell('Clear-BCCache -Force -ErrorAction SilentlyContinue; "BranchCache cleared."', 'Clear BranchCache', dryRun, 'clean', 120_000)
    }
    if (target.id === 'store-cache') {
      return this.runCommand('wsreset.exe', [], { kind: 'clean', label: 'Reset Microsoft Store cache', dryRun, timeoutMs: 120_000 })
    }
    if (target.id === 'dns-cache') {
      return this.runCommand('ipconfig.exe', ['/flushdns'], { kind: 'clean', label: 'Flush DNS cache', dryRun })
    }
    return this.addLog({
      kind: 'clean',
      label: `No command mapped for ${target.label}`,
      command: 'internal',
      args: [],
      stdout: 'Skipped: no safe command mapped.',
      stderr: '',
      exitCode: 0,
      success: true,
      dryRun,
      elevated: false
    })
  }

  private async patchNvidiaAppResolution(preferredResolution: string, dryRun: boolean): Promise<CommandLogEntry> {
    const [width, height] = preferredResolution.split('x').map((part) => Number(part.trim()))
    const script = patchNvidiaResolutionScript(width || 2560, height || 1440, join(this.dataDir, 'nvidia-app-backups'))
    return this.runPowerShell(script, { kind: 'nvidia', label: `Patch NVIDIA App metadata to ${preferredResolution}`, dryRun })
  }

  private getCleanDefinitions(): CleanTarget[] {
    const user = os.userInfo().username
    const steam = ['%ProgramFiles(x86)%\\Steam', '%ProgramFiles%\\Steam', '%LOCALAPPDATA%\\Steam']
    return [
      target('windows-temp', 'Windows temp files', 'System temporary files under Windows\\Temp.', ['%WINDIR%\\Temp\\*'], false, true),
      target('user-temp', 'User temp files', 'Your user temp folder only. This never touches Documents, Desktop, Downloads, media, or saves.', ['%TEMP%\\*'], true, false),
      commandTarget('recycle-bin', 'Recycle Bin', 'Empties the Recycle Bin with the Windows Clear-RecycleBin command.', false, true),
      target('delivery-cache', 'Delivery Optimization cache', 'Windows update peer/cache files.', ['%ProgramData%\\Microsoft\\Windows\\DeliveryOptimization\\Cache\\*'], false, true),
      target('windows-update-downloads', 'Windows Update download cache', 'Downloaded update payload cache. Windows can download needed files again.', ['%WINDIR%\\SoftwareDistribution\\Download\\*'], false, true),
      target('directx-cache', 'DirectX shader cache', 'DirectX shader cache that games can rebuild.', ['%LOCALAPPDATA%\\D3DSCache\\*', '%LOCALAPPDATA%\\Microsoft\\DirectX Shader Cache\\*'], true, false),
      target('gpu-shader-cache', 'NVIDIA/AMD shader cache', 'Detected GPU driver shader caches. Games rebuild these after launch.', ['%LOCALAPPDATA%\\NVIDIA\\DXCache\\*', '%LOCALAPPDATA%\\NVIDIA\\GLCache\\*', '%ProgramData%\\NVIDIA Corporation\\NV_Cache\\*', '%LOCALAPPDATA%\\AMD\\DxCache\\*'], true, false),
      target('thumbnail-cache', 'Thumbnail cache', 'Windows Explorer thumbnail database files.', ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer\\thumbcache_*.db'], true, false),
      target('icon-cache', 'Icon cache', 'Windows Explorer icon cache files. Explorer may rebuild icons after cleanup.', ['%LOCALAPPDATA%\\IconCache.db', '%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer\\iconcache_*.db'], true, false),
      target('wer', 'Windows error reports', 'Windows Error Reporting archives and queues.', ['%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\*', '%ProgramData%\\Microsoft\\Windows\\WER\\*'], true, false),
      target('crash-dumps', 'Crash dumps/minidumps', 'User crash dumps and Windows minidumps.', ['%LOCALAPPDATA%\\CrashDumps\\*', '%WINDIR%\\Minidump\\*'], false, true),
      target('memory-dumps', 'Memory and kernel dumps', 'Large Windows MEMORY.DMP and LiveKernelReports dump files.', ['%WINDIR%\\MEMORY.DMP', '%WINDIR%\\LiveKernelReports\\*.dmp'], false, true),
      target('old-setup-logs', 'Old setup logs', 'Windows setup/log leftovers that are not personal files.', ['%WINDIR%\\Panther\\*', `%SystemDrive%\\Users\\${user}\\AppData\\Local\\Temp\\*.log`], false, true),
      target('windows-logs', 'Windows CBS/DISM logs', 'Old component servicing logs. Useful for support, so not selected by default.', ['%WINDIR%\\Logs\\CBS\\*.log', '%WINDIR%\\Logs\\DISM\\*.log'], false, true),
      target('prefetch', 'Windows Prefetch cache', 'Boot/app launch traces Windows rebuilds over time. Not selected by default.', ['%WINDIR%\\Prefetch\\*'], false, true),
      target('windows-old', 'Windows.old upgrade files', 'Large previous Windows installation folder if detected. Dangerous because rollback files are removed.', ['%SystemDrive%\\Windows.old\\*'], false, true, true),
      target('browser-cache', 'Browser cache: Edge/Chrome/Firefox', 'Cache folders only, not profiles, bookmarks, passwords, history, or downloads.', ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Cache\\*', '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Cache\\*', '%APPDATA%\\Mozilla\\Firefox\\Profiles\\*\\cache2\\*'], true, false),
      target('steam-cache', 'Steam download/shader cache', 'Steam download cache and shader cache if Steam is detected.', steam.flatMap((root) => [`${root}\\appcache\\httpcache\\*`, `${root}\\steamapps\\shadercache\\*`]), true, false),
      target('launcher-caches', 'Game launcher caches', 'Epic, Battle.net, EA, Ubisoft, and Riot launcher web/cache folders only.', ['%LOCALAPPDATA%\\EpicGamesLauncher\\Saved\\webcache*\\*', '%ProgramData%\\Battle.net\\Cache\\*', '%LOCALAPPDATA%\\Electronic Arts\\EA Desktop\\Cache\\*', '%LOCALAPPDATA%\\Ubisoft Game Launcher\\cache\\*', '%LOCALAPPDATA%\\Riot Games\\Riot Client\\Cache\\*'], true, false),
      target('chat-media-caches', 'Chat/music app caches', 'Discord, Spotify, Teams, and Slack cache folders only.', ['%APPDATA%\\discord\\Cache\\*', '%APPDATA%\\discord\\Code Cache\\*', '%APPDATA%\\discord\\GPUCache\\*', '%LOCALAPPDATA%\\Spotify\\Storage\\*', '%APPDATA%\\Microsoft\\Teams\\Cache\\*', '%APPDATA%\\Slack\\Cache\\*'], true, false),
      target('developer-caches', 'Developer caches', 'npm, pnpm, Yarn, pip, NuGet, Vite, and Electron builder caches. Not selected by default.', ['%LOCALAPPDATA%\\npm-cache\\_cacache\\*', '%LOCALAPPDATA%\\pnpm-store\\*', '%LOCALAPPDATA%\\Yarn\\Cache\\*', '%LOCALAPPDATA%\\pip\\Cache\\*', '%USERPROFILE%\\.nuget\\packages\\.tools\\*', '%LOCALAPPDATA%\\electron\\Cache\\*', '%LOCALAPPDATA%\\electron-builder\\Cache\\*'], false, false),
      commandTarget('cleanmgr-sageset', 'Disk Cleanup setup UI', 'Opens cleanmgr /sageset:1 so you can choose Windows cleanup categories honestly.', false),
      commandTarget('cleanmgr', 'Run Disk Cleanup profile', 'Runs cleanmgr /sagerun:1 using the categories you chose in sageset.', false),
      commandTarget('dism-component-store', 'Component store cleanup', 'Runs DISM StartComponentCleanup. Can take a while and needs admin.', true),
      commandTarget('branch-cache', 'BranchCache', 'Clears Windows BranchCache if the feature is present. Needs admin.', true),
      commandTarget('store-cache', 'Microsoft Store cache', 'Runs wsreset.exe.', false),
      commandTarget('dns-cache', 'DNS cache flush', 'Runs ipconfig /flushdns.', false)
    ]
  }

  private async estimateTargets(targets: CleanTarget[]): Promise<Record<string, CleanEstimate>> {
    const groups = targets.map((target) => ({ id: target.id, paths: target.paths.map(expandEnv) }))
    const raw = this.estimatePathGroups(groups)
    return Object.fromEntries(
      Object.entries(raw).map(([id, estimate]) => [
        id,
        {
          bytes: Number(estimate.bytes ?? 0),
          partial: Boolean(estimate.partial),
          files: Number(estimate.files ?? 0)
        }
      ])
    )
  }

  private async estimateArbitraryTargets(
    json: string
  ): Promise<Record<string, { bytes: number; partial: boolean; files: number; exists: boolean }>> {
    const groups = JSON.parse(json) as Array<{ id: string; paths: string[] }>
    return this.estimatePathGroups(groups)
  }

  private estimatePathGroups(
    groups: Array<{ id: string; paths: string[] }>
  ): Record<string, { bytes: number; partial: boolean; files: number; exists: boolean }> {
    const started = Date.now()
    const globalDeadline = started + 8_000
    const estimates: Record<string, { bytes: number; partial: boolean; files: number; exists: boolean }> = {}
    for (const group of groups) {
      const deadline = Math.min(globalDeadline, Date.now() + 350)
      estimates[group.id] = estimatePathPatterns(group.paths, deadline, 5000)
    }
    this.addLog({
      kind: 'clean',
      label: 'Estimate cleanup target sizes',
      command: 'internal filesystem scanner',
      args: [`${groups.length} targets`, `${Date.now() - started}ms`],
      stdout: JSON.stringify(estimates),
      stderr: '',
      exitCode: 0,
      success: true,
      dryRun: false,
      elevated: false
    })
    return estimates
  }

  private async queryNvidiaQuery(): Promise<{
    name: string
    driverVersion: string
    vramMb: number | null
    usagePercent: number | null
    temperatureC: number | null
    graphicsClockMhz: number | null
    memoryClockMhz: number | null
    maxGraphicsClockMhz: number | null
  }> {
    const result = await this.runCommand(
      'nvidia-smi.exe',
      ['--query-gpu=name,driver_version,memory.total,utilization.gpu,temperature.gpu,clocks.current.graphics,clocks.current.memory,clocks.max.graphics', '--format=csv,noheader,nounits'],
      { kind: 'system', label: 'Query NVIDIA GPU via nvidia-smi' }
    )
    if (!result.success) {
      return { name: '', driverVersion: '', vramMb: null, usagePercent: null, temperatureC: null, graphicsClockMhz: null, memoryClockMhz: null, maxGraphicsClockMhz: null }
    }
    const [name, driverVersion, vram, usage, temp, graphicsClock, memoryClock, maxGraphicsClock] = result.stdout.trim().split(',').map((item) => item.trim())
    return {
      name,
      driverVersion,
      vramMb: Number(vram) || null,
      usagePercent: Number(usage) || null,
      temperatureC: Number(temp) || null,
      graphicsClockMhz: Number(graphicsClock) || null,
      memoryClockMhz: Number(memoryClock) || null,
      maxGraphicsClockMhz: Number(maxGraphicsClock) || null
    }
  }

  private async queryResizableBar(): Promise<'Enabled' | 'Disabled' | 'Unknown'> {
    const result = await this.runCommand('nvidia-smi.exe', ['-q'], { kind: 'system', label: 'Query NVIDIA Resizable BAR' })
    if (!result.success) return 'Unknown'
    const match = result.stdout.match(/Resizable BAR\s*:\s*(Enabled|Disabled)/i)
    if (match) return match[1] as 'Enabled' | 'Disabled'
    const bar1 = result.stdout.match(/BAR1 Memory Usage[\s\S]*?Total\s*:\s*(\d+)\s*MiB/i)
    if (bar1) return Number(bar1[1]) > 1024 ? 'Enabled' : 'Disabled'
    return 'Unknown'
  }

  private async inspectNvidiaPatchStatus(preferredResolution: string): Promise<NvidiaState['patchStatus']> {
    const [width, height] = preferredResolution.split('x').map((part) => Number(part) || 0)
    const script = inspectNvidiaPatchStatusScript(width || 2560, height || 1440)
    const result = await this.runPowerShell(script, { kind: 'nvidia', label: 'Inspect NVIDIA App recommendation resolution metadata' })
    try {
      return JSON.parse(result.stdout.trim()) as NvidiaState['patchStatus']
    } catch {
      return { checked: false, targetResolution: preferredResolution, patchedFiles: 0, unpatched4kFiles: 0, folderFound: false }
    }
  }

  private async queryGamingTweaksState(): Promise<{
    overlayDisabled: boolean
    gameDvrDisabled: boolean
    deliveryOptimizationDisabled: boolean
    deliveryOptimizationStart: number | null
    deliveryOptimizationStatus: string
  }> {
    const script = [
      "$overlay = Get-ItemPropertyValue -Path 'HKCU:\\Software\\NVIDIA Corporation\\Global\\ShadowPlay' -Name 'EnableInGameOverlay' -ErrorAction SilentlyContinue",
      "$shadow = Get-ItemPropertyValue -Path 'HKCU:\\Software\\NVIDIA Corporation\\Global\\ShadowPlay' -Name 'ShadowPlayEnabled' -ErrorAction SilentlyContinue",
      "$dvr = Get-ItemPropertyValue -Path 'HKCU:\\System\\GameConfigStore' -Name 'GameDVR_Enabled' -ErrorAction SilentlyContinue",
      "$capture = Get-ItemPropertyValue -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Name 'AppCaptureEnabled' -ErrorAction SilentlyContinue",
      "$dosvcStart = Get-ItemPropertyValue -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\DoSvc' -Name 'Start' -ErrorAction SilentlyContinue",
      "$dosvc = Get-Service -Name 'DoSvc' -ErrorAction SilentlyContinue",
      "[pscustomobject]@{ overlayDisabled = (($overlay -eq 0 -or $null -eq $overlay) -and ($shadow -eq 0 -or $null -eq $shadow)); gameDvrDisabled = (($dvr -eq 0 -or $null -eq $dvr) -and ($capture -eq 0 -or $null -eq $capture)); deliveryOptimizationDisabled = ($dosvcStart -eq 4); deliveryOptimizationStart = $dosvcStart; deliveryOptimizationStatus = if ($dosvc) { [string]$dosvc.Status } else { 'Unknown' } } | ConvertTo-Json -Compress"
    ].join('\n')
    const result = await this.runPowerShell(script, { kind: 'nvidia', label: 'Inspect Windows/NVIDIA gaming tweak state' })
    try {
      return JSON.parse(result.stdout.trim()) as {
        overlayDisabled: boolean
        gameDvrDisabled: boolean
        deliveryOptimizationDisabled: boolean
        deliveryOptimizationStart: number | null
        deliveryOptimizationStatus: string
      }
    } catch {
      return {
        overlayDisabled: false,
        gameDvrDisabled: false,
        deliveryOptimizationDisabled: false,
        deliveryOptimizationStart: null,
        deliveryOptimizationStatus: 'Unknown'
      }
    }
  }

  private async disableDeliveryOptimization(dryRun: boolean): Promise<CommandLogEntry> {
    const state = await this.queryGamingTweaksState()
    const originalStart = Number.isFinite(Number(state.deliveryOptimizationStart)) ? Number(state.deliveryOptimizationStart) : 3
    const log = await this.runElevatedPowerShell(disableDeliveryOptimizationScript(), 'Disable Delivery Optimization service', dryRun, 'nvidia')
    if (log.success && !dryRun) {
      const restoreScript = [
        "$path = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\DoSvc'",
        `Set-ItemProperty -Path $path -Name 'Start' -Type DWord -Value ${originalStart}`,
        `if (${originalStart} -ne 4) { Start-Service -Name 'DoSvc' -ErrorAction SilentlyContinue }`,
        `"Delivery Optimization Start restored to ${originalStart}."`
      ].join('\n')
      this.addRestore({
        kind: 'registry',
        label: `Undo: restore Delivery Optimization Start=${originalStart}`,
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', restoreScript],
        elevated: true
      })
    }
    return log
  }

  private async queryPerCoreUsage(): Promise<number[]> {
    const script = '(Get-Counter "\\Processor(*)\\% Processor Time").CounterSamples | Where-Object {$_.InstanceName -match "^\\d+$"} | Sort-Object {[int]$_.InstanceName} | ForEach-Object {[math]::Round($_.CookedValue,1)} | ConvertTo-Json -Compress'
    const result = await this.runPowerShell(script, { kind: 'system', label: 'Read per-core CPU usage' })
    try {
      const parsed = JSON.parse(result.stdout.trim())
      return Array.isArray(parsed) ? parsed.map(Number) : []
    } catch {
      return []
    }
  }

  private async runPowerShellJson(script: string, label: string): Promise<any> {
    const result = await this.runPowerShell(`${script} | ConvertTo-Json -Depth 6 -Compress`, { kind: 'system', label })
    try {
      return JSON.parse(result.stdout.trim())
    } catch {
      return {}
    }
  }

  private runPowerShell(script: string, options: CommandOptions): Promise<CommandLogEntry> {
    return this.runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(powerShellPrelude(script))], options)
  }

  private async runElevatedPowerShell(
    script: string,
    label: string,
    _dryRun: boolean,
    kind: CommandLogEntry['kind'],
    timeoutMs = 10 * 60_000
  ): Promise<CommandLogEntry> {
    const sharedRoot = process.env.ProgramData ? join(process.env.ProgramData, 'OptimizerGuard') : this.dataDir
    const workDir = join(sharedRoot, 'elevated')
    mkdirSync(workDir, { recursive: true })
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const resultFile = join(workDir, `${id}.json`)
    const helperScript = join(workDir, `${id}-helper.ps1`)
    const payloadScript = join(workDir, `${id}-payload.ps1`)
    const stdoutFile = join(workDir, `${id}.out.txt`)
    const stderrFile = join(workDir, `${id}.err.txt`)
    const escapedResultFile = escapePowerShellSingle(resultFile)
    const escapedHelperScript = escapePowerShellSingle(helperScript)
    const escapedPayloadScript = escapePowerShellSingle(payloadScript)
    const escapedStdoutFile = escapePowerShellSingle(stdoutFile)
    const escapedStderrFile = escapePowerShellSingle(stderrFile)
    const wrapped = `
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
$out = ''
$err = ''
$code = 0
try {
  $process = Start-Process -FilePath 'powershell.exe' -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${escapedPayloadScript}') -RedirectStandardOutput '${escapedStdoutFile}' -RedirectStandardError '${escapedStderrFile}'
  $code = if ($null -ne $process.ExitCode) { [int]$process.ExitCode } else { 0 }
} catch {
  $err = $_ | Out-String
  $code = 1
}
if (Test-Path -LiteralPath '${escapedStdoutFile}') { $out = Get-Content -LiteralPath '${escapedStdoutFile}' -Raw -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath '${escapedStderrFile}') { $err = (($err | Out-String) + (Get-Content -LiteralPath '${escapedStderrFile}' -Raw -ErrorAction SilentlyContinue)).Trim() }
[pscustomobject]@{ stdout = $out; stderr = $err; exitCode = $code } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath '${escapedResultFile}' -Encoding UTF8
`
    writeFileSync(payloadScript, powerShellPrelude(script), 'utf8')
    writeFileSync(helperScript, wrapped, 'utf8')
    const launchScript = [
      `$helper = '${escapedHelperScript}'`,
      "$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $helper)",
      "Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments | Out-Null"
    ].join('\n')
    const launch = await this.runCommandRaw(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(launchScript)
      ],
      true,
      Math.min(timeoutMs, 120_000)
    )

    const resultDeadline = Date.now() + timeoutMs
    while (launch.success && !existsSync(resultFile) && Date.now() < resultDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    let stdout = launch.stdout
    let stderr = launch.stderr
    let exitCode = launch.exitCode
    if (existsSync(resultFile)) {
      try {
        const parsed = JSON.parse(readFileSync(resultFile, 'utf8'))
        stdout = parsed.stdout ?? stdout
        stderr = parsed.stderr ?? stderr
        exitCode = Number(parsed.exitCode ?? exitCode)
      } catch {
        stderr += '\nUnable to parse elevated result file.'
      }
    } else {
      stderr = [
        stderr,
        launch.stdout ? `Launcher stdout:\n${launch.stdout}` : '',
        launch.stderr ? `Launcher stderr:\n${launch.stderr}` : '',
        `Elevated action did not return a result file: ${resultFile}`,
        `Helper script: ${helperScript}`,
        launch.success
          ? `Elevated action timed out after ${Math.round(timeoutMs / 1000)} seconds.`
          : 'UAC may have been cancelled, blocked by policy, or PowerShell elevation may have failed.'
      ]
        .filter(Boolean)
        .join('\n')
      exitCode = launch.success ? 124 : exitCode === 0 ? 1 : exitCode
    }
    return this.addLog({
      kind,
      label,
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      stdout,
      stderr,
      exitCode,
      success: exitCode === 0,
      dryRun: false,
      elevated: true
    })
  }

  private async runCommandRaw(
    command: string,
    args: string[],
    elevated = false,
    timeoutMs = 10 * 60_000
  ): Promise<Omit<CommandLogEntry, 'id' | 'timestamp' | 'kind' | 'label' | 'dryRun'>> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      const finish = (result: Omit<CommandLogEntry, 'id' | 'timestamp' | 'kind' | 'label' | 'dryRun'>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
      child.on('error', (error) => {
        finish({ command, args, stdout, stderr: `${stderr}${error.message}`, exitCode: 1, success: false, elevated })
      })
      child.on('close', (code) => {
        finish({
          command,
          args,
          stdout,
          stderr: timedOut ? `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)} seconds.`.trim() : stderr,
          exitCode: timedOut ? 124 : code,
          success: !timedOut && code === 0,
          elevated
        })
      })
    })
  }

  private async runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandLogEntry> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      const timeoutMs = options.timeoutMs ?? 10 * 60_000
      const finish = (entry: Omit<CommandLogEntry, 'id' | 'timestamp'>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(this.addLog(entry))
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
      child.on('error', (error) => {
        finish({
          kind: options.kind,
          label: options.label,
          command,
          args,
          stdout,
          stderr: `${stderr}${error.message}`,
          exitCode: 1,
          success: false,
          dryRun: false,
          elevated: Boolean(options.elevated)
        })
      })
      child.on('close', (code) => {
        finish({
          kind: options.kind,
          label: options.label,
          command,
          args,
          stdout,
          stderr: timedOut ? `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)} seconds.`.trim() : stderr,
          exitCode: timedOut ? 124 : code,
          success: !timedOut && code === 0,
          dryRun: false,
          elevated: Boolean(options.elevated)
        })
      })
    })
  }

  private addRestore(entry: Omit<RestoreEntry, 'id' | 'timestamp' | 'applied'>): void {
    this.restoreHistory.push({
      id: cryptoId(),
      timestamp: new Date().toISOString(),
      applied: false,
      ...entry
    })
    this.writeJson(this.restoreFile, this.restoreHistory)
  }

  private addLog(entry: Omit<CommandLogEntry, 'id' | 'timestamp'>): CommandLogEntry {
    const full = {
      id: cryptoId(),
      timestamp: new Date().toISOString(),
      ...entry,
      stdout: cleanPowerShellOutput(entry.stdout),
      stderr: cleanPowerShellOutput(entry.stderr)
    }
    this.logs.push(full)
    this.writeJson(this.logFile, this.logs.slice(-1000))
    return full
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback
    } catch {
      return fallback
    }
  }

  private writeJson(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  }
}

function estimatePathPatterns(
  patterns: string[],
  deadline: number,
  maxFiles: number
): { bytes: number; partial: boolean; files: number; exists: boolean } {
  let bytes = 0
  let files = 0
  let exists = false
  let partial = false
  const stack: string[] = []

  for (const pattern of patterns) {
    if (Date.now() >= deadline) {
      partial = true
      break
    }
    const expanded = expandLocalGlob(pattern, deadline)
    if (expanded.partial) partial = true
    if (expanded.paths.length > 0) exists = true
    stack.push(...expanded.paths)
  }

  while (stack.length > 0) {
    if (Date.now() >= deadline || files >= maxFiles) {
      partial = true
      break
    }
    const current = stack.pop()!
    try {
      const info = lstatSync(current)
      if (info.isSymbolicLink()) continue
      if (info.isFile()) {
        bytes += info.size
        files += 1
        continue
      }
      if (info.isDirectory()) {
        for (const entry of readdirSync(current)) stack.push(join(current, entry))
      }
    } catch {}
  }
  return { bytes, partial, files, exists }
}

function expandLocalGlob(pattern: string, deadline: number): { paths: string[]; partial: boolean } {
  const normalized = pattern.replace(/\//g, '\\')
  const root = parse(normalized).root
  const segments = normalized.slice(root.length).split('\\').filter(Boolean)
  let paths = [root]
  let partial = false
  for (const segment of segments) {
    if (Date.now() >= deadline) return { paths: [], partial: true }
    if (!/[*?]/.test(segment)) {
      paths = paths.map((base) => join(base, segment))
      continue
    }
    const matcher = globSegmentRegex(segment)
    const matches: string[] = []
    for (const base of paths) {
      try {
        for (const name of readdirSync(base)) {
          if (matcher.test(name)) matches.push(join(base, name))
          if (matches.length >= 500 || Date.now() >= deadline) {
            partial = true
            break
          }
        }
      } catch {}
      if (partial) break
    }
    paths = matches
  }
  return { paths: paths.filter((item) => existsSync(item)), partial }
}

function globSegmentRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function installedAppsScript(): string {
  return `
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$apps = foreach ($root in $roots) {
  Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -and ($_.UninstallString -or $_.QuietUninstallString)
  } | ForEach-Object {
    [pscustomobject]@{
      name = [string]$_.DisplayName
      publisher = [string]$_.Publisher
      version = [string]$_.DisplayVersion
      installDate = [string]$_.InstallDate
      installLocation = [string]$_.InstallLocation
      uninstallString = [string]$(if ($_.UninstallString) { $_.UninstallString } else { $_.QuietUninstallString })
      quietUninstallString = [string]$_.QuietUninstallString
      estimatedSizeKb = [int64]$(if ($_.EstimatedSize) { $_.EstimatedSize } else { 0 })
      registryPath = [string]$_.PSPath
      systemComponent = [int]$(if ($_.SystemComponent) { $_.SystemComponent } else { 0 })
    }
  }
}
$apps | Sort-Object name, version -Unique | ConvertTo-Json -Depth 4 -Compress
`
}

function parseUninstallCommand(commandLine: string): { executable: string; args: string[] } | null {
  const trimmed = commandLine.trim()
  const match = trimmed.match(/^"?(.+?\.exe)"?\s*(.*)$/i)
  if (!match) return null
  const executable = match[1].trim()
  const args: string[] = []
  const remainder = match[2].trim()
  const tokenPattern = /"([^"]*)"|(\S+)/g
  let token: RegExpExecArray | null
  while ((token = tokenPattern.exec(remainder))) args.push(token[1] ?? token[2])
  return { executable, args }
}

function quoteWindowsArgument(value: string): string {
  if (!value || /[\s"]/.test(value)) return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
  return value
}

function formatInstallDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function buildLeftoverDefinitions(installedApp: InstalledApp): LeftoverCandidate[] {
  const candidates: LeftoverCandidate[] = []
  const seen = new Set<string>()
  const add = (kind: LeftoverCandidate['kind'], path: string, reason: string, selectedByDefault: boolean): void => {
    const cleanPath = path.trim().replace(/[\\/]+$/, '')
    if (!cleanPath || seen.has(`${kind}:${cleanPath.toLowerCase()}`)) return
    if (kind === 'file' && !isSafeUninstallCandidate(cleanPath)) return
    seen.add(`${kind}:${cleanPath.toLowerCase()}`)
    candidates.push({
      id: cryptoId(),
      appId: installedApp.id,
      kind,
      path: cleanPath,
      reason,
      sizeBytes: 0,
      selectedByDefault,
      protected: false
    })
  }

  const names = exactProductNames(installedApp.name)
  if (installedApp.installLocation) {
    const installLocation = expandEnv(installedApp.installLocation)
    if (isSpecificInstallLocation(installLocation, installedApp, names)) {
      add('file', installLocation, 'Recorded product installation directory', true)
    }
  }
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'LocalLow') : undefined,
    process.env.ProgramData
  ].filter((root): root is string => Boolean(root))
  for (const root of roots) {
    for (const name of names) add('file', join(root, name), `Exact product folder under ${root}`, true)
    if (installedApp.publisher) {
      const publisher = exactProductNames(installedApp.publisher)[0]
      if (publisher) for (const name of names) add('file', join(root, publisher, name), 'Exact publisher/product data folder', false)
    }
  }
  if (installedApp.registryPath) add('registry', installedApp.registryPath, 'Registered uninstall entry still present', true)
  for (const name of names) {
    add('registry', `HKEY_CURRENT_USER\\Software\\${name}`, 'Exact per-user product registry key', false)
    add('registry', `HKEY_LOCAL_MACHINE\\SOFTWARE\\${name}`, 'Exact machine-wide product registry key', false)
    add('registry', `HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\${name}`, 'Exact 32-bit product registry key', false)
  }
  const publisher = exactProductNames(installedApp.publisher)[0]
  if (publisher) {
    for (const name of names) {
      add('registry', `HKEY_CURRENT_USER\\Software\\${publisher}\\${name}`, 'Exact per-user publisher/product registry key', false)
      add('registry', `HKEY_LOCAL_MACHINE\\SOFTWARE\\${publisher}\\${name}`, 'Exact machine publisher/product registry key', false)
      add('registry', `HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\${publisher}\\${name}`, 'Exact 32-bit publisher/product registry key', false)
    }
  }
  return candidates
}

function exactProductNames(displayName: string): string[] {
  const cleaned = displayName
    .replace(/[®™©]/g, '')
    .replace(/\s+\((?:x64|x86|64-bit|32-bit)\)\s*$/i, '')
    .replace(/\s+v?\d+(?:\.\d+){1,4}\s*$/i, '')
    .trim()
  return [
    ...new Set(
      [displayName.trim(), cleaned].filter(
        (item) => item && item.length >= 2 && item !== '.' && item !== '..' && !/[<>:"/\\|?*]/.test(item)
      )
    )
  ]
}

function isSafeUninstallCandidate(path: string): boolean {
  const normalized = path.toLowerCase()
  const blocked = [
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.ProgramData,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.SystemDrive ? `${process.env.SystemDrive}\\` : undefined,
    process.env.WINDIR
  ]
    .filter((item): item is string => Boolean(item))
    .map((item) => item.replace(/[\\/]+$/, '').toLowerCase())
  if (blocked.includes(normalized.replace(/[\\/]+$/, ''))) return false
  const personalRoots = ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Videos', 'Music', 'Saved Games'].map((name) =>
    process.env.USERPROFILE ? join(process.env.USERPROFILE, name).toLowerCase() : ''
  )
  return !personalRoots.some((root) => root && (normalized === root || normalized.startsWith(`${root}\\`)))
}

function isSpecificInstallLocation(path: string, installedApp: InstalledApp, productNames: string[]): boolean {
  if (!isSafeUninstallCandidate(path)) return false
  const normalized = path.replace(/[\\/]+$/, '')
  const leaf = normalized.split('\\').filter(Boolean).at(-1)?.toLowerCase() ?? ''
  const publisherNames = exactProductNames(installedApp.publisher).map((item) => item.toLowerCase())
  if (!leaf || publisherNames.includes(leaf)) return false

  const searchable = normalized.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  const meaningfulTokens = productNames
    .flatMap((name) => name.toLowerCase().split(/[^a-z0-9]+/))
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !['update', 'setup', 'installer', 'application'].includes(token))
  return meaningfulTokens.some((token) => searchable.includes(token))
}

function isAdminPath(path: string): boolean {
  const lower = path.toLowerCase()
  return [process.env.ProgramData, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.WINDIR]
    .filter((item): item is string => Boolean(item))
    .some((root) => lower.startsWith(root.toLowerCase()))
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80) || 'leftover'
}

function uninstallLeftoverRemovalScript(payload: string, quarantine: string): string {
  const escapedQuarantine = escapePowerShellSingle(quarantine)
  return `
$itemsJson = @'
${payload}
'@
$items = $itemsJson | ConvertFrom-Json
$quarantine = '${escapedQuarantine}'
New-Item -ItemType Directory -Path $quarantine -Force | Out-Null
$manifest = @()
[int]$removed = 0
[int]$failed = 0
[int64]$bytes = 0
foreach ($item in $items) {
  try {
    if ($item.kind -eq 'file') {
      if (-not (Test-Path -LiteralPath $item.path)) { continue }
      $destination = Join-Path $quarantine $item.quarantineName
      Move-Item -LiteralPath $item.path -Destination $destination -Force -ErrorAction Stop
      $manifest += [pscustomobject]@{ kind = 'file'; original = $item.path; backup = $destination }
      $bytes += [int64]$item.sizeBytes
    } else {
      $backup = Join-Path $quarantine ($item.quarantineName + '.reg')
      & reg.exe export $item.path $backup /y | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Registry export failed with exit code $LASTEXITCODE" }
      Remove-Item -LiteralPath ('Registry::' + $item.path) -Recurse -Force -ErrorAction Stop
      $manifest += [pscustomobject]@{ kind = 'registry'; original = $item.path; backup = $backup }
    }
    $removed++
  } catch {
    $failed++
  }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $quarantine 'manifest.json') -Encoding UTF8
[pscustomobject]@{ removed = $removed; failed = $failed; quarantinedBytes = $bytes; quarantine = $quarantine } | ConvertTo-Json -Compress
`
}

function uninstallLeftoverRestoreScript(quarantine: string): string {
  const escapedQuarantine = escapePowerShellSingle(quarantine)
  return `
$quarantine = '${escapedQuarantine}'
$manifestPath = Join-Path $quarantine 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Quarantine manifest was not found.' }
$items = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($item in $items) {
  if ($item.kind -eq 'file') {
    if (Test-Path -LiteralPath $item.backup) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $item.original) -Force | Out-Null
      Move-Item -LiteralPath $item.backup -Destination $item.original -Force
    }
  } elseif (Test-Path -LiteralPath $item.backup) {
    & reg.exe import $item.backup | Out-Null
  }
}
"Restored quarantined leftovers from $quarantine"
`
}

function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text)
  const headers = rows.shift() ?? []
  return rows.map((values) =>
    headers.reduce<Record<string, string>>((acc, header, index) => {
      acc[header] = values[index] ?? ''
      return acc
    }, {})
  )
}

function parseSchtasksCsvByPosition(text: string): ScheduledTaskRow[] {
  const rows = parseCsvRows(text).slice(1)
  const byPath = new Map<string, ScheduledTaskRow>()
  for (const row of rows) {
    const taskName = row[1] ?? ''
    if (!taskName || byPath.has(taskName)) continue
    const runtimeStatus = row[3] ?? ''
    const scheduledState = row[11] || runtimeStatus
    const normalizedState = normalizeStatus(scheduledState)
    const enabled = !['disabled', 'desactive'].includes(normalizedState)
    const status = enabled && normalizeStatus(runtimeStatus).includes('running') ? runtimeStatus : scheduledState
    const microsoft = taskName.toLowerCase().startsWith('\\microsoft\\')
    const critical = criticalTaskHints.some((hint) => taskName.toLowerCase().startsWith(hint.toLowerCase()))
    const split = taskName.lastIndexOf('\\')
    byPath.set(taskName, {
      name: split >= 0 ? taskName.slice(split + 1) : taskName,
      path: taskName,
      status,
      nextRun: row[2] ?? '',
      lastRun: row[5] ?? '',
      author: row[7] ?? '',
      taskToRun: row[8] ?? '',
      enabled,
      microsoft,
      critical
    })
  }
  return [...byPath.values()]
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (char === '"' && quoted && next === '"') {
      field += '"'
      i += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1
      row.push(field)
      if (row.some(Boolean)) rows.push(row)
      field = ''
      row = []
    } else {
      field += char
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    if (row[key]) return row[key]
  }
  return ''
}

function target(
  id: string,
  label: string,
  description: string,
  paths: string[],
  selectedByDefault: boolean,
  requiresAdmin: boolean,
  dangerous = false
): CleanTarget {
  return { id, label, description, paths, estimatedBytes: 0, detected: false, selectedByDefault, requiresAdmin, dangerous }
}

function commandTarget(id: string, label: string, description: string, requiresAdmin: boolean, dangerous = false): CleanTarget {
  return {
    id,
    label,
    description,
    paths: [],
    estimatedBytes: 0,
    detected: true,
    selectedByDefault: false,
    requiresAdmin,
    dangerous,
    commandOnly: true
  }
}

function expandEnv(input: string): string {
  return input.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`)
}

function normalizeStatus(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

function normalizeTaskPath(taskPath: string): string {
  const trimmed = taskPath.trim().replace(/\//g, '\\')
  if (!trimmed) return trimmed
  return trimmed.startsWith('\\') ? trimmed : `\\${trimmed}`
}

function powerShellPrelude(script: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$InformationPreference = 'SilentlyContinue'",
    "$VerbosePreference = 'SilentlyContinue'",
    script
  ].join('\n')
}

function cleanPowerShellOutput(output: string): string {
  if (!output || !output.includes('#< CLIXML')) return output
  return output
    .replace(/#< CLIXML[\s\S]*?(?=(?:\r?\n(?!<))|$)/g, 'PowerShell progress output suppressed.')
    .replace(/<Objs[\s\S]*<\/Objs>/g, 'PowerShell progress output suppressed.')
    .trim()
}

function safeDeleteScript(paths: string[]): string {
  const safeRoots = [
    process.env.TEMP,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.ProgramData,
    process.env.WINDIR ? join(process.env.WINDIR, 'Temp') : undefined,
    process.env.WINDIR ? join(process.env.WINDIR, 'Minidump') : undefined,
    process.env.WINDIR ? join(process.env.WINDIR, 'LiveKernelReports') : undefined,
    process.env.WINDIR ? join(process.env.WINDIR, 'Logs', 'CBS') : undefined,
    process.env.WINDIR ? join(process.env.WINDIR, 'Logs', 'DISM') : undefined,
    process.env.WINDIR ? join(process.env.WINDIR, 'Prefetch') : undefined,
    process.env.WINDIR ? join(process.env.WINDIR, 'SoftwareDistribution', 'Download') : undefined,
    process.env.WINDIR ? join(process.env.WINDIR, 'Panther') : undefined,
    process.env.WINDIR ? join(process.env.WINDIR, 'MEMORY.DMP') : undefined,
    process.env.SystemDrive ? `${process.env.SystemDrive}\\Windows.old` : undefined,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.nuget', 'packages', '.tools') : undefined
  ]
    .filter(Boolean)
    .map((root) => String(root).toLowerCase())
  const safePaths = paths.filter((path) => {
    const lower = path.toLowerCase()
    if (safeRoots.some((root) => lower.startsWith(root))) return true
    return lower.includes('\\steam\\appcache\\httpcache') || lower.includes('\\steam\\steamapps\\shadercache')
  })
  const json = JSON.stringify(safePaths)
  return [
    `$pathsJson = @'\n${json}\n'@`,
    '$paths = $pathsJson | ConvertFrom-Json',
    '[int64]$bytes = 0',
    '[int]$deleted = 0',
    '[int]$failed = 0',
    '[bool]$capped = $false',
    '$timer = [System.Diagnostics.Stopwatch]::StartNew()',
    '$maxFiles = 50000',
    '$maxMs = 90000',
    'foreach ($p in $paths) {',
    '  try {',
    '    foreach ($item in Get-ChildItem -Path $p -Force -File -Recurse -ErrorAction SilentlyContinue) {',
    '      if ($timer.ElapsedMilliseconds -gt $maxMs -or $deleted -ge $maxFiles) { $capped = $true; break }',
    '      try {',
    '        $size = [int64]$item.Length',
    '        Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop',
    '        $bytes += $size',
    '        $deleted++',
    '      } catch {',
    '        $failed++',
    '      }',
    '    }',
    '  } catch {}',
    '  if ($capped) { break }',
    '  try {',
    '    Get-ChildItem -Path $p -Force -Directory -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object {',
    '      try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {}',
    '    }',
    '  } catch {}',
    '}',
    '[pscustomobject]@{ paths = @($paths).Count; deletedFiles = $deleted; failedFiles = $failed; deletedBytes = $bytes; capped = $capped } | ConvertTo-Json -Compress'
  ].join('\n')
}

function systemInfoScript(): string {
  return `
$bios = Get-CimInstance Win32_BIOS
$board = Get-CimInstance Win32_BaseBoard
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu = Get-CimInstance Win32_VideoController | Sort-Object AdapterRAM -Descending | Select-Object -First 1
$displays = @()
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DisplayModeReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent;
    public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2;
    public int dmPanningWidth; public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
}
"@ -ErrorAction SilentlyContinue
  $displays = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    $mode = New-Object DisplayModeReader+DEVMODE
    $mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mode)
    [void][DisplayModeReader]::EnumDisplaySettings($_.DeviceName, -1, [ref]$mode)
    [pscustomobject]@{ name = $_.DeviceName; width = $_.Bounds.Width; height = $_.Bounds.Height; refreshRate = $mode.dmDisplayFrequency; primary = $_.Primary }
  }
} catch {
  $displays = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorListedSupportedSourceModes -ErrorAction SilentlyContinue |
    Select-Object -First 8 | ForEach-Object {
      $mode = $_.MonitorSourceModes | Sort-Object HorizontalActivePixels, VerticalActivePixels -Descending | Select-Object -First 1
      [pscustomobject]@{ name = $_.InstanceName; width = $mode.HorizontalActivePixels; height = $mode.VerticalActivePixels; refreshRate = $mode.VerticalRefreshRate; primary = $false }
    }
}
$powerPlan = (powercfg /getactivescheme) -join ' '
$gameMode = Get-ItemPropertyValue -Path 'HKCU:\\Software\\Microsoft\\GameBar' -Name 'AutoGameModeEnabled' -ErrorAction SilentlyContinue
$hags = Get-ItemPropertyValue -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -Name 'HwSchMode' -ErrorAction SilentlyContinue
if ($null -eq $hags) { $hags = 'Default' }
$memoryGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
$cpuLoad = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
[pscustomobject]@{
  bios = $bios
  board = $board
  cpu = $cpu
  gpu = $gpu
  displays = $displays
  powerPlan = $powerPlan
  gameMode = $gameMode
  hags = $hags
  memoryGb = $memoryGb
  cpuLoad = $cpuLoad
}`
}

function scheduledTasksFallbackScript(): string {
  return `
$tasks = Get-ScheduledTask -ErrorAction Stop
$rows = foreach ($task in $tasks) {
  $info = $null
  try { $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue } catch {}
  $actionText = ($task.Actions | ForEach-Object {
    $parts = @($_.Execute, $_.Arguments) | Where-Object { $_ }
    $parts -join ' '
  }) -join '; '
  $fullPath = (($task.TaskPath.TrimEnd('\\') + '\\' + $task.TaskName) -replace '\\\\+', '\\')
  if (-not $fullPath.StartsWith('\\')) { $fullPath = '\\' + $fullPath }
  [pscustomobject]@{
    name = $task.TaskName
    path = $fullPath
    status = [string]$task.State
    nextRun = if ($info -and $info.NextRunTime -and $info.NextRunTime.Year -gt 1900) { $info.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
    lastRun = if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 1900) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
    author = [string]$task.Principal.UserId
    taskToRun = $actionText
    enabled = ([string]$task.State -ne 'Disabled')
  }
}
@($rows) | ConvertTo-Json -Depth 4 -Compress
`
}

function taskStateScript(taskPath: string, enable: boolean): string {
  const task = escapePowerShellSingle(taskPath)
  return `
$fullPath = '${task}'
$desiredEnabled = '${enable ? '1' : '0'}' -eq '1'
$taskName = Split-Path -Leaf $fullPath
$taskPath = Split-Path -Parent $fullPath
if ([string]::IsNullOrWhiteSpace($taskPath) -or $taskPath -eq '\\') {
  $taskPath = '\\'
} else {
  $taskPath = ($taskPath.TrimEnd('\\') + '\\')
}
$errors = New-Object System.Collections.Generic.List[string]
try {
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
  if (-not $desiredEnabled) {
    try { Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue } catch {}
    try { & schtasks.exe /End /TN $fullPath 2>$null | Out-Null } catch {}
    $task | Disable-ScheduledTask -ErrorAction Stop | Out-Null
  } else {
    $task | Enable-ScheduledTask -ErrorAction Stop | Out-Null
  }
} catch {
  $errors.Add("ScheduledTasks API failed: $($_.Exception.Message)")
}

$updated = $null
try { $updated = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop } catch {}
$state = if ($null -ne $updated) { [string]$updated.State } else { 'Unknown' }
$stateMatches = if ($desiredEnabled) { $state -ne 'Disabled' } else { $state -eq 'Disabled' }

if (-not $stateMatches) {
  $action = if ($desiredEnabled) { '/Enable' } else { '/Disable' }
  try {
    if (-not $desiredEnabled) { try { & schtasks.exe /End /TN $fullPath 2>$null | Out-Null } catch {} }
    $schtasksOutput = & schtasks.exe /Change /TN $fullPath $action 2>&1
    if ($LASTEXITCODE -ne 0) {
      $errors.Add("schtasks.exe failed with exit code $LASTEXITCODE - $($schtasksOutput -join [Environment]::NewLine)")
    }
  } catch {
    $errors.Add("schtasks.exe threw: $($_.Exception.Message)")
  }
}

$updated = $null
try { $updated = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop } catch {}
$state = if ($null -ne $updated) { [string]$updated.State } else { 'Unknown' }
$stateMatches = if ($desiredEnabled) { $state -ne 'Disabled' } else { $state -eq 'Disabled' }
"Scheduled task $fullPath is now $state."
if (-not $stateMatches) {
  if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ } }
  Write-Error "Expected task to be $(if ($desiredEnabled) { 'enabled' } else { 'disabled' }), but Windows still reports $state."
  exit 1
}
`
}

function taskStateQueryScript(taskPath: string): string {
  const task = escapePowerShellSingle(taskPath)
  return `
$fullPath = '${task}'
$taskName = Split-Path -Leaf $fullPath
$taskPath = Split-Path -Parent $fullPath
if ([string]::IsNullOrWhiteSpace($taskPath) -or $taskPath -eq '\\') {
  $taskPath = '\\'
} else {
  $taskPath = ($taskPath.TrimEnd('\\') + '\\')
}
try {
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
  $state = [string]$task.State
  [pscustomobject]@{
    found = $true
    enabled = ($state -ne 'Disabled')
    state = $state
    source = 'Get-ScheduledTask'
  } | ConvertTo-Json -Compress
} catch {
  $query = & schtasks.exe /Query /TN $fullPath /FO LIST /V 2>&1
  $text = ($query | Out-String)
  if ($LASTEXITCODE -ne 0) {
    [pscustomobject]@{
      found = $false
      enabled = $null
      state = 'Unknown'
      source = 'schtasks.exe'
      error = $text.Trim()
    } | ConvertTo-Json -Compress
    exit 0
  }
  $disabled = $text -match '(?im)^\\s*Status\\s*:\\s*Disabled\\s*$'
  $stateLine = [regex]::Match($text, '(?im)^\\s*Status\\s*:\\s*(.+)$')
  [pscustomobject]@{
    found = $true
    enabled = (-not $disabled)
    state = if ($stateLine.Success) { $stateLine.Groups[1].Value.Trim() } else { 'Unknown' }
    source = 'schtasks.exe'
  } | ConvertTo-Json -Compress
}
`
}

function updaterTaskHint(taskPath: string): string {
  const lower = taskPath.toLowerCase()
  if (lower.includes('microsoftedgeupdatetask')) {
    return 'Hint: Microsoft Edge Update services can recreate or re-enable Edge update tasks. If the command succeeds but the task immediately returns enabled, the updater service is likely repairing it.'
  }
  if (lower.includes('onedrive')) {
    return 'Hint: OneDrive can recreate per-user/per-machine update tasks while OneDrive is installed or running.'
  }
  if (lower.includes('adob') || lower.includes('acrobat')) {
    return 'Hint: Adobe updater services can recreate update tasks after app launch or service restart.'
  }
  return ''
}

function hyperVStateScript(): string {
  return `
$featureState = 'Unknown'
$featureText = ''
try {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName 'Microsoft-Hyper-V-All' -ErrorAction Stop 2>&1
  if ($feature.State) {
    $featureState = [string]$feature.State
  } else {
    $featureText = ($feature | Out-String)
  }
} catch {
  $featureText = $_.Exception.Message
}
if ($featureText -match 'requires elevation|Access is denied|administrator|740') {
  $featureState = 'Admin required'
}
$hypervisorPresent = $false
try {
  $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  $hypervisorPresent = [bool]$computer.HypervisorPresent
} catch {}

if ($featureState -eq 'Enabled') {
  if ($hypervisorPresent) { 'Enabled (active)' } else { 'Enabled (restart may be pending)' }
} elseif ($featureState -eq 'Disabled') {
  if ($hypervisorPresent) { 'Disabled (restart pending; hypervisor still active)' } else { 'Disabled' }
} elseif ($featureState -eq 'Admin required') {
  if ($hypervisorPresent) { 'Admin required; hypervisor active' } else { 'Admin required; hypervisor not active' }
} else {
  if ($hypervisorPresent) { 'Unknown; hypervisor active' } else { 'Unknown' }
}
`
}

function normalizeDisplay(value: any) {
  return {
    name: String(value.name ?? 'Display'),
    width: Number(value.width ?? 0),
    height: Number(value.height ?? 0),
    refreshRate: Number(value.refreshRate ?? 0),
    primary: Boolean(value.primary)
  }
}

function disableNvidiaOverlayScript(): string {
  return `
New-Item -Path 'HKCU:\\Software\\NVIDIA Corporation\\Global\\ShadowPlay' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\NVIDIA Corporation\\Global\\ShadowPlay' -Name 'EnableInGameOverlay' -Type DWord -Value 0
Set-ItemProperty -Path 'HKCU:\\Software\\NVIDIA Corporation\\Global\\ShadowPlay' -Name 'ShadowPlayEnabled' -Type DWord -Value 0
Get-Process -Name 'NVIDIA Share','NVIDIA Share UI','nvsphelper64','NVIDIA Overlay' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
'NVIDIA overlay registry flags set to disabled. Reopen NVIDIA App to verify.'
`
}

function setGameModeScript(): string {
  return `
New-Item -Path 'HKCU:\\Software\\Microsoft\\GameBar' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\GameBar' -Name 'AutoGameModeEnabled' -Type DWord -Value 1
'Windows Game Mode enabled.'
`
}

function disableGameDvrScript(): string {
  return `
New-Item -Path 'HKCU:\\System\\GameConfigStore' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\System\\GameConfigStore' -Name 'GameDVR_Enabled' -Type DWord -Value 0
New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Name 'AppCaptureEnabled' -Type DWord -Value 0
'Xbox Game DVR capture disabled.'
`
}

function disableDeliveryOptimizationScript(): string {
  return `
$path = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\DoSvc'
$previous = Get-ItemPropertyValue -Path $path -Name 'Start' -ErrorAction Stop
Set-ItemProperty -Path $path -Name 'Start' -Type DWord -Value 4
Stop-Service -Name 'DoSvc' -Force -ErrorAction SilentlyContinue
$current = Get-ItemPropertyValue -Path $path -Name 'Start' -ErrorAction Stop
"Delivery Optimization disabled. Previous Start=$previous; Current Start=$current."
`
}

function inspectNvidiaPatchStatusScript(width: number, height: number): string {
  return `
$root = Join-Path $env:LOCALAPPDATA 'NVIDIA Corporation\\NVIDIA app\\NvBackend'
$target = '${width}x${height}'
$status = [ordered]@{ checked = $true; targetResolution = $target; patchedFiles = 0; unpatched4kFiles = 0; folderFound = (Test-Path -LiteralPath $root) }
if ($status.folderFound) {
  $files = Get-ChildItem -LiteralPath $root -Recurse -File -Include *.json,*.txt,*.dat -ErrorAction SilentlyContinue
  foreach ($file in $files) {
    $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { continue }
    if ($text -match '3840\\s*x\\s*2160' -or $text -match '"width"\\s*:\\s*3840' -or $text -match '"height"\\s*:\\s*2160') { $status.unpatched4kFiles++ }
    if ($text -match [regex]::Escape($target) -or ($text -match ('"width"\\s*:\\s*' + ${width}) -and $text -match ('"height"\\s*:\\s*' + ${height}))) { $status.patchedFiles++ }
  }
}
[pscustomobject]$status | ConvertTo-Json -Compress
`
}

function patchNvidiaResolutionScript(width: number, height: number, backupRoot: string): string {
  return `
$root = Join-Path $env:LOCALAPPDATA 'NVIDIA Corporation\\NVIDIA app\\NvBackend'
$backup = '${escapePowerShellSingle(backupRoot)}\\' + (Get-Date -Format 'yyyyMMdd-HHmmss')
if (-not (Test-Path -LiteralPath $root)) { "NVIDIA App metadata folder not found: $root"; exit 0 }
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$files = Get-ChildItem -LiteralPath $root -Recurse -File -Include *.json,*.txt,*.dat -ErrorAction SilentlyContinue
$changed = 0
foreach ($file in $files) {
  $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
  if ($null -eq $text) { continue }
  $new = $text -replace '3840\\s*x\\s*2160', '${width}x${height}' -replace '"width"\\s*:\\s*3840', '"width": ${width}' -replace '"height"\\s*:\\s*2160', '"height": ${height}'
  if ($new -ne $text) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $backup $file.Name) -Force
    Set-Content -LiteralPath $file.FullName -Value $new -Encoding UTF8
    $changed++
  }
}
"Patched $changed NVIDIA App metadata files. Backup: $backup"
`
}

function registryDwordToState(value: unknown): 'Enabled' | 'Disabled' | 'Unknown' {
  if (value === null || value === undefined || value === '') return 'Unknown'
  return Number(value) > 0 ? 'Enabled' : 'Disabled'
}

function hagsStateFromRegistry(value: unknown): 'Enabled' | 'Disabled' | 'Default' | 'Unknown' {
  if (value === 'Default') return 'Default'
  if (value === null || value === undefined || value === '') return 'Default'
  if (Number(value) === 2) return 'Enabled'
  if (Number(value) === 1) return 'Disabled'
  return 'Unknown'
}

function recommendDlss(width: number, height: number): NvidiaProfile['dlssMode'] {
  if (width >= 3840 || height >= 2160) return 'Balanced'
  if (width >= 2560 || height >= 1440) return 'Quality'
  return 'Quality'
}

function detectFrameGeneration(gpuName: string): 'Supported' | 'Not supported' | 'Unknown' {
  if (!gpuName) return 'Unknown'
  return /RTX\s+4\d{3}|RTX\s+5\d{3}/i.test(gpuName) ? 'Supported' : 'Not supported'
}

function detectOverclockable(cpuName: string, board: string): string {
  if (/Intel/i.test(cpuName) && /\b(K|KF|KS|X)\b/i.test(cpuName.replace(/-/g, ' '))) {
    return 'Likely unlocked Intel CPU. BIOS and cooling still decide practical OC headroom.'
  }
  if (/Ryzen/i.test(cpuName)) {
    return `AMD Ryzen desktop chips are often unlocked; motherboard/BIOS support matters${board ? ` (${board})` : ''}.`
  }
  return 'Locked or unknown. Treat manual overclocking as unlikely until BIOS confirms it.'
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function formatWmiDate(value: string): string {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value || 'Unknown'
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function escapePowerShellSingle(value: string): string {
  return value.replace(/'/g, "''")
}

function cryptoId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
}
