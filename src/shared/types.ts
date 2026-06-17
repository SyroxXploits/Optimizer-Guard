export type ActionKind = 'task' | 'feature' | 'clean' | 'nvidia' | 'system' | 'restore'

export interface CommandLogEntry {
  id: string
  timestamp: string
  kind: ActionKind
  label: string
  command: string
  args: string[]
  stdout: string
  stderr: string
  exitCode: number | null
  success: boolean
  dryRun: boolean
  elevated: boolean
}

export interface RestoreEntry {
  id: string
  timestamp: string
  kind: 'task' | 'feature' | 'registry' | 'nvidia-cache'
  label: string
  command: string
  args: string[]
  elevated: boolean
  applied: boolean
}

export interface ScheduledTaskRow {
  name: string
  path: string
  status: string
  nextRun: string
  lastRun: string
  author: string
  taskToRun: string
  enabled: boolean
  microsoft: boolean
  critical: boolean
}

export interface FeatureToggle {
  id: string
  label: string
  featureName: string
  state: string
  restartLikely: boolean
  description: string
}

export interface CpuInfo {
  name: string
  cores: number
  threads: number
  baseClockMhz: number | null
  maxClockMhz: number | null
  usagePercent: number | null
  perCoreUsage: number[]
  overclockNote: string
}

export interface GpuInfo {
  name: string
  vramMb: number | null
  driverVersion: string
  usagePercent: number | null
  temperatureC: number | null
  resizableBar: 'Enabled' | 'Disabled' | 'Unknown'
  frameGeneration: 'Supported' | 'Not supported' | 'Unknown'
}

export interface DisplayInfo {
  name: string
  width: number
  height: number
  refreshRate: number
  primary: boolean
}

export interface SystemInfo {
  isAdmin: boolean
  biosVendor: string
  biosVersion: string
  biosDate: string
  motherboardManufacturer: string
  motherboardModel: string
  cpu: CpuInfo
  gpu: GpuInfo
  displays: DisplayInfo[]
  memoryGb: number | null
  powerPlan: string
  gameMode: 'Enabled' | 'Disabled' | 'Unknown'
  hags: 'Enabled' | 'Disabled' | 'Unknown'
}

export interface CleanTarget {
  id: string
  label: string
  description: string
  estimatedBytes: number
  paths: string[]
  detected: boolean
  selectedByDefault: boolean
  requiresAdmin: boolean
  dangerous: boolean
  commandOnly?: boolean
}

export interface CleanResult {
  beforeBytes: number
  afterBytes: number
  savedBytes: number
  logs: CommandLogEntry[]
}

export interface NvidiaProfile {
  gpuName: string
  driverVersion: string
  detectedResolution: string
  preferredResolution: string
  dlssMode: 'Quality' | 'Balanced' | 'Performance' | 'Ultra Performance'
  dlssPreset: 'Default/Auto' | 'C' | 'D' | 'E' | 'F' | 'J' | 'Transformer if available'
  reflex: 'On' | 'On + Boost' | 'Off'
  frameGeneration: 'Off' | 'On if supported'
  useCase: 'Competitive' | 'Balanced' | 'Single-player visuals'
  notes: string[]
}

export interface NvidiaAction {
  id: string
  label: string
  description: string
  requiresAdmin: boolean
  dangerous: boolean
}

export interface NvidiaState {
  profile: NvidiaProfile
  actions: NvidiaAction[]
}

export interface ApplyNvidiaProfileRequest {
  profile: NvidiaProfile
  patchNvidiaAppResolution: boolean
  disableOverlay: boolean
  setGameMode: boolean
  disableGameDvr: boolean
}

export interface AppSettings {
  dryRun: boolean
  preferredResolution: string
  lastTab: string
}

export interface AppSnapshot {
  settings: AppSettings
  logs: CommandLogEntry[]
  restoreHistory: RestoreEntry[]
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  releaseName: string
  releaseUrl: string
  publishedAt?: string
  isUpdateAvailable: boolean
  error?: string
}
