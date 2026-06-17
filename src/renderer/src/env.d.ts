/// <reference types="vite/client" />

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
  getNvidiaState: () => Promise<NvidiaState>
  applyNvidiaProfile: (request: ApplyNvidiaProfileRequest) => Promise<CommandLogEntry[]>
  restore: (id: string) => Promise<CommandLogEntry | null>
}

declare global {
  interface Window {
    optimizerGuard: OptimizerGuardApi
  }
}
