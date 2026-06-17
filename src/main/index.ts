import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { OptimizerService } from './optimizer'
import type { AppSettings, ApplyNvidiaProfileRequest, UpdateCheckResult } from '../shared/types'

const REPOSITORY = 'SyroxXploits/Optimizer-Guard'
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`

let mainWindow: BrowserWindow | null = null
const service = new OptimizerService()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
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
  await check('features query', "window.optimizerGuard.queryFeatures().then((features) => features.map((feature) => ({ id: feature.id, state: feature.state })))")
  await check('system info query', "window.optimizerGuard.getSystemInfo().then((info) => ({ cpu: info.cpu.name, gpu: info.gpu.name, displays: info.displays, gameMode: info.gameMode, hags: info.hags }))")
  await check('cleaning scan', "window.optimizerGuard.scanCleaning().then((targets) => ({ count: targets.length, detected: targets.filter((target) => target.detected).length, estimatedBytes: targets.reduce((sum, target) => sum + target.estimatedBytes, 0) }))")
  await check('nvidia detection', "window.optimizerGuard.getNvidiaState().then((state) => ({ gpu: state.profile.gpuName, detectedResolution: state.profile.detectedResolution, preferredResolution: state.profile.preferredResolution, dlssMode: state.profile.dlssMode }))")
  await check('update checker', "window.optimizerGuard.checkForUpdates().then((update) => ({ currentVersion: update.currentVersion, latestVersion: update.latestVersion, error: update.error || '' }))")
  await check('tab click through', `
    (async () => {
      const labels = ['Tasks', 'System', 'Cleaning', 'NVIDIA', 'Logs', 'About']
      const visited = []
      for (const label of labels) {
        const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes(label))
        if (!button) throw new Error('Missing tab ' + label)
        button.click()
        await new Promise((resolve) => setTimeout(resolve, 250))
        visited.push(document.querySelector('.hero h1')?.textContent || label)
      }
      return visited
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
    { tab: 'NVIDIA', file: 'nvidia-dlss.png' },
    { tab: 'Logs', file: 'logs-restore.png' },
    { tab: 'About', file: 'about-updates.png' }
  ]

  for (const shot of shots) {
    await window.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(${JSON.stringify(shot.tab)}))?.click()
    `)
    await wait(900)
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
  ipcMain.handle('tasks:set-state', (_event, taskPath: string, enable: boolean, dryRun: boolean) =>
    service.setTaskState(taskPath, enable, dryRun)
  )
  ipcMain.handle('features:query', () => service.queryFeatures())
  ipcMain.handle('features:set-state', (_event, featureName: string, enable: boolean, dryRun: boolean) =>
    service.setFeature(featureName, enable, dryRun)
  )

  ipcMain.handle('clean:scan', () => service.scanCleaningTargets())
  ipcMain.handle('clean:run', (_event, ids: string[], dryRun: boolean) => service.cleanTargets(ids, dryRun))

  ipcMain.handle('nvidia:state', () => service.queryNvidiaState())
  ipcMain.handle('nvidia:apply', (_event, request: ApplyNvidiaProfileRequest, dryRun: boolean) =>
    service.applyNvidiaProfile(request, dryRun)
  )

  ipcMain.handle('restore:run', (_event, id: string, dryRun: boolean) => service.restore(id, dryRun))
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
