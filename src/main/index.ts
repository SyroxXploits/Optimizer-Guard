import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { OptimizerService } from './optimizer'
import type { AppSettings, ApplyNvidiaProfileRequest, BatchUninstallRequest, UpdateCheckResult } from '../shared/types'

const REPOSITORY = 'SyroxXploits/Optimizer-Guard'
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`

let mainWindow: BrowserWindow | null = null

if (process.env.OPTIMIZER_GUARD_SMOKE === '1' || process.env.OPTIMIZER_GUARD_CAPTURE === '1') {
  const debugUserData = join(process.cwd(), 'debug', process.env.OPTIMIZER_GUARD_SMOKE === '1' ? 'user-data-smoke' : 'user-data-capture')
  mkdirSync(debugUserData, { recursive: true })
  app.setPath('userData', debugUserData)
  if (process.env.OPTIMIZER_GUARD_CAPTURE === '1') process.env.OPTIMIZER_GUARD_DEMO = '1'
}

const service = new OptimizerService()

function createWindow(): void {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(Math.max(1280, Math.round(workArea.width * 0.72)), workArea.width - 60)
  const height = Math.min(Math.max(820, Math.round(workArea.height * 0.72)), workArea.height - 60)
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1040,
    minHeight: 680,
    title: 'Optimizer Guard',
    backgroundColor: '#070a0d',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.once('did-finish-load', () => {
    if (process.env.OPTIMIZER_GUARD_SMOKE === '1') {
      void runSmokeTest(mainWindow)
    } else if (process.env.OPTIMIZER_GUARD_CAPTURE === '1') {
      void captureScreenshots(mainWindow)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function runSmokeTest(window: BrowserWindow | null): Promise<void> {
  if (!window) return
  const outputDir = join(process.cwd(), 'debug')
  mkdirSync(outputDir, { recursive: true })
  window.setSize(1440, 960)
  await wait(1000)

  const results: {
    startedAt: string
    checks: Array<{ name: string; ok: boolean; value?: unknown; error?: string }>
    completedAt?: string
  } = {
    startedAt: new Date().toISOString(),
    checks: []
  }

  async function check(name: string, script: string): Promise<void> {
    try {
      const value = await window.webContents.executeJavaScript(script, true)
      results.checks.push({ name, ok: true, value })
    } catch (error) {
      results.checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  await check('renderer booted', "Boolean(window.optimizerGuard && document.querySelector('.app-shell'))")
  await check('nav tabs visible', "Array.from(document.querySelectorAll('nav button')).map((button) => button.textContent?.trim()).filter(Boolean)")
  await check('app version', 'window.optimizerGuard.appVersion()')
  await check('snapshot loads', "window.optimizerGuard.getSnapshot().then((snapshot) => ({ logs: snapshot.logs.length, restore: snapshot.restoreHistory.length }))")
  await check('tasks query', "window.optimizerGuard.queryTasks().then((tasks) => ({ count: tasks.length, sample: tasks.slice(0, 3).map((task) => ({ name: task.name, status: task.status, enabled: task.enabled })) }))")
  await check('disabled filter renders disabled rows', `
    (async () => {
      const tasksButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Tasks'))
      tasksButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 450))
      const disabledButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim().toLowerCase() === 'disabled')
      disabledButton?.click()
      let statuses = []
      for (let index = 0; index < 24; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        statuses = Array.from(document.querySelectorAll('.task-status strong')).map((item) => item.textContent?.trim()).filter(Boolean)
        if (statuses.length > 0) break
      }
      const allDisabled = statuses.length > 0 && statuses.every((status) => status === 'Disabled')
      if (!allDisabled) throw new Error('Disabled filter rendered non-disabled rows: ' + statuses.slice(0, 8).join(', '))
      return { count: statuses.length, statuses: statuses.slice(0, 8), allDisabled }
    })()
  `)
  await check('features query', "window.optimizerGuard.queryFeatures().then((features) => features.map((feature) => ({ id: feature.id, state: feature.state })))")
  await check('system info query', "window.optimizerGuard.getSystemInfo().then((info) => ({ cpu: info.cpu.name, cpuClock: info.cpu.currentClockMhz, gpu: info.gpu.name, gpuClock: info.gpu.graphicsClockMhz, memoryGb: info.memoryGb, resizableBar: info.gpu.resizableBar, displays: info.displays, gameMode: info.gameMode, hags: info.hags }))")
  await check('cleaning scan', `
    (async () => {
      const started = performance.now()
      const targets = await window.optimizerGuard.scanCleaning()
      const durationMs = Math.round(performance.now() - started)
      if (durationMs > 5000) throw new Error('Cleaning scan exceeded 5 seconds: ' + durationMs + 'ms')
      return {
        count: targets.length,
        detected: targets.filter((target) => target.detected).length,
        estimatedBytes: targets.reduce((sum, target) => sum + target.estimatedBytes, 0),
        durationMs
      }
    })()
  `)
  try {
    const cleaningBatch = await service.smokeTestCleaningBatch()
    results.checks.push({
      name: 'fast cleaning batch',
      ok: cleaningBatch.success && cleaningBatch.durationMs < 5000,
      value: cleaningBatch,
      error: cleaningBatch.success ? undefined : cleaningBatch.error || `${cleaningBatch.remaining} test items remained`
    })
  } catch (error) {
    results.checks.push({
      name: 'fast cleaning batch',
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  await check('installed apps query', "window.optimizerGuard.queryInstalledApps().then((apps) => ({ count: apps.length, drives: [...new Set(apps.map((app) => app.installDrive))], silent: apps.filter((app) => app.supportsSilent).length, sample: apps.slice(0, 5).map((app) => ({ name: app.name, publisher: app.publisher, version: app.version, drive: app.installDrive })) }))")
  await check('installed app ids remain stable', `
    Promise.all([window.optimizerGuard.queryInstalledApps(), window.optimizerGuard.queryInstalledApps()]).then(([first, second]) => {
      const stable = first.slice(0, 20).every((app, index) => app.id === second[index]?.id)
      if (!stable) throw new Error('Installed app IDs changed between refreshes.')
      return { checked: Math.min(20, first.length), stable }
    })
  `)
  try {
    const uninstallPlan = await service.smokeTestUninstallPlanning()
    results.checks.push({
      name: 'silent uninstall planning',
      ok: uninstallPlan.invalid.length === 0,
      value: uninstallPlan,
      error: uninstallPlan.invalid.length ? `Invalid silent plans: ${uninstallPlan.invalid.join(', ')}` : undefined
    })
  } catch (error) {
    results.checks.push({
      name: 'silent uninstall planning',
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  await check('uninstall leftover scan', "window.optimizerGuard.queryInstalledApps().then((apps) => apps[0] ? window.optimizerGuard.scanUninstallLeftovers(apps[0].id).then((items) => ({ app: apps[0].name, count: items.length, kinds: [...new Set(items.map((item) => item.kind))] })) : ({ app: '', count: 0, kinds: [] }))")
  await check('uninstall candidates avoid shared vendor roots', `
    window.optimizerGuard.queryInstalledApps().then(async (apps) => {
      const app = apps[0]
      if (!app) return { checked: false }
      const items = await window.optimizerGuard.scanUninstallLeftovers(app.id)
      const publisherLeaf = app.publisher.toLowerCase().replace(/[®™©]/g, '').trim()
      const unsafe = items.filter((item) => {
        if (item.kind !== 'file') return false
        const leaf = item.path.replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop()?.toLowerCase() || ''
        return leaf === publisherLeaf
      })
      if (unsafe.length) throw new Error('Shared publisher roots were offered as leftovers: ' + unsafe.map((item) => item.path).join(', '))
      return { checked: true, candidates: items.length }
    })
  `)
  await check('nvidia detection', "window.optimizerGuard.getNvidiaState().then((state) => ({ gpu: state.profile.gpuName, detectedResolution: state.profile.detectedResolution, preferredResolution: state.profile.preferredResolution, dlssMode: state.profile.dlssMode }))")
  await check('update checker', "window.optimizerGuard.checkForUpdates().then((update) => ({ currentVersion: update.currentVersion, latestVersion: update.latestVersion, error: update.error || '' }))")
  await check('tab click through', `
    (async () => {
      const labels = ['Tasks', 'System', 'Cleaning', 'Uninstaller', 'NVIDIA', 'Logs', 'About']
      const visited = []
      for (const label of labels) {
        const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes(label))
        if (!button) throw new Error('Missing tab ' + label)
        button.click()
        await new Promise((resolve) => setTimeout(resolve, 250))
        visited.push(document.querySelector('.persistent-tab.active .hero h1, main > .page .hero h1')?.textContent || label)
      }
      return visited
    })()
  `)
  await check('cleaning state survives tab switching', `
    (async () => {
      const navButton = (label) => Array.from(document.querySelectorAll('nav button')).find((item) => item.textContent?.trim() === label)
      navButton('Cleaning')?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      Array.from(document.querySelectorAll('.persistent-tab.active button')).find((item) => item.textContent?.trim() === 'Scan')?.click()
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (document.querySelectorAll('.clean-card').length > 0) break
      }
      const before = document.querySelectorAll('.clean-card').length
      navButton('System')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      navButton('Cleaning')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      const after = document.querySelectorAll('.persistent-tab.active .clean-card').length
      if (!before || before !== after) throw new Error('Cleaning results reset after tab switch.')
      return { before, after }
    })()
  `)
  await check('uninstaller state container and drive filters survive tab switching', `
    (async () => {
      const button = (label) => Array.from(document.querySelectorAll('nav button')).find((item) => item.textContent?.trim() === label)
      const apps = await window.optimizerGuard.queryInstalledApps()
      button('Uninstaller')?.click()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (document.querySelectorAll('.persistent-tab.active .app-row').length > 0) break
      }
      const filters = Array.from(document.querySelectorAll('.persistent-tab.active .drive-filters button')).map((item) => item.textContent?.trim())
      for (const drive of [...new Set(apps.map((app) => app.installDrive))]) {
        if (!filters.some((label) => label?.startsWith(drive))) throw new Error('Missing drive filter ' + drive)
      }
      const beforePanel = document.querySelector('.persistent-tab.active .uninstaller-page')
      button('Cleaning')?.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      button('Uninstaller')?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      const afterPanel = document.querySelector('.persistent-tab.active .uninstaller-page')
      if (!beforePanel || beforePanel !== afterPanel) throw new Error('Uninstaller component was remounted after tab switch.')
      return { filters, rows: document.querySelectorAll('.persistent-tab.active .app-row').length, samePanel: true }
    })()
  `)

  results.completedAt = new Date().toISOString()
  writeFileSync(join(outputDir, 'smoke-results.json'), JSON.stringify(results, null, 2))
  const failed = results.checks.filter((item) => !item.ok)
  app.exit(failed.length ? 1 : 0)
}

async function captureScreenshots(window: BrowserWindow | null): Promise<void> {
  if (!window) return
  const outputDir = join(process.cwd(), 'docs', 'screenshots')
  mkdirSync(outputDir, { recursive: true })
  window.setSize(1440, 960)
  await wait(1200)

  const shots = [
    { tab: 'Tasks', file: 'task-disabler.png' },
    { tab: 'System', file: 'system-info.png' },
    { tab: 'Cleaning', file: 'cleaning.png', before: "document.querySelector('.primary')?.click()" },
    {
      tab: 'Uninstaller',
      file: 'uninstaller.png',
      wait: 1200,
      before: `(async () => {
        const boxes = Array.from(document.querySelectorAll('.app-row > input'))
        boxes.slice(0, 2).forEach((box) => box.click())
        const silent = document.querySelector('.mode-option input')
        if (silent && !silent.checked) silent.click()
      })()`
    },
    { tab: 'NVIDIA', file: 'nvidia-dlss.png' },
    { tab: 'Logs', file: 'logs-restore.png' },
    { tab: 'About', file: 'about-updates.png' }
  ]

  for (const shot of shots) {
    await window.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(${JSON.stringify(shot.tab)}))?.click()
    `)
    await wait(shot.wait ?? 900)
    if (shot.before) {
      await window.webContents.executeJavaScript(shot.before)
      await wait(900)
    }
    const image = await window.webContents.capturePage()
    writeFileSync(join(outputDir, shot.file), image.toPNG())
  }

  app.quit()
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function registerIpc(): void {
  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:check-updates', () => checkForUpdates())
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('shell:open-external', async (_event, url: string) => shell.openExternal(url))

  ipcMain.handle('settings:get', () => service.getSettings())
  ipcMain.handle('settings:set', (_event, settings: AppSettings) => service.saveSettings(settings))
  ipcMain.handle('snapshot:get', () => service.getSnapshot())
  ipcMain.handle('logs:open', () => service.openLogPath())
  ipcMain.handle('logs:path', () => service.getLogPath())
  ipcMain.handle('settings:export', () => service.exportSnapshot())

  ipcMain.handle('system:is-admin', () => service.isAdmin())
  ipcMain.handle('system:info', () => service.querySystemInfo())
  ipcMain.handle('tasks:query', () => service.queryTasks())
  ipcMain.handle('tasks:set-state', (_event, taskPath: string, enable: boolean) =>
    service.setTaskState(taskPath, enable, false)
  )
  ipcMain.handle('features:query', () => service.queryFeatures())
  ipcMain.handle('features:set-state', (_event, featureName: string, enable: boolean) =>
    service.setFeature(featureName, enable, false)
  )

  ipcMain.handle('clean:scan', (event) =>
    service.scanCleaningTargets((progress) => event.sender.send('operation:progress', progress))
  )
  ipcMain.handle('clean:run', (event, ids: string[]) =>
    service.cleanTargets(ids, false, (progress) => event.sender.send('operation:progress', progress))
  )
  ipcMain.handle('uninstall:query', () => service.queryInstalledApps())
  ipcMain.handle('uninstall:launch', (_event, appId: string) => service.launchUninstaller(appId))
  ipcMain.handle('uninstall:batch', (event, request: BatchUninstallRequest) =>
    service.batchUninstall(request, (progress) => event.sender.send('operation:progress', progress))
  )
  ipcMain.handle('uninstall:scan-leftovers', (event, appId: string) =>
    service.scanUninstallLeftovers(appId, (progress) => event.sender.send('operation:progress', progress))
  )
  ipcMain.handle('uninstall:scan-leftovers-many', (event, appIds: string[]) =>
    service.scanUninstallLeftoversMany(appIds, (progress) => event.sender.send('operation:progress', progress))
  )
  ipcMain.handle('uninstall:remove-leftovers', (event, ids: string[]) =>
    service.removeUninstallLeftovers(ids, (progress) => event.sender.send('operation:progress', progress))
  )

  ipcMain.handle('nvidia:state', () => service.queryNvidiaState())
  ipcMain.handle('nvidia:apply', (_event, request: ApplyNvidiaProfileRequest) =>
    service.applyNvidiaProfile(request, false)
  )

  ipcMain.handle('restore:run', (_event, id: string) => service.restore(id, false))
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Optimizer Guard/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${response.status}`)
    }
    const release = (await response.json()) as {
      tag_name?: string
      name?: string
      html_url?: string
      published_at?: string
    }
    const latestVersion = normalizeVersion(release.tag_name ?? release.name ?? currentVersion)
    return {
      currentVersion,
      latestVersion,
      releaseName: release.name ?? release.tag_name ?? latestVersion,
      releaseUrl: release.html_url ?? RELEASES_URL,
      publishedAt: release.published_at,
      isUpdateAvailable: compareVersions(latestVersion, currentVersion) > 0
    }
  } catch (error) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      releaseName: '',
      releaseUrl: RELEASES_URL,
      isUpdateAvailable: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '').trim()
}

function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a).split('.').map((part) => Number(part) || 0)
  const right = normalizeVersion(b).split('.').map((part) => Number(part) || 0)
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return 1
    if ((left[index] ?? 0) < (right[index] ?? 0)) return -1
  }
  return 0
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.optimizer.guard')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
