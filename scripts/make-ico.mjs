// Generates a valid multi-size ICO from icon.png using to-ico (pure JS).
// to-ico handles resizing internally when given a single large PNG.
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import toIco from 'to-ico'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pngPath = path.join(__dirname, '../resources/icon.png')
const icoPath = path.join(__dirname, '../resources/icon.ico')

const png = readFileSync(pngPath)
const ico = await toIco([png], { sizes: [16, 32, 48, 256], resize: true })
writeFileSync(icoPath, ico)
console.log(`ICO written: ${icoPath} (${ico.length} bytes)`)
