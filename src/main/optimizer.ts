import { app, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import os from 'os'
import type {
  AppSettings,
  AppSnapshot,
  ApplyNvidiaProfileRequest,
  CleanResult,
  CleanTarget,
  CommandLogEntry,
  FeatureToggle,
  NvidiaProfile,
  NvidiaState,
  RestoreEntry,
  ScheduledTaskRow,
  SystemInfo
} from '../shared/types'

interface CommandOptions {
  kind: CommandLogEntry['kind']
  label: string
  dryRun?: boolean
  elevated?: boolean
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
    const result = await this.runCommand('schtasks.exe', ['/query', '/fo', 'CSV', '/v'], {
      kind: 'task',
      label: 'Query scheduled tasks'
    })
    if (!result.success) return []
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
    return [...byPath.values()]
  }

  async setTaskState(taskPath: string, enable: boolean, dryRun: boolean): Promise<CommandLogEntry> {
    const args = ['/Change', '/TN', taskPath, enable ? '/Enable' : '/Disable']
    if (!enable) {
      await this.runCommand('schtasks.exe', ['/End', '/TN', taskPath], {
        kind: 'task',
        label: `Stop running scheduled task ${taskPath}`,
        dryRun
      })
    }

    let log = await this.runCommand('schtasks.exe', args, {
      kind: 'task',
      label: `${enable ? 'Enable' : 'Disable'} scheduled task ${taskPath}`,
      dryRun
    })

    if (!log.success || !(await this.verifyTaskState(taskPath, enable))) {
      const elevatedScript = taskStateScript(taskPath, enable)
      log = await this.runElevatedPowerShell(elevatedScript, `${enable ? 'Enable' : 'Disable'} scheduled task ${taskPath}`, dryRun, 'task')
    }

    if (log.success && !(await this.verifyTaskState(taskPath, enable))) {
      log = this.addLog({
        kind: 'task',
        label: `Verify scheduled task ${taskPath}`,
        command: 'schtasks.exe',
        args: ['/query', '/TN', taskPath, '/fo', 'CSV', '/v'],
        stdout: `Expected task to be ${enable ? 'enabled' : 'disabled'}, but Windows reported a different state.`,
        stderr: '',
        exitCode: 1,
        success: false,
        dryRun: false,
        elevated: log.elevated
      })
    }

    if (log.success && !dryRun) {
      this.addRestore({
        kind: 'task',
        label: `Undo: ${enable ? 'disable' : 're-enable'} ${taskPath}`,
        command: 'schtasks.exe',
        args: ['/Change', '/TN', taskPath, enable ? '/Disable' : '/Enable'],
        elevated: log.elevated
      })
    }
    return log
  }

  private async verifyTaskState(taskPath: string, enabled: boolean): Promise<boolean> {
    const tasks = await this.queryTasks()
    const task = tasks.find((item) => item.path.toLowerCase() === taskPath.toLowerCase())
    return task ? task.enabled === enabled : false
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

  async scanCleaningTargets(): Promise<CleanTarget[]> {
    const targets = this.getCleanDefinitions()
    const estimates = await this.estimateTargets(targets.filter((target) => !target.commandOnly))
    return targets.map((target) => {
      const estimatedBytes = target.commandOnly ? 0 : estimates[target.id] ?? 0
      return {
        ...target,
        estimatedBytes,
        detected: target.commandOnly ? true : estimatedBytes > 0
      }
    })
  }

  async cleanTargets(ids: string[], dryRun: boolean): Promise<CleanResult> {
    const targets = (await this.scanCleaningTargets()).filter((target) => ids.includes(target.id))
    const beforeBytes = targets.reduce((sum, target) => sum + target.estimatedBytes, 0)
    const logs: CommandLogEntry[] = []

    for (const target of targets) {
      if (target.commandOnly) {
        logs.push(await this.runCleaningCommand(target, dryRun))
      } else {
        const expandedPaths = target.paths.map(expandEnv)
        const script = safeDeleteScript(expandedPaths)
        const run = target.requiresAdmin
          ? await this.runElevatedPowerShell(script, `Clean ${target.label}`, dryRun, 'clean')
          : await this.runPowerShell(script, { kind: 'clean', label: `Clean ${target.label}`, dryRun })
        logs.push(run)
      }
    }

    const afterScan = await this.scanCleaningTargets()
    const afterBytes = afterScan.filter((target) => ids.includes(target.id)).reduce((sum, target) => sum + target.estimatedBytes, 0)
    return { beforeBytes, afterBytes, savedBytes: Math.max(0, beforeBytes - afterBytes), logs }
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
      return this.runElevatedPowerShell('DISM /Online /Cleanup-Image /StartComponentCleanup', 'DISM component store cleanup', dryRun, 'clean')
    }
    if (target.id === 'cleanmgr') {
      return this.runCommand('cleanmgr.exe', ['/sagerun:1'], {
        kind: 'clean',
        label: 'Run Disk Cleanup profile 1',
        dryRun
      })
    }
    if (target.id === 'cleanmgr-sageset') {
      return this.runCommand('cleanmgr.exe', ['/sageset:1'], {
        kind: 'clean',
        label: 'Open Disk Cleanup sageset UI',
        dryRun
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
      return this.runElevatedPowerShell('Clear-BCCache -Force -ErrorAction SilentlyContinue; "BranchCache cleared."', 'Clear BranchCache', dryRun, 'clean')
    }
    if (target.id === 'store-cache') {
      return this.runCommand('wsreset.exe', [], { kind: 'clean', label: 'Reset Microsoft Store cache', dryRun })
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

  private async estimateTargets(targets: CleanTarget[]): Promise<Record<string, number>> {
    const json = JSON.stringify(targets.map((target) => ({ id: target.id, paths: target.paths.map(expandEnv) })))
    const script = [
      `$targetsJson = @'\n${json}\n'@`,
      '$targets = $targetsJson | ConvertFrom-Json',
      '$result = @{}',
      'foreach ($target in $targets) {',
      '  $total = 0',
      '  foreach ($p in $target.paths) {',
      '    Get-ChildItem -Path $p -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object { if (-not $_.PSIsContainer) { $total += $_.Length } }',
      '  }',
      '  $result[$target.id] = $total',
      '}',
      '$result | ConvertTo-Json -Compress'
    ].join('\n')
    const result = await this.runPowerShell(script, { kind: 'clean', label: 'Estimate cleanup target sizes' })
    try {
      return JSON.parse(result.stdout.trim()) as Record<string, number>
    } catch {
      return {}
    }
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

  private async queryGamingTweaksState(): Promise<{ overlayDisabled: boolean; gameDvrDisabled: boolean }> {
    const script = [
      "$overlay = Get-ItemPropertyValue -Path 'HKCU:\\Software\\NVIDIA Corporation\\Global\\ShadowPlay' -Name 'EnableInGameOverlay' -ErrorAction SilentlyContinue",
      "$shadow = Get-ItemPropertyValue -Path 'HKCU:\\Software\\NVIDIA Corporation\\Global\\ShadowPlay' -Name 'ShadowPlayEnabled' -ErrorAction SilentlyContinue",
      "$dvr = Get-ItemPropertyValue -Path 'HKCU:\\System\\GameConfigStore' -Name 'GameDVR_Enabled' -ErrorAction SilentlyContinue",
      "$capture = Get-ItemPropertyValue -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Name 'AppCaptureEnabled' -ErrorAction SilentlyContinue",
      "[pscustomobject]@{ overlayDisabled = (($overlay -eq 0 -or $null -eq $overlay) -and ($shadow -eq 0 -or $null -eq $shadow)); gameDvrDisabled = (($dvr -eq 0 -or $null -eq $dvr) -and ($capture -eq 0 -or $null -eq $capture)) } | ConvertTo-Json -Compress"
    ].join('\n')
    const result = await this.runPowerShell(script, { kind: 'nvidia', label: 'Inspect Windows/NVIDIA gaming tweak state' })
    try {
      return JSON.parse(result.stdout.trim()) as { overlayDisabled: boolean; gameDvrDisabled: boolean }
    } catch {
      return { overlayDisabled: false, gameDvrDisabled: false }
    }
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
    return this.runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], options)
  }

  private async runElevatedPowerShell(script: string, label: string, _dryRun: boolean, kind: CommandLogEntry['kind']): Promise<CommandLogEntry> {
    const workDir = join(this.dataDir, 'elevated')
    mkdirSync(workDir, { recursive: true })
    const resultFile = join(workDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    const helperScript = join(workDir, `${Date.now()}-helper.ps1`)
    const wrapped = `
$ErrorActionPreference = 'Continue'
$out = ''
$err = ''
$code = 0
try {
  $out = & {
${script
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
  } 2>&1 | Out-String
  if ($LASTEXITCODE -ne $null) { $code = $LASTEXITCODE }
} catch {
  $err = $_ | Out-String
  $code = 1
}
[pscustomobject]@{ stdout = $out; stderr = $err; exitCode = $code } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath '${escapePowerShellSingle(resultFile)}' -Encoding UTF8
`
    writeFileSync(helperScript, wrapped, 'utf8')
    const launch = await this.runCommandRaw(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escapePowerShellSingle(helperScript)}')`
      ],
      true
    )

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
      stderr = `${stderr}\nElevated action did not return a result. UAC may have been cancelled or blocked.`.trim()
      exitCode = exitCode === 0 ? 1 : exitCode
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

  private async runCommandRaw(command: string, args: string[], elevated = false): Promise<Omit<CommandLogEntry, 'id' | 'timestamp' | 'kind' | 'label' | 'dryRun'>> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
      child.on('error', (error) => {
        resolve({ command, args, stdout, stderr: `${stderr}${error.message}`, exitCode: 1, success: false, elevated })
      })
      child.on('close', (code) => {
        resolve({ command, args, stdout, stderr, exitCode: code, success: code === 0, elevated })
      })
    })
  }

  private async runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandLogEntry> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
      child.on('error', (error) => {
        resolve(
          this.addLog({
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
        )
      })
      child.on('close', (code) => {
        resolve(
          this.addLog({
            kind: options.kind,
            label: options.label,
            command,
            args,
            stdout,
            stderr,
            exitCode: code,
            success: code === 0,
            dryRun: false,
            elevated: Boolean(options.elevated)
          })
        )
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
    const full = { id: cryptoId(), timestamp: new Date().toISOString(), ...entry }
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

function parseCsv(text: string): Record<string, string>[] {
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
  const headers = rows.shift() ?? []
  return rows.map((values) =>
    headers.reduce<Record<string, string>>((acc, header, index) => {
      acc[header] = values[index] ?? ''
      return acc
    }, {})
  )
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
    'foreach ($p in $paths) {',
    '  if (Test-Path -Path $p) {',
    '    Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue',
    '  }',
    '}',
    '"Deleted candidates: $($paths.Count)"'
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

function taskStateScript(taskPath: string, enable: boolean): string {
  const task = escapePowerShellSingle(taskPath)
  const switchName = enable ? '/Enable' : '/Disable'
  const expected = enable ? 'Enabled' : 'Disabled'
  return `
$tn = '${task}'
$output = ''
if ('${enable ? '1' : '0'}' -eq '0') {
  $output += (schtasks.exe /End /TN $tn 2>&1 | Out-String)
}
$output += (schtasks.exe /Change /TN $tn ${switchName} 2>&1 | Out-String)
$csv = schtasks.exe /Query /TN $tn /FO CSV /V 2>&1
if ($LASTEXITCODE -ne 0) { $output += ($csv | Out-String); $output; exit 1 }
$rows = $csv | ConvertFrom-Csv
$state = @($rows)[0].'Scheduled Task State'
$output += "Scheduled Task State: $state"
$output
if ($state -ne '${expected}') { exit 1 }
`
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
