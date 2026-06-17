import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { OptimizerService } from './optimizer'
import type { AppSettings, ApplyNvidiaProfileRequest } from '../shared/types'

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
    if (process.env.OPTIMIZER_GUARD_CAPTURE === '1') {
      void captureScreenshots(mainWindow)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function captureScreenshots(window: BrowserWindow | null): Promise<void> {
  if (!window) return
  const outputDir = join(process.cwd(), 'docs', 'screenshots')
  mkdirSync(outputDir, { recursive: true })
  window.setSize(1440, 960)
  await wait(1200)

  const shots = [
    { tab: 'Task Disabler', file: 'task-disabler.png' },
    { tab: 'System / BIOS Info', file: 'system-info.png' },
    { tab: 'Cleaning', file: 'cleaning.png', before: "document.querySelector('.primary')?.click()" },
    { tab: 'NVIDIA / DLSS Suggestions', file: 'nvidia-dlss.png' },
    { tab: 'Logs / Restore', file: 'logs-restore.png' }
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.syrox.optimizer.guard')
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
