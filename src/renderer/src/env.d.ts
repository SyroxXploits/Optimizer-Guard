/// <reference types="vite/client" />

import type {
  AppSettings,
  AppSnapshot,
  ApplyNvidiaProfileRequest,
  BatchUninstallRequest,
  BatchUninstallResult,
  CleanResult,
  CleanTarget,
  CommandLogEntry,
  FeatureToggle,
  InstalledApp,
  LeftoverCandidate,
  LeftoverRemovalResult,
  NvidiaState,
  OperationProgress,
  ScheduledTaskRow,
  SystemInfo,
  UninstallLaunchResult,
  UpdateCheckResult
} from '../../shared/types'

interface OptimizerGuardApi {
  appVersion: () => Promise<string>
  checkForUpdates: () => Promise<UpdateCheckResult>
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  getSettings: () => Promise<AppSettings>
  setSettings: (settings: AppSettings) => Promise<AppSettings>
  getSnapshot: () => Promise<AppSnapshot>
  openLogs: () => Promise<void>
  getLogPath: () => Promise<string>
  exportSettings: () => Promise<string>
  isAdmin: () => Promise<boolean>
  getSystemInfo: () => Promise<SystemInfo>
  queryTasks: () => Promise<ScheduledTaskRow[]>
  setTaskState: (taskPath: string, enable: boolean) => Promise<CommandLogEntry>
  queryFeatures: () => Promise<FeatureToggle[]>
  setFeatureState: (featureName: string, enable: boolean) => Promise<CommandLogEntry>
  scanCleaning: () => Promise<CleanTarget[]>
  cleanSelected: (ids: string[]) => Promise<CleanResult>
  onOperationProgress: (callback: (progress: OperationProgress) => void) => () => void
  queryInstalledApps: () => Promise<InstalledApp[]>
  launchUninstaller: (appId: string) => Promise<UninstallLaunchResult>
  batchUninstall: (request: BatchUninstallRequest) => Promise<BatchUninstallResult>
  scanUninstallLeftovers: (appId: string) => Promise<LeftoverCandidate[]>
  scanUninstallLeftoversMany: (appIds: string[]) => Promise<LeftoverCandidate[]>
  removeUninstallLeftovers: (ids: string[]) => Promise<LeftoverRemovalResult>
  getNvidiaState: () => Promise<NvidiaState>
  applyNvidiaProfile: (request: ApplyNvidiaProfileRequest) => Promise<CommandLogEntry[]>
  restore: (id: string) => Promise<CommandLogEntry | null>
}

declare global {
  interface Window {
    optimizerGuard: OptimizerGuardApi
  }
}
