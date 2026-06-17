import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  AppSnapshot,
  ApplyNvidiaProfileRequest,
  CleanResult,
  CleanTarget,
  CommandLogEntry,
  FeatureToggle,
  NvidiaState,
  ScheduledTaskRow,
  SystemInfo,
  UpdateCheckResult
} from '../shared/types'

const demoSnapshot = {
  settings: { preferredResolution: '2560x1440', lastTab: 'tasks' },
  logs: [
    {
      id: 'demo-log-1',
      timestamp: new Date().toISOString(),
      kind: 'nvidia',
      label: 'Apply NVIDIA optimizer profile',
      command: 'internal',
      args: ['Quality', 'Transformer if available', 'On + Boost'],
      stdout: 'Optimizer profile applied in demo mode.',
      stderr: '',
      exitCode: 0,
      success: true,
      dryRun: false,
      elevated: false
    }
  ],
  restoreHistory: [
    {
      id: 'demo-restore-1',
      timestamp: new Date().toISOString(),
      kind: 'task',
      label: 'Re-enable Adobe Acrobat Update Task',
      command: 'schtasks.exe',
      args: ['/Change', '/TN', '\\Adobe Acrobat Update Task', '/Enable'],
      elevated: false,
      applied: false
    }
  ]
} as AppSnapshot

const demoApi = {
  appVersion: async () => '1.0.6',
  checkForUpdates: async () => ({
    currentVersion: '1.0.6',
    latestVersion: '1.0.6',
    releaseName: 'Optimizer Guard v1.0.6',
    releaseUrl: 'https://github.com/SyroxXploits/Optimizer-Guard/releases/tag/v1.0.6',
    isUpdateAvailable: false
  }),
  minimize: async () => undefined,
  toggleMaximize: async () => undefined,
  close: async () => undefined,
  openExternal: async () => undefined,
  getSettings: async () => demoSnapshot.settings,
  setSettings: async (settings: AppSettings) => ({ ...settings }),
  getSnapshot: async () => demoSnapshot,
  openLogs: async () => undefined,
  getLogPath: async () => 'demo-actions.json',
  exportSettings: async () => 'optimizer-guard-export-demo.json',
  isAdmin: async () => false,
  getSystemInfo: async () => ({
    isAdmin: false,
    biosVendor: 'American Megatrends',
    biosVersion: 'A.90',
    biosDate: '2026-05-12',
    motherboardManufacturer: 'MSI',
    motherboardModel: 'MAG X670E TOMAHAWK WIFI',
    memoryGb: 32,
    powerPlan: 'Ultimate Performance',
    gameMode: 'Enabled',
    hags: 'Enabled',
    cpu: {
      name: 'AMD Ryzen 7 7800X3D',
      cores: 8,
      threads: 16,
      baseClockMhz: 4200,
      maxClockMhz: 5050,
      currentClockMhz: 4850,
      usagePercent: 18,
      perCoreUsage: [12, 18, 8, 27, 33, 15, 10, 22, 14, 21, 9, 31, 18, 16, 12, 20],
      overclockNote: 'AMD Ryzen desktop chips are often unlocked; motherboard/BIOS support matters.'
    },
    gpu: {
      name: 'NVIDIA GeForce RTX 4070 Ti SUPER',
      vramMb: 16376,
      driverVersion: '610.47',
      usagePercent: 34,
      temperatureC: 58,
      graphicsClockMhz: 2745,
      memoryClockMhz: 10501,
      maxGraphicsClockMhz: 2820,
      resizableBar: 'Enabled',
      frameGeneration: 'Supported'
    },
    displays: [
      { name: 'Primary 27 inch QHD', width: 2560, height: 1440, refreshRate: 244, primary: true },
      { name: 'Secondary 24 inch FHD', width: 1920, height: 1080, refreshRate: 144, primary: false }
    ]
  }),
  queryTasks: async () => [
    {
      name: 'Adobe Acrobat Update Task',
      path: '\\Adobe Acrobat Update Task',
      status: 'Ready',
      nextRun: '2026-06-18 10:00',
      lastRun: '2026-06-17 08:12',
      author: 'Adobe Systems',
      taskToRun: 'AdobeARM.exe',
      enabled: true,
      microsoft: false,
      critical: false
    },
    {
      name: 'OneDrive Standalone Update Task',
      path: '\\OneDrive Standalone Update Task-S-1-5-21-demo',
      status: 'Disabled',
      nextRun: 'N/A',
      lastRun: '2026-06-16 19:44',
      author: 'Microsoft Corporation',
      taskToRun: 'OneDriveStandaloneUpdater.exe',
      enabled: false,
      microsoft: false,
      critical: false
    },
    {
      name: 'NvProfileUpdaterDaily',
      path: '\\NVIDIA\\NvProfileUpdaterDaily',
      status: 'Ready',
      nextRun: '2026-06-18 03:00',
      lastRun: '2026-06-17 03:00',
      author: 'NVIDIA',
      taskToRun: 'NvProfileUpdater64.exe',
      enabled: true,
      microsoft: false,
      critical: false
    },
    {
      name: 'Windows Defender Scheduled Scan',
      path: '\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan',
      status: 'Ready',
      nextRun: '2026-06-18 02:00',
      lastRun: '2026-06-17 02:00',
      author: 'Microsoft Corporation',
      taskToRun: 'MpCmdRun.exe',
      enabled: true,
      microsoft: true,
      critical: true
    }
  ],
  setTaskState: async () => demoSnapshot.logs[0],
  queryFeatures: async () => [
    {
      id: 'hyperv',
      label: 'Hyper-V',
      featureName: 'Microsoft-Hyper-V-All',
      state: 'Enabled',
      restartLikely: true,
      description: 'Windows hypervisor platform. Disabling can help some gaming latency setups but affects WSL2, Docker, VMs, and emulators.'
    }
  ],
  setFeatureState: async () => demoSnapshot.logs[0],
  scanCleaning: async () => [
    {
      id: 'user-temp',
      label: 'User temp files',
      description: 'Your user temp folder only. Personal folders are never touched.',
      estimatedBytes: 1342177280,
      paths: ['%TEMP%\\*'],
      detected: true,
      selectedByDefault: true,
      requiresAdmin: false,
      dangerous: false
    },
    {
      id: 'gpu-shader-cache',
      label: 'NVIDIA/AMD shader cache',
      description: 'GPU driver shader caches that games can rebuild.',
      estimatedBytes: 912680550,
      paths: ['%LOCALAPPDATA%\\NVIDIA\\DXCache\\*'],
      detected: true,
      selectedByDefault: true,
      requiresAdmin: false,
      dangerous: false
    },
    {
      id: 'browser-cache',
      label: 'Browser cache: Edge/Chrome/Firefox',
      description: 'Cache folders only, not bookmarks, passwords, history, or downloads.',
      estimatedBytes: 724566016,
      paths: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Cache\\*'],
      detected: true,
      selectedByDefault: true,
      requiresAdmin: false,
      dangerous: false
    },
    {
      id: 'launcher-caches',
      label: 'Game launcher caches',
      description: 'Epic, Battle.net, EA, Ubisoft, and Riot launcher cache folders only.',
      estimatedBytes: 398458880,
      paths: ['%LOCALAPPDATA%\\EpicGamesLauncher\\Saved\\webcache*\\*'],
      detected: true,
      selectedByDefault: true,
      requiresAdmin: false,
      dangerous: false
    },
    {
      id: 'windows-update-downloads',
      label: 'Windows Update download cache',
      description: 'Downloaded update payload cache. Windows can download needed files again.',
      estimatedBytes: 2159017984,
      paths: ['%WINDIR%\\SoftwareDistribution\\Download\\*'],
      detected: true,
      selectedByDefault: false,
      requiresAdmin: true,
      dangerous: false
    },
    {
      id: 'icon-cache',
      label: 'Icon cache',
      description: 'Windows Explorer icon cache files. Explorer may rebuild icons after cleanup.',
      estimatedBytes: 91357184,
      paths: ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer\\iconcache_*.db'],
      detected: true,
      selectedByDefault: true,
      requiresAdmin: false,
      dangerous: false
    },
    {
      id: 'dism-component-store',
      label: 'Component store cleanup',
      description: 'Runs DISM StartComponentCleanup. Needs admin and can take a while.',
      estimatedBytes: 0,
      paths: [],
      detected: true,
      selectedByDefault: false,
      requiresAdmin: true,
      dangerous: false,
      commandOnly: true
    }
  ],
  cleanSelected: async () => ({ beforeBytes: 2254857830, afterBytes: 0, savedBytes: 2254857830, logs: demoSnapshot.logs }),
  getNvidiaState: async () => ({
    profile: {
      gpuName: 'NVIDIA GeForce RTX 4070 Ti SUPER',
      driverVersion: '610.47',
      detectedResolution: '2560x1440',
      preferredResolution: '2560x1440',
      dlssMode: 'Quality',
      dlssPreset: 'Transformer if available',
      reflex: 'On + Boost',
      frameGeneration: 'On if supported',
      useCase: 'Balanced',
      notes: [
        '1440p usually wants DLSS Quality for visuals or Balanced when FPS is weak.',
        'Frame Generation is best for single-player smoothness, not strict competitive latency.',
        'Preset letters are suggestions for NVIDIA App/Profile Inspector style workflows.'
      ]
    },
    actions: [
      {
        id: 'patch-nvidia-resolution',
        label: 'Patch NVIDIA App recommendation resolution',
        description: 'Backs up NVIDIA App metadata and replaces 3840x2160 recommendations with 2560x1440 where safe.',
        requiresAdmin: false,
        dangerous: false,
        status: '3 files already target 2560x1440, no 4K entries found.'
      },
      {
        id: 'disable-overlay',
        label: 'Disable NVIDIA overlay',
        description: 'Turns off common NVIDIA Share/In-game overlay flags.',
        requiresAdmin: false,
        dangerous: false,
        status: 'Overlay registry flags are already disabled.'
      },
      {
        id: 'game-mode',
        label: 'Enable Game Mode',
        description: 'Enables Windows Game Mode for foreground game prioritization.',
        requiresAdmin: false,
        dangerous: false,
        status: 'Game Mode is enabled.'
      },
      {
        id: 'disable-game-dvr',
        label: 'Disable Xbox Game DVR capture',
        description: 'Disables background recording/Game DVR registry flags.',
        requiresAdmin: false,
        dangerous: false,
        status: 'Game DVR capture is disabled.'
      },
      {
        id: 'disable-delivery-optimization',
        label: 'Disable Delivery Optimization',
        description: 'Sets DoSvc Start to 4 and stops the Delivery Optimization service.',
        requiresAdmin: true,
        dangerous: false,
        status: 'Delivery Optimization Start=3, service Running.'
      }
    ],
    patchStatus: {
      checked: true,
      targetResolution: '2560x1440',
      patchedFiles: 3,
      unpatched4kFiles: 0,
      folderFound: true
    }
  }),
  applyNvidiaProfile: async () => demoSnapshot.logs,
  restore: async () => demoSnapshot.logs[0]
}

const optimizerGuard = process.env.OPTIMIZER_GUARD_DEMO === '1' ? demoApi : {
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('app:check-updates'),
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke('settings:set', settings),
  getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke('snapshot:get'),
  openLogs: (): Promise<void> => ipcRenderer.invoke('logs:open'),
  getLogPath: (): Promise<string> => ipcRenderer.invoke('logs:path'),
  exportSettings: (): Promise<string> => ipcRenderer.invoke('settings:export'),

  isAdmin: (): Promise<boolean> => ipcRenderer.invoke('system:is-admin'),
  getSystemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke('system:info'),

  queryTasks: (): Promise<ScheduledTaskRow[]> => ipcRenderer.invoke('tasks:query'),
  setTaskState: (taskPath: string, enable: boolean): Promise<CommandLogEntry> =>
    ipcRenderer.invoke('tasks:set-state', taskPath, enable),

  queryFeatures: (): Promise<FeatureToggle[]> => ipcRenderer.invoke('features:query'),
  setFeatureState: (featureName: string, enable: boolean): Promise<CommandLogEntry> =>
    ipcRenderer.invoke('features:set-state', featureName, enable),

  scanCleaning: (): Promise<CleanTarget[]> => ipcRenderer.invoke('clean:scan'),
  cleanSelected: (ids: string[]): Promise<CleanResult> => ipcRenderer.invoke('clean:run', ids),

  getNvidiaState: (): Promise<NvidiaState> => ipcRenderer.invoke('nvidia:state'),
  applyNvidiaProfile: (request: ApplyNvidiaProfileRequest): Promise<CommandLogEntry[]> =>
    ipcRenderer.invoke('nvidia:apply', request),

  restore: (id: string): Promise<CommandLogEntry | null> => ipcRenderer.invoke('restore:run', id)
}

contextBridge.exposeInMainWorld('optimizerGuard', optimizerGuard)

declare global {
  interface Window {
    optimizerGuard: typeof optimizerGuard
  }
}
