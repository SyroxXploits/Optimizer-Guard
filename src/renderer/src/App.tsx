import { useEffect, useState } from 'react'
import type React from 'react'
import {
  Activity,
  AppWindow,
  Brush,
  CheckCircle2,
  ChevronRight,
  Cpu,
  DatabaseBackup,
  Download,
  Eraser,
  ExternalLink,
  FileText,
  Gauge,
  Github,
  HardDrive,
  Info,
  Maximize2,
  Minus,
  Monitor,
  PackageOpen,
  Palette,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import type {
  AppSettings,
  AppSnapshot,
  ApplyNvidiaProfileRequest,
  CleanTarget,
  CommandLogEntry,
  FeatureToggle,
  InstalledApp,
  LeftoverCandidate,
  NvidiaProfile,
  NvidiaState,
  OperationProgress,
  ScheduledTaskRow,
  SystemInfo,
  UpdateCheckResult
} from '../../shared/types'

type TabId = 'tasks' | 'system' | 'cleaning' | 'uninstaller' | 'nvidia' | 'logs' | 'about'
type ThemeId = 'mint' | 'blue' | 'violet' | 'amber' | 'mono'
type NvidiaActionKey = keyof Omit<ApplyNvidiaProfileRequest, 'profile'>

const tabs: Array<{ id: TabId; label: string; icon: typeof Gauge }> = [
  { id: 'tasks', label: 'Tasks', icon: Gauge },
  { id: 'system', label: 'System', icon: Cpu },
  { id: 'cleaning', label: 'Cleaning', icon: Eraser },
  { id: 'uninstaller', label: 'Uninstaller', icon: PackageOpen },
  { id: 'nvidia', label: 'NVIDIA', icon: Sparkles },
  { id: 'logs', label: 'Logs', icon: DatabaseBackup },
  { id: 'about', label: 'About', icon: Info }
]

const themes: Array<{ id: ThemeId; label: string }> = [
  { id: 'mint', label: 'Mint' },
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'amber', label: 'Amber' },
  { id: 'mono', label: 'Mono' }
]

const nvidiaActionKeys: Record<string, NvidiaActionKey> = {
  'patch-nvidia-resolution': 'patchNvidiaAppResolution',
  'disable-overlay': 'disableOverlay',
  'game-mode': 'setGameMode',
  'disable-game-dvr': 'disableGameDvr',
  'disable-delivery-optimization': 'disableDeliveryOptimization'
}

const defaultSettings: AppSettings = {
  preferredResolution: '2560x1440',
  lastTab: 'tasks'
}

function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [activeTab, setActiveTab] = useState<TabId>('tasks')
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('Ready. Actions apply only when you click them.')
  const [version, setVersion] = useState('')
  const [operationProgress, setOperationProgress] = useState<OperationProgress | null>(null)
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = localStorage.getItem('optimizer-theme') as ThemeId | null
    return themes.some((item) => item.id === saved) ? saved! : 'mint'
  })

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('optimizer-theme', theme)
  }, [theme])

  useEffect(() => window.optimizerGuard.onOperationProgress(setOperationProgress), [])

  async function bootstrap(): Promise<void> {
    const [loadedSettings, loadedSnapshot, appVersion] = await Promise.all([
      window.optimizerGuard.getSettings(),
      window.optimizerGuard.getSnapshot(),
      window.optimizerGuard.appVersion()
    ])
    setSettings(loadedSettings)
    setActiveTab((loadedSettings.lastTab as TabId) || 'tasks')
    setSnapshot(loadedSnapshot)
    setVersion(appVersion)
  }

  async function saveSettings(next: AppSettings): Promise<void> {
    setSettings(next)
    await window.optimizerGuard.setSettings(next)
  }

  async function refreshSnapshot(): Promise<void> {
    setSnapshot(await window.optimizerGuard.getSnapshot())
  }

  async function switchTab(id: TabId): Promise<void> {
    setActiveTab(id)
    await saveSettings({ ...settings, lastTab: id })
  }

  async function runBusy<T>(label: string, task: () => Promise<T>, success?: string): Promise<T | null> {
    setBusy(label)
    try {
      const value = await task()
      if (success) setNotice(success)
      await refreshSnapshot()
      return value
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <ShieldCheck size={25} />
          </div>
          <div>
            <span>Optimizer Guard</span>
            <small>PC tuning toolkit</small>
          </div>
        </div>
        <nav>
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button className={activeTab === tab.id ? 'nav-item active' : 'nav-item'} key={tab.id} onClick={() => void switchTab(tab.id)}>
                <Icon size={18} />
                {tab.label}
              </button>
            )
          })}
        </nav>
        <div className="theme-card">
          <div>
            <Palette size={15} />
            <strong>Theme</strong>
          </div>
          <div className="theme-dots">
            {themes.map((item) => (
              <button
                aria-label={`Use ${item.label} theme`}
                className={theme === item.id ? `theme-dot ${item.id} active` : `theme-dot ${item.id}`}
                key={item.id}
                onClick={() => setTheme(item.id)}
                title={item.label}
              />
            ))}
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="titlebar">
          <div className="drag-region">
            <span className="pill live">v{version || 'dev'}</span>
            <span className="muted">{notice}</span>
          </div>
          <button className="window-button" onClick={() => void window.optimizerGuard.minimize()}>
            <Minus size={15} />
          </button>
          <button className="window-button" onClick={() => void window.optimizerGuard.toggleMaximize()}>
            <Maximize2 size={14} />
          </button>
          <button className="window-button close" onClick={() => void window.optimizerGuard.close()}>
            <X size={15} />
          </button>
        </header>

        {busy && (
          <div className="busy">
            <RefreshCw size={16} className="spin" />
            {busy}
          </div>
        )}

        {activeTab === 'tasks' && (
          <TaskDisabler settings={settings} runBusy={runBusy} setNotice={setNotice} snapshot={snapshot} />
        )}
        {activeTab === 'system' && <SystemPanel runBusy={runBusy} />}
        {activeTab === 'cleaning' && (
          <CleaningPanel settings={settings} runBusy={runBusy} setNotice={setNotice} progress={operationProgress} />
        )}
        {activeTab === 'uninstaller' && (
          <UninstallerPanel runBusy={runBusy} setNotice={setNotice} progress={operationProgress} />
        )}
        {activeTab === 'nvidia' && (
          <NvidiaPanel settings={settings} saveSettings={saveSettings} runBusy={runBusy} setNotice={setNotice} />
        )}
        {activeTab === 'logs' && <LogsPanel snapshot={snapshot} settings={settings} runBusy={runBusy} refreshSnapshot={refreshSnapshot} />}
        {activeTab === 'about' && <AboutPanel runBusy={runBusy} version={version} />}
      </main>
    </div>
  )
}

function TaskDisabler({
  settings,
  runBusy,
  setNotice,
  snapshot
}: {
  settings: AppSettings
  runBusy: <T>(label: string, task: () => Promise<T>, success?: string) => Promise<T | null>
  setNotice: (notice: string) => void
  snapshot: AppSnapshot | null
}): JSX.Element {
  const [tasks, setTasks] = useState<ScheduledTaskRow[]>([])
  const [features, setFeatures] = useState<FeatureToggle[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled' | 'microsoft' | 'user'>('enabled')

  useEffect(() => {
    void refresh()
  }, [])

  async function refresh(): Promise<void> {
    await runBusy('Querying scheduled tasks and optional features...', async () => {
      const [taskRows, featureRows] = await Promise.all([window.optimizerGuard.queryTasks(), window.optimizerGuard.queryFeatures()])
      setTasks(taskRows)
      setFeatures(featureRows)
      return taskRows
    }, 'Task list refreshed.')
  }

  const filtered = tasks
    .filter((task) => {
      if (filter === 'enabled') return task.enabled
      if (filter === 'disabled') return !task.enabled
      if (filter === 'microsoft') return task.microsoft
      if (filter === 'user') return !task.microsoft
      return true
    })
    .filter((task) => `${task.path} ${task.author} ${task.taskToRun}`.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 500)

  async function toggleTask(task: ScheduledTaskRow, enable: boolean): Promise<void> {
    if (task.critical && !window.confirm(`"${task.name}" looks like a Microsoft/security/system task.\n\nChanging it can reduce Windows protection or maintenance. Continue anyway?`)) return
    await runBusy(`${enable ? 'Enabling' : 'Disabling'} ${task.path}`, async () => {
      const result = await window.optimizerGuard.setTaskState(task.path, enable)
      assertCommandSuccess(result)
      setTasks((current) =>
        current.map((row) =>
          row.path === task.path
            ? {
                ...row,
                enabled: enable,
                status: enable ? 'Ready' : 'Disabled',
                nextRun: enable ? row.nextRun : ''
              }
            : row
        )
      )
      await refresh()
      return result
    }, `${enable ? 'Enabled' : 'Disabled'} ${task.path}`)
  }

  async function toggleFeature(feature: FeatureToggle, enable: boolean): Promise<void> {
    if (!window.confirm(`${enable ? 'Enable' : 'Disable'} ${feature.label}? A restart may be required.`)) return
    await runBusy(`${enable ? 'Enabling' : 'Disabling'} ${feature.label}`, async () => {
      const result = await window.optimizerGuard.setFeatureState(feature.featureName, enable)
      assertCommandSuccess(result)
      setFeatures(await window.optimizerGuard.queryFeatures())
      return result
    }, `Applied ${feature.label}. Restart required may be shown by Windows.`)
  }

  return (
    <section className="page">
      <PageHero
        eyebrow="Scheduled tasks"
        title="Find and toggle startup/background tasks."
        text="Search, filter, apply, and restore task changes."
        icon={<Gauge />}
      />

      <div className="toolbar">
        <div className="search">
          <Search size={16} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search task, author, command..." />
        </div>
        {(['all', 'enabled', 'disabled', 'microsoft', 'user'] as const).map((item) => (
          <button key={item} className={filter === item ? 'chip active' : 'chip'} onClick={() => setFilter(item)}>
            {item}
          </button>
        ))}
        <button className="primary" onClick={() => void refresh()}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      <div className="feature-row compact-row">
        {features.map((feature) => (
          <div className="feature-card" key={feature.id}>
            <div>
              <span className="muted">Windows optional feature</span>
              <h3>{feature.label}</h3>
              <p>{feature.description}</p>
              <span className="pill warn">
                <Shield size={13} />
                UAC per action
              </span>
              {feature.restartLikely && <span className="pill">Restart likely</span>}
            </div>
            <div className="feature-actions">
              <strong>{feature.state}</strong>
              {feature.state.toLowerCase().includes('admin') && <small>State needs UAC to read. Actions still work.</small>}
              {isFeatureEnabled(feature.state) && <button onClick={() => void toggleFeature(feature, false)}>Disable</button>}
              {isFeatureDisabled(feature.state) && <button onClick={() => void toggleFeature(feature, true)}>Enable</button>}
              {!isFeatureEnabled(feature.state) && !isFeatureDisabled(feature.state) && (
                <>
                  <button onClick={() => void toggleFeature(feature, false)}>Disable</button>
                  <button onClick={() => void toggleFeature(feature, true)}>Enable</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="table-card task-table-card">
        <div className="table-head">
          <span>{filtered.length} shown</span>
          <span>{snapshot?.restoreHistory.filter((item) => item.kind === 'task' && !item.applied).length ?? 0} task restore points</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Task name</th>
              <th>Path</th>
              <th>Status</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Author</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((task) => (
              <tr key={task.path}>
                <td>
                  <strong>{task.name}</strong>
                  {task.critical && <span className="pill danger">critical</span>}
                </td>
                <td className="mono">{task.path}</td>
                <td>
                  <TaskStatus task={task} />
                </td>
                <td>{task.nextRun}</td>
                <td>{task.lastRun}</td>
                <td>{task.author}</td>
                <td>
                  <button className={task.critical && task.enabled ? 'warn-button' : task.enabled ? 'danger-button' : 'secondary'} onClick={() => void toggleTask(task, !task.enabled)}>
                    {task.critical && task.enabled ? 'Review' : task.enabled ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tasks.length === 0 && <EmptyHint text="No tasks loaded yet. Open Logs to see whether schtasks or the ScheduledTasks fallback failed." setNotice={setNotice} />}
    </section>
  )
}

function SystemPanel({
  runBusy
}: {
  runBusy: <T>(label: string, task: () => Promise<T>, success?: string) => Promise<T | null>
}): JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load(): Promise<void> {
    const result = await runBusy('Reading BIOS, CPU, GPU, display, and NVIDIA state...', () => window.optimizerGuard.getSystemInfo(), 'System info refreshed.')
    if (result) setInfo(result)
  }

  return (
    <section className="page">
      <PageHero
        eyebrow="System"
        title="Hardware and Windows gaming state."
        text="BIOS, board, CPU, GPU, display, Game Mode, HAGS, Resizable BAR, and live usage."
        icon={<Cpu />}
      />
      <button className="primary" onClick={() => void load()}>
        <RefreshCw size={16} />
        Refresh sensors
      </button>
      {info && (
        <>
          <div className="cards-grid">
            <MetricCard icon={<Info />} label="BIOS" value={`${info.biosVendor} ${info.biosVersion}`} sub={info.biosDate} />
            <MetricCard icon={<HardDrive />} label="Motherboard" value={info.motherboardManufacturer} sub={info.motherboardModel} />
            <MetricCard icon={<DatabaseBackup />} label="Memory" value={info.memoryGb ? `${info.memoryGb} GB RAM` : 'Unknown RAM'} sub={`${info.cpu.cores} cores / ${info.cpu.threads} threads`} />
            <MetricCard icon={<Activity />} label="Power plan" value={info.powerPlan.replace('Power Scheme GUID:', '').trim()} sub={`Admin: ${info.isAdmin ? 'yes' : 'no'}`} />
            <MetricCard icon={<AppWindow />} label="Windows gaming" value={`Game Mode ${info.gameMode}`} sub={`HAGS ${info.hags}`} />
          </div>

          <div className="split">
            <div className="panel">
              <h2>CPU</h2>
              <div className="spec-list">
                <Spec label="Name" value={info.cpu.name} />
                <Spec label="Cores / Threads" value={`${info.cpu.cores} / ${info.cpu.threads}`} />
                <Spec label="Current clock" value={mhzLabel(info.cpu.currentClockMhz)} />
                <Spec label="Base / Max clock" value={`${mhzLabel(info.cpu.baseClockMhz)} / ${mhzLabel(info.cpu.maxClockMhz)}`} />
                <Spec label="Usage" value={`${info.cpu.usagePercent ?? 0}%`} />
                <Spec label="OC hint" value={info.cpu.overclockNote} />
              </div>
              <div className="core-grid">
                {info.cpu.perCoreUsage.slice(0, 32).map((usage, index) => (
                  <div className="core" key={index}>
                    <span style={{ height: `${Math.min(100, usage)}%` }} />
                    <small>{index}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel gpu-card">
              <div className="gpu-top">
                <div>
                  <span className="muted">Graphics card</span>
                  <h2>{info.gpu.name}</h2>
                </div>
                <Monitor size={40} />
              </div>
              <div className="spec-list two">
                <Spec label="VRAM" value={info.gpu.vramMb ? `${info.gpu.vramMb} MB` : 'Unknown'} />
                <Spec label="Driver" value={info.gpu.driverVersion} />
                <Spec label="Usage" value={info.gpu.usagePercent !== null ? `${info.gpu.usagePercent}%` : 'Unknown'} />
                <Spec label="Temp" value={info.gpu.temperatureC !== null ? `${info.gpu.temperatureC} C` : 'Unknown'} />
                <Spec label="GPU clock" value={mhzLabel(info.gpu.graphicsClockMhz)} />
                <Spec label="Memory clock" value={mhzLabel(info.gpu.memoryClockMhz)} />
                <Spec label="Max GPU clock" value={mhzLabel(info.gpu.maxGraphicsClockMhz)} />
                <Spec label="Resizable BAR" value={info.gpu.resizableBar} />
                <Spec label="Frame Generation" value={info.gpu.frameGeneration} />
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>Displays</h2>
            <div className="display-row">
              {info.displays.length === 0 && <span className="muted">Display query returned no monitor modes.</span>}
              {info.displays.map((display) => (
                <div className="display-card" key={`${display.name}-${display.width}-${display.height}`}>
                  <Monitor />
                  <strong>
                    {display.width}x{display.height}
                  </strong>
                  <span>{display.refreshRate ? `${display.refreshRate} Hz` : 'Refresh rate unknown'}</span>
                  {display.primary && <span className="pill live">Primary</span>}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function CleaningPanel({
  settings,
  runBusy,
  setNotice,
  progress
}: {
  settings: AppSettings
  runBusy: <T>(label: string, task: () => Promise<T>, success?: string) => Promise<T | null>
  setNotice: (notice: string) => void
  progress: OperationProgress | null
}): JSX.Element {
  const [targets, setTargets] = useState<CleanTarget[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [resultState, setResultState] = useState<'idle' | 'running' | 'finished' | 'failed'>('idle')
  const [resultText, setResultText] = useState('')
  const selectedBytes = targets.reduce((sum, target) => (selected.has(target.id) ? sum + target.estimatedBytes : sum), 0)
  const cleaningProgress = progress?.operation.startsWith('clean-') ? progress : null

  async function scan(): Promise<void> {
    setResultState('running')
    setResultText('Scanning safe cleanup locations...')
    const result = await runBusy('Scanning safe cleanup locations...', () => window.optimizerGuard.scanCleaning(), 'Scan complete. Select targets, then clean selected.')
    if (result) {
      setTargets(result)
      setSelected(new Set(result.filter((target) => target.selectedByDefault && target.detected).map((target) => target.id)))
      setResultState('finished')
      setResultText(`Quick scan finished. ${result.filter((target) => target.detected).length} cleanup categories contain removable data. Large folders use approximate sizes.`)
    } else {
      setResultState('failed')
      setResultText('Scan stopped. Open Logs for the command error.')
    }
  }

  async function clean(): Promise<void> {
    const chosen = targets.filter((target) => selected.has(target.id))
    if (chosen.length === 0) {
      setNotice('Select at least one cleanup target first.')
      return
    }
    const risky = chosen.some((target) => target.dangerous)
    const message = [
      `Clean ${chosen.length} selected target${chosen.length === 1 ? '' : 's'}?`,
      '',
      `Estimated removable data: ${formatBytes(selectedBytes)}`,
      'Personal folders and game saves are excluded.',
      risky ? 'One or more selected targets are marked dangerous.' : ''
    ]
      .filter(Boolean)
      .join('\n')
    if (!window.confirm(message)) return
    setResultState('running')
    setResultText('Cleaning selected targets...')
    const result = await runBusy('Cleaning selected targets...', async () => {
      const cleaned = await window.optimizerGuard.cleanSelected([...selected])
      assertLogsSuccess(cleaned.logs)
      return cleaned
    }, 'Cleanup finished and logged.')
    if (result) {
      if (result.targets) {
        const refreshed = new Map(result.targets.map((target) => [target.id, target]))
        setTargets((current) => current.map((target) => refreshed.get(target.id) ?? target))
        setSelected(new Set(result.targets.filter((target) => selected.has(target.id) && target.detected).map((target) => target.id)))
      }
      const finished = `Finished. Freed approximately ${formatBytes(result.savedBytes)}; ${formatBytes(result.afterBytes)} remains in selected targets.`
      setResultState('finished')
      setResultText(finished)
      setNotice(finished)
    } else {
      setResultState('failed')
      setResultText('Cleanup stopped before completion. Open Logs to see which target failed or timed out.')
    }
  }

  return (
    <section className="page">
      <PageHero
        eyebrow="Scan first, clean second"
        title="Clean safe cache targets only."
        text="Scan, review sizes, select targets, then clean. Personal folders and game saves are excluded."
        icon={<Trash2 />}
      />
      <div className="toolbar">
        <button className="primary" onClick={() => void scan()} disabled={resultState === 'running'}>
          <Search size={16} />
          Scan
        </button>
        <button className="danger-button" onClick={() => void clean()} disabled={targets.length === 0 || resultState === 'running'}>
          <Trash2 size={16} />
          Clean selected
        </button>
        <span className="pill">{selectedBytes > 0 ? `${formatBytes(selectedBytes)} selected` : 'Nothing selected'}</span>
      </div>
      {resultState !== 'idle' && (
        <OperationProgressCard
          progress={cleaningProgress}
          state={resultState}
          fallbackLabel={resultText}
        />
      )}
      <div className="clean-grid">
        {targets.map((target) => (
          <label className={target.detected ? 'clean-card' : 'clean-card dim'} key={target.id}>
            <input
              type="checkbox"
              checked={selected.has(target.id)}
              onChange={(event) => {
                const next = new Set(selected)
                if (event.target.checked) next.add(target.id)
                else next.delete(target.id)
                setSelected(next)
              }}
            />
            <div>
              <strong>{target.label}</strong>
              <p>{target.description}</p>
              <span className="muted">{cleanSizeLabel(target)}</span>
              {target.scanNote && <span className="muted">{target.scanNote}</span>}
              {target.requiresAdmin && (
                <span className="pill warn">
                  <Shield size={13} />
                  UAC
                </span>
              )}
              {target.dangerous && <span className="pill danger">confirm</span>}
            </div>
          </label>
        ))}
      </div>
      {targets.length === 0 && <EmptyHint text="Click Scan first. Cleaning stays locked until we estimate safe targets." setNotice={setNotice} />}
    </section>
  )
}

function UninstallerPanel({
  runBusy,
  setNotice,
  progress
}: {
  runBusy: <T>(label: string, task: () => Promise<T>, success?: string) => Promise<T | null>
  setNotice: (notice: string) => void
  progress: OperationProgress | null
}): JSX.Element {
  const [apps, setApps] = useState<InstalledApp[]>([])
  const [search, setSearch] = useState('')
  const [selectedApp, setSelectedApp] = useState<InstalledApp | null>(null)
  const [leftovers, setLeftovers] = useState<LeftoverCandidate[]>([])
  const [selectedLeftovers, setSelectedLeftovers] = useState<Set<string>>(new Set())
  const [launchedAppId, setLaunchedAppId] = useState('')
  const [resultState, setResultState] = useState<'idle' | 'running' | 'finished' | 'failed'>('idle')
  const [resultText, setResultText] = useState('')
  const uninstallProgress = progress?.operation.startsWith('uninstall-') ? progress : null
  const visibleApps = apps.filter((app) => `${app.name} ${app.publisher}`.toLowerCase().includes(search.toLowerCase()))
  const selectedBytes = leftovers.reduce((sum, item) => (selectedLeftovers.has(item.id) ? sum + item.sizeBytes : sum), 0)

  useEffect(() => {
    void refreshApps()
  }, [])

  async function refreshApps(): Promise<void> {
    const result = await runBusy('Reading installed applications from Windows...', () => window.optimizerGuard.queryInstalledApps())
    if (result) {
      setApps(result)
      setSelectedApp((current) => result.find((app) => app.name === current?.name && app.publisher === current?.publisher) ?? result[0] ?? null)
      setNotice(`Loaded ${result.length} uninstallable applications.`)
    }
  }

  async function launch(): Promise<void> {
    if (!selectedApp) return
    if (!window.confirm(`Run the registered uninstaller for ${selectedApp.name}?\n\nOptimizer Guard will not remove leftovers until you scan and approve them afterward.`)) return
    setResultState('running')
    setResultText('Launching the application vendor uninstaller...')
    const result = await runBusy(`Launching ${selectedApp.name} uninstaller...`, async () => {
      const launched = await window.optimizerGuard.launchUninstaller(selectedApp.id)
      assertCommandSuccess(launched.log)
      return launched
    })
    if (result) {
      setResultState('finished')
      setResultText('Uninstaller launched. Finish its wizard, then click Scan leftovers.')
      setLaunchedAppId(selectedApp.id)
      setNotice('Official uninstaller launched. Complete it before scanning leftovers.')
    } else {
      setResultState('failed')
      setResultText('The registered uninstaller could not be launched. Check Logs for details.')
    }
  }

  async function scanLeftovers(): Promise<void> {
    if (!selectedApp) return
    setResultState('running')
    setResultText(`Scanning high-confidence leftovers for ${selectedApp.name}...`)
    const result = await runBusy('Scanning uninstall leftovers...', () => window.optimizerGuard.scanUninstallLeftovers(selectedApp.id))
    if (result) {
      setLeftovers(result)
      setSelectedLeftovers(new Set(result.filter((item) => item.selectedByDefault && !item.protected).map((item) => item.id)))
      setResultState('finished')
      const message = result.length
        ? `Scan finished. Review ${result.length} leftover item${result.length === 1 ? '' : 's'} before removal.`
        : 'Scan finished. No high-confidence leftovers were found.'
      setResultText(message)
      setNotice(message)
    } else {
      setResultState('failed')
      setResultText('Leftover scan failed. No files or registry entries were changed.')
    }
  }

  async function removeLeftovers(): Promise<void> {
    const chosen = leftovers.filter((item) => selectedLeftovers.has(item.id))
    if (chosen.length === 0) {
      setNotice('Select at least one leftover first.')
      return
    }
    if (!window.confirm(`Quarantine ${chosen.length} selected leftover${chosen.length === 1 ? '' : 's'}?\n\nFiles are moved to Optimizer Guard quarantine and registry keys are exported before removal. Personal folders and saves are excluded.`)) return
    setResultState('running')
    setResultText('Quarantining selected leftovers...')
    const result = await runBusy('Quarantining uninstall leftovers...', async () => {
      const removed = await window.optimizerGuard.removeUninstallLeftovers([...selectedLeftovers])
      assertLogsSuccess(removed.logs)
      return removed
    })
    if (result) {
      setLeftovers((current) => current.filter((item) => !selectedLeftovers.has(item.id)))
      setSelectedLeftovers(new Set())
      setResultState('finished')
      setResultText(`Finished. ${result.removed} item${result.removed === 1 ? '' : 's'} quarantined (${formatBytes(result.quarantinedBytes)}); ${result.failed} failed.`)
      setNotice('Leftover cleanup finished and a restore point was recorded.')
    } else {
      setResultState('failed')
      setResultText('Leftover cleanup failed. Check Logs; successful moves remain restorable from Logs / Restore.')
    }
  }

  return (
    <section className="page uninstaller-page">
      <PageHero
        eyebrow="Official uninstall, then reviewed cleanup"
        title="Remove applications without blind deletion."
        text="Uses Windows uninstall records first. Leftovers are scanned separately, reviewed by you, and quarantined before registry cleanup."
        icon={<PackageOpen />}
      />
      <div className="uninstaller-layout">
        <div className="panel app-picker">
          <div className="toolbar compact">
            <div className="search">
              <Search size={15} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search installed apps..." />
            </div>
            <button onClick={() => void refreshApps()}>
              <RefreshCw size={15} />
              Refresh
            </button>
          </div>
          <div className="app-list">
            {visibleApps.map((app) => (
              <button
                className={selectedApp?.id === app.id ? 'app-row selected' : 'app-row'}
                key={app.id}
                onClick={() => {
                  setSelectedApp(app)
                  setLeftovers([])
                  setSelectedLeftovers(new Set())
                  setLaunchedAppId('')
                  setResultState('idle')
                }}
              >
                <span className="app-icon"><PackageOpen size={17} /></span>
                <span>
                  <strong>{app.name}</strong>
                  <small>{[app.publisher, app.version].filter(Boolean).join(' · ') || 'Publisher not listed'}</small>
                </span>
                <small>{app.estimatedSizeBytes ? formatBytes(app.estimatedSizeBytes) : ''}</small>
              </button>
            ))}
            {visibleApps.length === 0 && <span className="muted app-list-empty">No matching uninstall entries.</span>}
          </div>
        </div>

        <div className="uninstaller-workspace">
          {!selectedApp && <EmptyHint text="Select an application to inspect its registered uninstall details." setNotice={setNotice} />}
          {selectedApp && (
            <>
              <div className="panel uninstall-summary">
                <div>
                  <span className="eyebrow">Selected application</span>
                  <h2>{selectedApp.name}</h2>
                  <p>{selectedApp.publisher || 'Publisher not listed'} {selectedApp.version ? `· ${selectedApp.version}` : ''}</p>
                  <small className="muted">{selectedApp.installLocation || 'Install location not registered'}</small>
                </div>
                <div className="uninstall-actions">
                  <button
                    className="danger-button"
                    onClick={() => void launch()}
                    disabled={resultState === 'running' || launchedAppId === selectedApp.id}
                  >
                    {launchedAppId === selectedApp.id ? <CheckCircle2 size={15} /> : <Play size={15} />}
                    {launchedAppId === selectedApp.id ? 'Uninstaller launched' : 'Run uninstaller'}
                  </button>
                  <button
                    onClick={() => void scanLeftovers()}
                    disabled={resultState === 'running' || launchedAppId !== selectedApp.id}
                    title={launchedAppId === selectedApp.id ? 'Scan exact product leftovers' : 'Run and finish the official uninstaller first'}
                  >
                    <Search size={15} />
                    Scan leftovers
                  </button>
                </div>
              </div>
              {resultState !== 'idle' && <OperationProgressCard progress={uninstallProgress} state={resultState} fallbackLabel={resultText} />}
              {leftovers.length > 0 && (
                <div className="panel leftovers-panel">
                  <div className="table-head">
                    <span>{leftovers.length} high-confidence leftovers</span>
                    <span>{formatBytes(selectedBytes)} selected</span>
                  </div>
                  <div className="leftover-list">
                    {leftovers.map((item) => (
                      <label className="leftover-row" key={item.id}>
                        <input
                          type="checkbox"
                          checked={selectedLeftovers.has(item.id)}
                          disabled={item.protected}
                          onChange={(event) => {
                            const next = new Set(selectedLeftovers)
                            if (event.target.checked) next.add(item.id)
                            else next.delete(item.id)
                            setSelectedLeftovers(next)
                          }}
                        />
                        <span>
                          <strong>{item.kind === 'registry' ? 'Registry entry' : 'File or folder'}</strong>
                          <small>{item.path}</small>
                          <small>{item.reason}</small>
                        </span>
                        <small>{item.kind === 'file' ? formatBytes(item.sizeBytes) : 'Registry'}</small>
                      </label>
                    ))}
                  </div>
                  <div className="toolbar compact">
                    <button className="danger-button" onClick={() => void removeLeftovers()} disabled={selectedLeftovers.size === 0 || resultState === 'running'}>
                      <Trash2 size={15} />
                      Quarantine selected
                    </button>
                    <span className="muted">Game saves and personal folders are always excluded.</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function OperationProgressCard({
  progress,
  state,
  fallbackLabel
}: {
  progress: OperationProgress | null
  state: 'idle' | 'running' | 'finished' | 'failed'
  fallbackLabel: string
}): JSX.Element {
  const liveProgress = state === 'running' && progress?.state === 'running' ? progress : null
  const percent = liveProgress && liveProgress.total > 0
    ? Math.min(100, Math.round((liveProgress.current / liveProgress.total) * 100))
    : state === 'finished'
      ? 100
      : 8
  const label = liveProgress?.label || fallbackLabel
  return (
    <div className={`operation-progress ${state}`}>
      <div className="operation-progress-head">
        <span>
          {state === 'finished' ? <CheckCircle2 size={16} /> : state === 'failed' ? <ShieldAlert size={16} /> : <RefreshCw size={16} className="spin" />}
          <strong>{state === 'finished' ? 'Finished' : state === 'failed' ? 'Stopped' : 'Working'}</strong>
        </span>
        <span>{state === 'running' ? `${percent}%` : state === 'finished' ? '100%' : ''}</span>
      </div>
      <div className="progress-track">
        <span style={{ width: `${percent}%` }} />
      </div>
      <small>{label}</small>
    </div>
  )
}

function NvidiaPanel({
  settings,
  saveSettings,
  runBusy,
  setNotice
}: {
  settings: AppSettings
  saveSettings: (settings: AppSettings) => Promise<void>
  runBusy: <T>(label: string, task: () => Promise<T>, success?: string) => Promise<T | null>
  setNotice: (notice: string) => void
}): JSX.Element {
  const [state, setState] = useState<NvidiaState | null>(null)
  const [profile, setProfile] = useState<NvidiaProfile | null>(null)
  const [actions, setActions] = useState<Record<NvidiaActionKey, boolean>>({
    patchNvidiaAppResolution: true,
    disableOverlay: true,
    setGameMode: true,
    disableGameDvr: true,
    disableDeliveryOptimization: false
  })

  useEffect(() => {
    void refresh()
  }, [])

  async function refresh(): Promise<void> {
    const result = await runBusy('Detecting NVIDIA GPU, driver, resolution, and DLSS profile...', () => window.optimizerGuard.getNvidiaState(), 'NVIDIA recommendations refreshed.')
    if (result) {
      setState(result)
      setProfile(result.profile)
      await saveSettings({ ...settings, preferredResolution: result.profile.preferredResolution })
    }
  }

  async function apply(): Promise<void> {
    if (!profile) return
    const selectedActionLabels = state?.actions
      .filter((action) => {
        const key = nvidiaActionKeys[action.id]
        return actions[key]
      })
      .map((action) => `- ${action.label}`) ?? []
    if (selectedActionLabels.length === 0) {
      setNotice('Select at least one optimizer action first.')
      return
    }
    if (!window.confirm(`Apply ${selectedActionLabels.length} optimizer action${selectedActionLabels.length === 1 ? '' : 's'}?\n\n${selectedActionLabels.join('\n')}`)) return
    const request: ApplyNvidiaProfileRequest = { profile, ...actions }
    const result = await runBusy('Applying selected NVIDIA and Windows gaming optimizations...', async () => {
      const logs = await window.optimizerGuard.applyNvidiaProfile(request)
      assertLogsSuccess(logs)
      return logs
    }, 'NVIDIA optimizer actions finished.')
    if (result) setNotice(`Applied ${result.length} optimizer actions. DLSS profile saved inside the app.`)
  }

  function update<K extends keyof NvidiaProfile>(key: K, value: NvidiaProfile[K]): void {
    if (!profile) return
    const next = { ...profile, [key]: value }
    setProfile(next)
    if (key === 'preferredResolution') void saveSettings({ ...settings, preferredResolution: String(value) })
  }

  return (
    <section className="page">
      <PageHero
        eyebrow="NVIDIA"
        title="Resolution, DLSS, and gaming toggles."
        text="Detects current screen resolution, suggests DLSS, and applies selected safe tweaks."
        icon={<Sparkles />}
      />
      <div className="toolbar">
        <button className="primary" onClick={() => void refresh()}>
          <RefreshCw size={16} />
          Detect
        </button>
        <button className="primary" onClick={() => void apply()} disabled={!profile}>
          <Play size={16} />
          Apply selected
        </button>
      </div>

      {profile && (
        <div className="split">
          <div className="panel">
            <h2>Suggested profile</h2>
            <div className="form-grid">
              <Select label="Preferred resolution" value={profile.preferredResolution} onChange={(value) => update('preferredResolution', value)}>
                {uniqueOptions([profile.detectedResolution, '1920x1080', '2560x1440', '3440x1440', '3840x2160']).map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </Select>
              <Select label="DLSS mode" value={profile.dlssMode} onChange={(value) => update('dlssMode', value as NvidiaProfile['dlssMode'])}>
                {['Quality', 'Balanced', 'Performance', 'Ultra Performance'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </Select>
              <Select label="DLSS preset" value={profile.dlssPreset} onChange={(value) => update('dlssPreset', value as NvidiaProfile['dlssPreset'])}>
                {['Default/Auto', 'Transformer if available', 'C', 'D', 'E', 'F', 'J'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </Select>
              <Select label="Reflex" value={profile.reflex} onChange={(value) => update('reflex', value as NvidiaProfile['reflex'])}>
                {['On + Boost', 'On', 'Off'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </Select>
              <Select label="Frame Generation" value={profile.frameGeneration} onChange={(value) => update('frameGeneration', value as NvidiaProfile['frameGeneration'])}>
                {['Off', 'On if supported'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </Select>
              <Select label="Use case" value={profile.useCase} onChange={(value) => update('useCase', value as NvidiaProfile['useCase'])}>
                {['Competitive', 'Balanced', 'Single-player visuals'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </Select>
            </div>
            <div className="note-stack">
              {profile.notes.map((note) => (
                <p key={note}>
                  <ChevronRight size={14} />
                  {note}
                </p>
              ))}
            </div>
          </div>
          <div className="panel">
            <h2>Actions to run</h2>
            <div className="spec-list">
              <Spec label="GPU" value={profile.gpuName} />
              <Spec label="Driver" value={profile.driverVersion} />
              <Spec label="Detected resolution" value={profile.detectedResolution} />
              <Spec label="Target resolution" value={profile.preferredResolution} />
              <Spec label="Patch scan" value={`${state?.patchStatus.patchedFiles ?? 0} patched / ${state?.patchStatus.unpatched4kFiles ?? 0} still 4K`} />
            </div>
            {state?.actions.map((action) => {
              const key = nvidiaActionKeys[action.id]
              return (
                <label className="action-check" key={action.id}>
                  <input checked={actions[key]} onChange={(event) => setActions({ ...actions, [key]: event.target.checked })} type="checkbox" />
                  <span>
                    <strong>{action.label}</strong>
                    <small>{action.description}</small>
                    <small className="action-status">{action.status}</small>
                  </span>
                  {action.requiresAdmin && <Shield size={15} />}
                </label>
              )
            })}
          </div>
        </div>
      )}
      {!profile && <EmptyHint text="Click Detect to build a GPU profile." setNotice={setNotice} />}
    </section>
  )
}

function LogsPanel({
  snapshot,
  settings,
  runBusy,
  refreshSnapshot
}: {
  snapshot: AppSnapshot | null
  settings: AppSettings
  runBusy: <T>(label: string, task: () => Promise<T>, success?: string) => Promise<T | null>
  refreshSnapshot: () => Promise<void>
}): JSX.Element {
  async function restore(id: string): Promise<void> {
    await runBusy('Running restore action...', async () => {
      const result = await window.optimizerGuard.restore(id)
      if (result) assertCommandSuccess(result)
      return result
    }, 'Restore action finished.')
    await refreshSnapshot()
  }

  async function exportSettings(): Promise<void> {
    const file = await runBusy('Exporting settings and history...', () => window.optimizerGuard.exportSettings(), 'Settings exported.')
    if (file) window.alert(`Exported to:\n${file}`)
  }

  return (
    <section className="page">
      <PageHero
        eyebrow="Audit trail"
        title="Logs and restore points."
        text="Inspect command output, export history, and undo supported changes."
        icon={<TerminalSquare />}
      />
      <div className="toolbar">
        <button className="primary" onClick={() => void refreshSnapshot()}>
          <RefreshCw size={16} />
          Refresh
        </button>
        <button onClick={() => void window.optimizerGuard.openLogs()}>
          <FileText size={16} />
          Open log file
        </button>
        <button onClick={() => void exportSettings()}>
          <DatabaseBackup size={16} />
          Export
        </button>
      </div>
      <div className="split">
        <div className="panel">
          <h2>Restore history</h2>
          <div className="restore-list">
            {(snapshot?.restoreHistory ?? []).map((entry) => (
              <div className="restore-item" key={entry.id}>
                <div>
                  <strong>{restoreDisplayLabel(entry.label)}</strong>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                </div>
                <span className={entry.applied ? 'pill' : 'pill live'}>{entry.applied ? 'used' : 'available'}</span>
                {entry.elevated && (
                  <span className="pill warn">
                    <Shield size={13} />
                    UAC
                  </span>
                )}
                <button disabled={entry.applied} onClick={() => void restore(entry.id)}>
                  <RotateCcw size={15} />
                  Undo
                </button>
              </div>
            ))}
            {(snapshot?.restoreHistory.length ?? 0) === 0 && <span className="muted">No restore points yet.</span>}
          </div>
        </div>
        <div className="panel">
          <h2>Command log</h2>
          <div className="log-list">
            {(snapshot?.logs ?? []).map((log) => (
              <LogEntry log={log} key={log.id} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function AboutPanel({
  runBusy,
  version
}: {
  runBusy: <T>(label: string, task: () => Promise<T>, success?: string) => Promise<T | null>
  version: string
}): JSX.Element {
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)

  useEffect(() => {
    void checkUpdates()
  }, [])

  async function checkUpdates(): Promise<void> {
    const result = await runBusy('Checking GitHub releases...', () => window.optimizerGuard.checkForUpdates())
    if (result) setUpdateInfo(result)
  }

  const updateTone = updateInfo?.error ? 'failed' : updateInfo?.isUpdateAvailable ? 'available' : 'current'

  return (
    <section className="page about-page">
      <PageHero
        eyebrow="About"
        title="Optimizer Guard"
        text="A guarded desktop optimizer for Windows gaming PCs. Apply only what you choose, and keep restore history."
        icon={<ShieldCheckIcon />}
      />

      <div className="about-grid">
        <div className="panel about-card">
          <div className="about-logo">
            <ShieldCheck size={36} />
          </div>
          <h2>Optimizer Guard</h2>
          <p>Version {version || 'dev'}</p>
          <div className="about-actions">
            <button className="primary" onClick={() => void window.optimizerGuard.openExternal('https://github.com/SyroxXploits/Optimizer-Guard')}>
              <Github size={16} />
              GitHub repository
              <ExternalLink size={13} />
            </button>
            <button onClick={() => void window.optimizerGuard.openExternal('https://github.com/SyroxXploits/Optimizer-Guard/releases')}>
              <Download size={16} />
              Releases
              <ExternalLink size={13} />
            </button>
          </div>
        </div>

        <div className={`panel update-card ${updateTone}`}>
          <div className="panel-title-row">
            <div>
              <span className="muted">Update checker</span>
              <h2>{updateInfo?.isUpdateAvailable ? 'Update available' : updateInfo?.error ? 'Could not check updates' : 'You are up to date'}</h2>
            </div>
            {updateInfo?.isUpdateAvailable ? <Download size={30} /> : updateInfo?.error ? <ShieldAlert size={30} /> : <CheckCircle2 size={30} />}
          </div>

          <div className="spec-list two">
            <Spec label="Version" value={updateInfo?.currentVersion ?? version ?? 'dev'} />
            {updateInfo?.isUpdateAvailable && <Spec label="Update" value={updateInfo.latestVersion} />}
          </div>

          {updateInfo?.error && <p className="status-text error">{updateInfo.error}</p>}
          {!updateInfo?.error && !updateInfo?.isUpdateAvailable && <p className="status-text">No update available.</p>}
          {updateInfo?.publishedAt && <p className="status-text">Published {new Date(updateInfo.publishedAt).toLocaleDateString()}</p>}

          <div className="about-actions">
            <button className="primary" onClick={() => void checkUpdates()}>
              <RefreshCw size={16} />
              Check again
            </button>
            {updateInfo?.isUpdateAvailable && (
              <button onClick={() => void window.optimizerGuard.openExternal(updateInfo.releaseUrl)}>
                <ExternalLink size={16} />
                Open latest release
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="panel compact-safety">
        <h2>Guard rails</h2>
        <div className="guard-list">
          <span>No Defender, Firewall, or Windows Update disabling by default.</span>
          <span>No personal folders, game saves, or Downloads cleanup.</span>
          <span>Admin actions use UAC only when needed.</span>
          <span>Every command is logged with output and restore context.</span>
        </div>
      </div>
    </section>
  )
}

function ShieldCheckIcon(): JSX.Element {
  return <Shield size={28} />
}

function PageHero({ eyebrow, title, text, icon }: { eyebrow: string; title: string; text: string; icon: JSX.Element }): JSX.Element {
  return (
    <div className="hero">
      <div className="hero-icon">{icon}</div>
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </div>
  )
}

function MetricCard({ icon, label, value, sub }: { icon: JSX.Element; label: string; value: string; sub: string }): JSX.Element {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  )
}

function Spec({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="spec">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function TaskStatus({ task }: { task: ScheduledTaskRow }): JSX.Element {
  const status = explainTaskStatus(task)
  return (
    <div className={`task-status ${status.tone}`}>
      <strong>{status.label}</strong>
      <span>{status.detail}</span>
    </div>
  )
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  )
}

function EmptyHint({ text, setNotice }: { text: string; setNotice: (notice: string) => void }): JSX.Element {
  return (
    <button className="empty-hint" onClick={() => setNotice(text)}>
      <Info size={17} />
      {text}
    </button>
  )
}

function explainTaskStatus(task: ScheduledTaskRow): { label: string; detail: string; tone: 'enabled' | 'disabled' | 'running' | 'warning' } {
  const raw = normalizeSchedulerText(task.status)
  if (!task.enabled || raw.includes('disabled') || raw.includes('desactive')) {
    return { label: 'Disabled', detail: 'Will not run automatically', tone: 'disabled' }
  }
  if (raw.includes('running') || raw.includes('en cours')) {
    return { label: 'Running now', detail: 'Currently active', tone: 'running' }
  }
  if (raw.includes('queued')) {
    return { label: 'Queued', detail: 'Waiting to start', tone: 'warning' }
  }
  if (raw.includes('could not') || raw.includes('unknown')) {
    return { label: 'Unknown', detail: task.status || 'Windows did not report state', tone: 'warning' }
  }
  return { label: 'Enabled', detail: 'Waiting for next trigger', tone: 'enabled' }
}

function normalizeSchedulerText(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

function LogEntry({ log }: { log: CommandLogEntry }): JSX.Element {
  return (
    <details className={log.success ? 'log-entry' : 'log-entry failed'}>
      <summary>
        <span>
          {log.success ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}
          {log.label}
        </span>
        <small>{new Date(log.timestamp).toLocaleString()}</small>
      </summary>
      <pre>{`${log.command} ${log.args.join(' ')}\n\nstdout:\n${log.stdout || '(empty)'}\n\nstderr:\n${log.stderr || '(empty)'}`}</pre>
    </details>
  )
}

function assertCommandSuccess(log: CommandLogEntry): void {
  if (log.success) return
  const output = [log.stderr, log.stdout].filter(Boolean).join('\n').trim()
  throw new Error(output || `${log.label} failed with exit code ${log.exitCode ?? 'unknown'}.`)
}

function assertLogsSuccess(logs: CommandLogEntry[]): void {
  const failed = logs.find((log) => !log.success)
  if (failed) assertCommandSuccess(failed)
}

function restoreDisplayLabel(label: string): string {
  if (label.toLowerCase().startsWith('undo:')) return label
  return `Undo previous change: ${label.charAt(0).toLowerCase()}${label.slice(1)}`
}

function isFeatureEnabled(state: string): boolean {
  return state.toLowerCase().startsWith('enabled')
}

function isFeatureDisabled(state: string): boolean {
  return state.toLowerCase().startsWith('disabled')
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 bytes'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index < 2 ? 0 : 2)} ${units[index]}`
}

function mhzLabel(value: number | null): string {
  return value ? `${value} MHz` : 'Unknown'
}

function cleanSizeLabel(target: CleanTarget): string {
  if (target.commandOnly) return 'Command'
  if (!target.detected || target.estimatedBytes <= 0) return 'No files found'
  return `${target.scanNote ? '~' : ''}${formatBytes(target.estimatedBytes)}`
}

function uniqueOptions(options: string[]): string[] {
  return [...new Set(options.filter(Boolean))]
}

export default App
