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
  Monitor,
  Palette,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
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
  NvidiaProfile,
  NvidiaState,
  ScheduledTaskRow,
  SystemInfo,
  UpdateCheckResult
} from '../../shared/types'

type TabId = 'tasks' | 'system' | 'cleaning' | 'nvidia' | 'logs' | 'about'
type ThemeId = 'aurora' | 'graphite' | 'ember'

const tabs: Array<{ id: TabId; label: string; icon: typeof Gauge }> = [
  { id: 'tasks', label: 'Task Disabler', icon: Gauge },
  { id: 'system', label: 'System / BIOS Info', icon: Cpu },
  { id: 'cleaning', label: 'Cleaning', icon: Eraser },
  { id: 'nvidia', label: 'NVIDIA / DLSS Suggestions', icon: Sparkles },
  { id: 'logs', label: 'Logs / Restore', icon: DatabaseBackup },
  { id: 'about', label: 'About / Updates', icon: Github }
]

const themes: Array<{ id: ThemeId; label: string }> = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'ember', label: 'Ember' }
]

const defaultSettings: AppSettings = {
  dryRun: true,
  preferredResolution: '2560x1440',
  lastTab: 'tasks'
}

function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [activeTab, setActiveTab] = useState<TabId>('tasks')
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('Ready. Dry-run is on, so the first pass is safe.')
  const [version, setVersion] = useState('')
  const [theme, setTheme] = useState<ThemeId>(() => (localStorage.getItem('optimizer-theme') as ThemeId) || 'aurora')

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('optimizer-theme', theme)
  }, [theme])

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
          <div className="brand-mark">OG</div>
          <div>
            <span>Optimizer Guard</span>
            <small>Safe PC tuning</small>
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
        <div className="safety-card">
          <ShieldAlert size={20} />
          <strong>Guard rails active</strong>
          <span>No Defender, firewall, Windows Update, personal folders, or game saves are touched by default.</span>
        </div>
      </aside>

      <main className="content">
        <header className="titlebar">
          <div className="drag-region">
            <span className="pill live">v{version || 'dev'}</span>
            <span className="muted">{notice}</span>
          </div>
          <button className="ghost-link" onClick={() => void window.optimizerGuard.openExternal('https://github.com/SyroxXploits/Optimizer-Guard')}>
            <Github size={15} />
            GitHub
          </button>
          <label className="dry-toggle">
            <input
              type="checkbox"
              checked={settings.dryRun}
              onChange={(event) => void saveSettings({ ...settings, dryRun: event.target.checked })}
            />
            Preview / dry-run
          </label>
          <button className="window-button" onClick={() => void window.optimizerGuard.minimize()}>
            -
          </button>
          <button className="window-button" onClick={() => void window.optimizerGuard.toggleMaximize()}>
            []
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
        {activeTab === 'cleaning' && <CleaningPanel settings={settings} runBusy={runBusy} setNotice={setNotice} />}
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
    }, 'Task list refreshed from schtasks.')
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
    if (task.critical && !window.confirm('This looks like a Microsoft/security/system task. Continue anyway?')) return
    await runBusy(`${enable ? 'Enabling' : 'Disabling'} ${task.path}`, async () => {
      const result = await window.optimizerGuard.setTaskState(task.path, enable, settings.dryRun)
      await refresh()
      return result
    }, `${settings.dryRun ? 'Previewed' : enable ? 'Enabled' : 'Disabled'} ${task.path}`)
  }

  async function toggleFeature(feature: FeatureToggle, enable: boolean): Promise<void> {
    if (!settings.dryRun && !window.confirm(`${enable ? 'Enable' : 'Disable'} ${feature.label}? A restart may be required.`)) return
    await runBusy(`${enable ? 'Enabling' : 'Disabling'} ${feature.label}`, async () => {
      const result = await window.optimizerGuard.setFeatureState(feature.featureName, enable, settings.dryRun)
      setFeatures(await window.optimizerGuard.queryFeatures())
      return result
    }, `${settings.dryRun ? 'Previewed' : 'Applied'} ${feature.label}. Restart required may be shown by Windows.`)
  }

  return (
    <section className="page">
      <PageHero
        eyebrow="Startup and background automation"
        title="Disable noisy tasks without nuking Windows security."
        text="Uses schtasks /query /fo CSV /v, parses the result, and logs every enable/disable action with restore history."
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

      <div className="feature-row">
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
              <button onClick={() => void toggleFeature(feature, false)}>Disable</button>
              <button onClick={() => void toggleFeature(feature, true)}>Enable</button>
            </div>
          </div>
        ))}
      </div>

      <div className="table-card">
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
                <td>{task.status}</td>
                <td>{task.nextRun}</td>
                <td>{task.lastRun}</td>
                <td>{task.author}</td>
                <td>
                  <button className={task.enabled ? 'danger-button' : 'secondary'} onClick={() => void toggleTask(task, !task.enabled)}>
                    {task.enabled ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tasks.length === 0 && <EmptyHint text="No tasks loaded yet. Click Refresh if Windows blocked the first scan." setNotice={setNotice} />}
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
        eyebrow="Hardware truth table"
        title="Find the bottleneck suspects before changing random toggles."
        text="Reads BIOS, board, CPU, GPU, display, Game Mode, HAGS, Resizable BAR, live CPU usage, and NVIDIA driver data."
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
            <MetricCard icon={<Activity />} label="Power plan" value={info.powerPlan.replace('Power Scheme GUID:', '').trim()} sub={`Admin: ${info.isAdmin ? 'yes' : 'no'}`} />
            <MetricCard icon={<AppWindow />} label="Windows gaming" value={`Game Mode ${info.gameMode}`} sub={`HAGS ${info.hags}`} />
          </div>

          <div className="split">
            <div className="panel">
              <h2>CPU</h2>
              <div className="spec-list">
                <Spec label="Name" value={info.cpu.name} />
                <Spec label="Cores / Threads" value={`${info.cpu.cores} / ${info.cpu.threads}`} />
                <Spec label="Clock" value={`${info.cpu.baseClockMhz ?? '?'} MHz base, ${info.cpu.maxClockMhz ?? '?'} MHz max`} />
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
                  <span className="muted">GPU-Z style card</span>
                  <h2>{info.gpu.name}</h2>
                </div>
                <Monitor size={40} />
              </div>
              <div className="spec-list two">
                <Spec label="VRAM" value={info.gpu.vramMb ? `${info.gpu.vramMb} MB` : 'Unknown'} />
                <Spec label="Driver" value={info.gpu.driverVersion} />
                <Spec label="Usage" value={info.gpu.usagePercent !== null ? `${info.gpu.usagePercent}%` : 'Unknown'} />
                <Spec label="Temp" value={info.gpu.temperatureC !== null ? `${info.gpu.temperatureC} C` : 'Unknown'} />
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
                  <span>{display.refreshRate || '?'} Hz</span>
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
  setNotice
}: {
  settings: AppSettings
  runBusy: <T>(label: string, task: () => Promise<T>, success?: string) => Promise<T | null>
  setNotice: (notice: string) => void
}): JSX.Element {
  const [targets, setTargets] = useState<CleanTarget[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  async function scan(): Promise<void> {
    const result = await runBusy('Scanning safe cleanup locations...', () => window.optimizerGuard.scanCleaning(), 'Scan complete. Select targets, then clean selected.')
    if (result) {
      setTargets(result)
      setSelected(new Set(result.filter((target) => target.selectedByDefault && target.detected).map((target) => target.id)))
    }
  }

  async function clean(): Promise<void> {
    const chosen = targets.filter((target) => selected.has(target.id))
    if (chosen.length === 0) {
      setNotice('Select at least one cleanup target first.')
      return
    }
    if (chosen.some((target) => target.dangerous) && !window.confirm('One or more selected targets are marked dangerous. Continue?')) return
    const result = await runBusy('Cleaning selected targets...', () => window.optimizerGuard.cleanSelected([...selected], settings.dryRun), 'Cleanup finished and logged.')
    if (result) setNotice(`${settings.dryRun ? 'Previewed' : 'Cleaned'} ${formatBytes(result.beforeBytes)}. Estimated saved: ${formatBytes(result.savedBytes)}.`)
    await scan()
  }

  return (
    <section className="page">
      <PageHero
        eyebrow="Scan first, clean second"
        title="Free space without touching personal files."
        text="The cleaner estimates space first, requires explicit selection, and avoids Downloads, Documents, Desktop, Pictures, Videos, and game saves."
        icon={<Trash2 />}
      />
      <div className="toolbar">
        <button className="primary" onClick={() => void scan()}>
          <Search size={16} />
          Scan
        </button>
        <button className="danger-button" onClick={() => void clean()} disabled={targets.length === 0}>
          <Trash2 size={16} />
          Clean selected
        </button>
        <span className="pill">{formatBytes(targets.reduce((sum, target) => (selected.has(target.id) ? sum + target.estimatedBytes : sum), 0))} selected</span>
      </div>
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
              <span className="muted">{target.commandOnly ? 'Command action' : formatBytes(target.estimatedBytes)}</span>
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
  const [actions, setActions] = useState({
    patchNvidiaAppResolution: true,
    disableOverlay: true,
    setGameMode: true,
    disableGameDvr: true
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
    const request: ApplyNvidiaProfileRequest = { profile, ...actions }
    const result = await runBusy('Applying selected NVIDIA and Windows gaming optimizations...', () => window.optimizerGuard.applyNvidiaProfile(request, settings.dryRun), 'NVIDIA optimizer actions finished.')
    if (result) setNotice(`${settings.dryRun ? 'Previewed' : 'Applied'} ${result.length} optimizer actions. DLSS profile saved inside the app.`)
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
        eyebrow="NVIDIA App resolution fixer"
        title="Make 1440p the default target and tune DLSS intentionally."
        text="You can choose DLSS mode, preset style, Reflex, use-case, and apply safe Windows/NVIDIA actions. Game files are never force-edited."
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
                {['1920x1080', '2560x1440', '3440x1440', '3840x2160'].map((item) => (
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
            </div>
            {state?.actions.map((action) => {
              const key = action.id === 'patch-nvidia-resolution' ? 'patchNvidiaAppResolution' : action.id === 'disable-overlay' ? 'disableOverlay' : action.id === 'game-mode' ? 'setGameMode' : 'disableGameDvr'
              return (
                <label className="action-check" key={action.id}>
                  <input checked={actions[key]} onChange={(event) => setActions({ ...actions, [key]: event.target.checked })} type="checkbox" />
                  <span>
                    <strong>{action.label}</strong>
                    <small>{action.description}</small>
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
    await runBusy('Running restore action...', () => window.optimizerGuard.restore(id, settings.dryRun), 'Restore action finished.')
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
        title="Every command, output, preview, and restore point is kept."
        text="Use this page to inspect command output, open the local log file, export settings, or undo changes made by the app."
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
                  <strong>{entry.label}</strong>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                </div>
                <span className={entry.applied ? 'pill' : 'pill live'}>{entry.applied ? 'used' : 'ready'}</span>
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
        text="A guarded desktop optimizer for Windows gaming PCs. Preview changes, apply only what you choose, and keep restore history."
        icon={<ShieldCheckIcon />}
      />

      <div className="about-grid">
        <div className="panel about-card">
          <div className="about-logo">OG</div>
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
            <Spec label="Installed" value={updateInfo?.currentVersion ?? version ?? 'dev'} />
            <Spec label="Latest" value={updateInfo?.latestVersion ?? 'Checking...'} />
          </div>

          {updateInfo?.error && <p className="status-text error">{updateInfo.error}</p>}
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
          <span>Every command is logged with output and dry-run state.</span>
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

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index < 2 ? 0 : 2)} ${units[index]}`
}

export default App
