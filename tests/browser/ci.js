import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

const host = '127.0.0.1'
const root = new URL('../../', import.meta.url)
const allowedPath = /^(?:\/dist\/|\/tests\/(?:browser|fixtures)\/)[\w.-]+$/u
const requiredPlayback = [
  'mpeg-ts-remux',
  'segmented-mpeg-ts-remux',
  'segmented-mpeg-ts-combine',
  'mpeg-ts-rendition-switches',
  'mpeg-ts-rendition-upshift',
  'mixed-container-combine',
  'aligned-mixed-container-combine',
  'offset-normalized-audio',
  'edited-audio-copy',
  'edited-audio-normalized',
  'normalized-mixed-audio',
  'normalized-mp3-preroll',
]

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost')

  if (!allowedPath.test(pathname)) {
    response.writeHead(404).end()

    return
  }

  try {
    const content = await readFile(new URL(`.${pathname}`, root))
    const mime = pathname.endsWith('.html')
      ? 'text/html'
      : pathname.endsWith('.js')
        ? 'text/javascript'
        : 'application/octet-stream'

    response.writeHead(200, { 'Content-Type': mime }).end(content)
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end()
  }
})

server.listen(0, host)
await once(server, 'listening')

try {
  const { port } = server.address()
  const browser = await chromium.launch({ channel: 'chrome' })

  try {
    const page = await browser.newPage()

    await page.goto(`http://${host}:${port}/tests/browser/index.html`)
    await page.getByRole('button', { name: 'Run Worker / OPFS checks' }).click()
    const report = await page
      .locator('#result')
      .filter({ hasText: /"status": "(?:passed|failed)"/u })
      .textContent({ timeout: 90_000 })
    const { status, checks } = JSON.parse(report)

    assert.equal(status, 'passed', report)
    const playback = new Set(checks.map(check => check.playback))

    for (const label of requiredPlayback) {
      assert(
        playback.has(label),
        `Browser playback check was skipped: ${label}`,
      )
    }

    console.log(`Passed ${checks.length} browser integration checks.`)
  } finally {
    await browser.close()
  }
} finally {
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}
