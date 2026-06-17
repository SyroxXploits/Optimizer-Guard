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
  settings: { dryRun: true, preferredResolution: '2560x1440', lastTab: 'tasks' },
  logs: [
    {
      id: 'demo-log-1',
      timestamp: new Date().toISOString(),
      kind: 'nvidia',
      label: 'Preview NVIDIA optimizer profile',
      command: 'internal',
      args: ['Quality', 'Transformer if available', 'On + Boost'],
      stdout: 'Dry-run profile saved for preview.',
      stderr: '',
      exitCode: 0,
      success: true,
      dryRun: true,
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
  appVersion: async () => '1.0.0',
  checkForUpdates: async () => ({
    currentVersion: '1.0.0',
    latestVersion: '1.0.0',
    releaseName: 'Optimizer Guard v1.0.0',
    releaseUrl: 'https://github.com/SyroxXploits/Optimizer-Guard/releases/tag/v1.0.0',
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
        dangerous: false
      },
      {
        id: 'disable-overlay',
        label: 'Disable NVIDIA overlay',
        description: 'Turns off common NVIDIA Share/In-game overlay flags.',
        requiresAdmin: false,
        dangerous: false
      },
      {
        id: 'game-mode',
        label: 'Enable Game Mode',
        description: 'Enables Windows Game Mode for foreground game prioritization.',
        requiresAdmin: false,
        dangerous: false
      },
      {
        id: 'disable-game-dvr',
        label: 'Disable Xbox Game DVR capture',
        description: 'Disables background recording/Game DVR registry flags.',
        requiresAdmin: false,
        dangerous: false
      }
    ]
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
  setTaskState: (taskPath: string, enable: boolean, dryRun: boolean): Promise<CommandLogEntry> =>
    ipcRenderer.invoke('tasks:set-state', taskPath, enable, dryRun),

  queryFeatures: (): Promise<FeatureToggle[]> => ipcRenderer.invoke('features:query'),
  setFeatureState: (featureName: string, enable: boolean, dryRun: boolean): Promise<CommandLogEntry> =>
    ipcRenderer.invoke('features:set-state', featureName, enable, dryRun),

  scanCleaning: (): Promise<CleanTarget[]> => ipcRenderer.invoke('clean:scan'),
  cleanSelected: (ids: string[], dryRun: boolean): Promise<CleanResult> => ipcRenderer.invoke('clean:run', ids, dryRun),

  getNvidiaState: (): Promise<NvidiaState> => ipcRenderer.invoke('nvidia:state'),
  applyNvidiaProfile: (request: ApplyNvidiaProfileRequest, dryRun: boolean): Promise<CommandLogEntry[]> =>
    ipcRenderer.invoke('nvidia:apply', request, dryRun),

  restore: (id: string, dryRun: boolean): Promise<CommandLogEntry | null> => ipcRenderer.invoke('restore:run', id, dryRun)
}

contextBridge.exposeInMainWorld('optimizerGuard', optimizerGuard)

declare global {
  interface Window {
    optimizerGuard: typeof optimizerGuard
  }
}
