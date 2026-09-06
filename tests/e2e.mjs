/**
 * The regression net.
 *
 * Almost all of this app's logic is geometry — which row a block lands on, which
 * character of the source that becomes — so it is tested by actually dragging
 * things in a browser rather than by unit-testing the parts in isolation. The
 * pure editing functions are exercised too, imported straight from the dev
 * server so they are the same modules the page runs.
 *
 *   npm test
 */
import { createServer } from 'vite'
import { chromium } from 'playwright'

const PORT = 5200 // not 5199: leave a hand-run dev server alone
const URL = `http://127.0.0.1:${PORT}/`

let pass = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}\n      expected ${e}\n      actual   ${a}`)
    console.log(`  ✗ ${name}  expected ${e}, got ${a}`)
  }
}
function checkThat(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name} ${detail}`)
    console.log(`  ✗ ${name} ${detail}`)
  }
}

const server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1' } })
await server.listen()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})
await page.goto(URL, { waitUntil: 'networkidle' })

// ---------- helpers ----------
const src = () => page.locator('#src').textContent()
const box = async (sel) => await page.locator(sel).first().boundingBox()
const mid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
const qubitTile = () => page.locator('#qubits .tile').first()
const gateTile = (cap) => page.locator('#gates .tile').filter({ hasText: cap }).first()
async function drag(from, to, steps = 20) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, from.y - 8, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
  await page.waitForTimeout(110)
}
const clear = async () => {
  await page.locator('#clear').click().catch(() => {})
  await page.waitForTimeout(60)
}
/** Qubit centres and circuit geometry, in screen coordinates. */
const geo = () =>
  page.evaluate(() => {
    const { spots, geometry } = window.__qs()
    const svg = document.querySelector('#figure svg')
    if (!svg) return null
    const m = svg.getScreenCTM()
    const X = (u) => m.a * u + m.e
    const Y = (u) => m.d * u + m.f
    return {
      spots: spots.map((s) => ({ x: X(s.cx), y: Y(s.cy), at: s.at })),
      colX: geometry ? geometry.columns.map(X) : [],
      layers: geometry ? geometry.layers.map((l) => ({ top: Y(l.y), mid: Y(l.y + l.h / 2), bot: Y(l.y + l.h) })) : [],
      startY: geometry ? Y(geometry.startY) : null,
      endY: geometry ? Y(geometry.endY) : null,
    }
  })
const canvas = await box('#canvas')
const centre = mid(canvas)

// ---------- the pure editing functions ----------
console.log('\nstate-edit (pure)')
const pure = await page.evaluate(async () => {
  const m = await import('/src/state-edit.ts')
  const s = (e) => (e ? e.source : null)
  const spot = (at) => ({ at, value: 0, cx: 0, cy: 0, size: 10 })
  return {
    insertAtEnd: s(m.insertQubit('0', 1, 1)),
    insertNewTerm: s(m.insertQubit('0', 1, 0, true)),
    sepSplits: s(m.dropSeparator('00', 1)),
    sepAddsQubitAtEnd: s(m.dropSeparator('0', 1)),
    sepAddsQubitToTerms: s(m.dropSeparator('0|1', 3)),
    refusesEmptyingATerm: s(m.moveQubit('0|1', 0, 0, 3)) === null ? 'refused' : 'allowed',
    moveAcross: s(m.moveQubit('01', 0, 0, 2)),
    removeMiddleRow: s(m.removeQubit('0\nH 1\n0|1', spot('0\nH 1\n0|1'.lastIndexOf('0|1')))),
    removeLastClears: s(m.removeQubit('0', spot(0))),
    spliceTop: s(m.spliceRow('H 1', 1, '0')),
    spliceEnd: s(m.spliceRow('0\nH 1', 99, '1')),
    rejectsGarbage: s(m.spliceRow('0', 1, '|||')) === null ? 'rejected' : 'accepted',
  }
})
check('insertQubit appends', pure.insertAtEnd, '01')
check('insertQubit starts a new term', pure.insertNewTerm, '0|0')
check('dropSeparator splits a pair', pure.sepSplits, '0|0')
check('dropSeparator brings a qubit (0 → 0|0)', pure.sepAddsQubitAtEnd, '0|0')
check('dropSeparator brings a qubit (0|1 → 0|1|0)', pure.sepAddsQubitToTerms, '0|1|0')
// A qubit that is the whole of its term cannot slide out of it: that would
// leave a bar with nothing on one side. Documented, not accidental.
check('moveQubit refuses to empty a term', pure.refusesEmptyingATerm, 'refused')
check('moveQubit slides across', pure.moveAcross, '10')
check('removeQubit works on a later row', pure.removeMiddleRow, '0\nH 1\n1')
check('removing the last qubit clears', pure.removeLastClears, '')
check('spliceRow puts a row on top', pure.spliceTop, '0\nH 1')
check('spliceRow clamps past the end', pure.spliceEnd, '0\nH 1\n1')
check('spliceRow rejects what will not parse', pure.rejectsGarbage, 'rejected')

// ---------- the palette ----------
console.log('\npalette')
check('qubit row holds ○ ? |', await page.locator('#qubits .tile').count(), 3)
check('every gate is offered', await page.locator('#gates .tile').count(), 10)
checkThat('CCNOT is present', (await gateTile('CCNOT').count()) === 1)
checkThat('the logo is a drawn state', (await page.locator('#logo svg').count()) === 1)
checkThat('the notation pane starts hidden', await page.locator('#source-pane').isHidden())

// ---------- building a state ----------
console.log('\nbuilding a state')
await drag(mid(await qubitTile().boundingBox()), centre)
check('drag a qubit in', await src(), '0')
let g = await geo()
await drag(mid(await qubitTile().boundingBox()), { x: g.spots[0].x + 45, y: g.spots[0].y })
check('drag a second qubit beside it', await src(), '00')
g = await geo()
await page.mouse.click(g.spots[1].x, g.spots[1].y)
await page.waitForTimeout(80)
check('click a qubit to flip it', await src(), '01')
g = await geo()
await drag({ x: g.spots[0].x, y: g.spots[0].y }, { x: g.spots[1].x + 45, y: g.spots[1].y })
check('drag a qubit along the state to move it', await src(), '10')
g = await geo()
await drag(mid(await page.locator('#term').boundingBox()), {
  x: (g.spots[0].x + g.spots[1].x) / 2,
  y: g.spots[0].y,
})
check('drop | between them', await src(), '1|0')
g = await geo()
await drag({ x: g.spots[0].x, y: g.spots[0].y }, { x: canvas.x + canvas.width + 90, y: centre.y })
check('drag a qubit out to delete it (its term closes up)', await src(), '0')

// ---------- gates and rows ----------
console.log('\ngates and rows')
await clear()
await drag(mid(await gateTile('H').boundingBox()), centre)
check('a gate on an empty canvas starts a circuit', await src(), 'H 1')
g = await geo()
await drag(mid(await qubitTile().boundingBox()), { x: g.colX[0], y: g.layers[0].top - 30 })
check('a qubit above a gate becomes a state row', await src(), '0\nH 1')

await clear()
await drag(mid(await qubitTile().boundingBox()), centre)
g = await geo()
await drag(mid(await gateTile('H').boundingBox()), { x: g.spots[0].x, y: g.spots[0].y - 60 })
check('a gate above a state takes the top row', await src(), 'H 1\n0')

await clear()
await drag(mid(await qubitTile().boundingBox()), centre)
await drag(mid(await gateTile('H').boundingBox()), centre)
g = await geo()
await drag({ x: g.spots[0].x, y: g.spots[0].y }, { x: g.colX[0], y: g.endY + 30 })
check('a state can move below a gate', await src(), 'H 1\n0')

await clear()
await drag(mid(await qubitTile().boundingBox()), centre)
await drag(mid(await gateTile('H').boundingBox()), centre)
g = await geo()
await drag(mid(await gateTile('NOT').boundingBox()), { x: g.colX[0], y: g.endY - 8 })
check('a second gate appends below', await src(), '0\nH 1\nX 1')
g = await geo()
await drag({ x: g.colX[0], y: g.layers[0].mid }, { x: g.colX[0], y: g.layers[1].bot + 16 })
check('a placed gate moves to another row', await src(), '0\nX 1\nH 1')

// ---------- states at any point ----------
console.log('\nstates at any point')
await clear()
await drag(mid(await qubitTile().boundingBox()), centre)
await drag(mid(await gateTile('H').boundingBox()), centre)
g = await geo()
await drag(mid(await gateTile('NOT').boundingBox()), { x: g.colX[0], y: g.endY - 8 })
g = await geo()
await drag(mid(await qubitTile().boundingBox()), { x: g.colX[0], y: g.endY + 8 })
check('a qubit below the circuit is the output', await src(), '0\nH 1\nX 1\n0')
g = await geo()
await drag(mid(await qubitTile().boundingBox()), {
  x: g.colX[0],
  y: (g.layers[0].bot + g.layers[1].top) / 2,
})
check('a qubit between gates is a snapshot', await src(), '0\nH 1\n0\nX 1\n0')

// ---------- controls cycle ----------
console.log('\ncontrolled gates')
await clear()
for (let i = 0; i < 3; i++) {
  const b = await geo()
  const to = b ? { x: b.spots[b.spots.length - 1].x + 45, y: b.spots[0].y } : centre
  await drag(mid(await qubitTile().boundingBox()), to)
}
check('a three-qubit register', await src(), '000')
await drag(mid(await gateTile('Fredkin').boundingBox()), centre)
check('drop a Fredkin', await src(), '000\nCSWAP 2 3 4')
g = await geo()
await page.mouse.click(g.colX[1], g.layers[0].mid)
await page.waitForTimeout(90)
check('click walks the swap control', await src(), '000\nCSWAP 3 2 4')
await clear()
for (let i = 0; i < 3; i++) {
  const b = await geo()
  const to = b ? { x: b.spots[b.spots.length - 1].x + 45, y: b.spots[0].y } : centre
  await drag(mid(await qubitTile().boundingBox()), to)
}
await drag(mid(await gateTile('CCNOT').boundingBox()), centre)
check('drop a CCNOT', await src(), '000\nTOFFOLI 2 3 4')
g = await geo()
await page.mouse.click(g.colX[1], g.layers[0].mid)
await page.waitForTimeout(90)
check('click walks the CCNOT target', await src(), '000\nTOFFOLI 3 4 2')

// ---------- keyboard ----------
console.log('\nkeyboard')
await clear()
await qubitTile().focus()
await page.keyboard.press('Enter')
await page.waitForTimeout(90)
check('Enter on a qubit tile adds one', await src(), '0')
await page.keyboard.press('Space')
await page.waitForTimeout(90)
check('Space adds another', await src(), '00')
await page.locator('#term').focus()
await page.keyboard.press('Enter')
await qubitTile().focus()
await page.keyboard.press('Enter')
await page.waitForTimeout(90)
check('Enter on | then a qubit starts a term', await src(), '00|0')
await gateTile('H').focus()
await page.keyboard.press('Enter')
await page.waitForTimeout(90)
check('Enter on a gate tile drops it in', await src(), '00|0\nH 1')

// ---------- export ----------
console.log('\nexport')
const png = await page
  .waitForFunction(() => window.__qs().pngUrl, null, { timeout: 15000 })
  .then((h) => h.jsonValue())
  .catch(() => null)
checkThat('a PNG is baked for dragging out', typeof png === 'string' && png.startsWith('data:image/png'))
if (typeof png === 'string') {
  const bytes = Buffer.from(png.split(',')[1], 'base64')
  const text = bytes.toString('latin1')
  checkThat('the PNG carries its notation', text.includes('misty-source'), '(no source chunk found)')
}

// ---------- the drag must not re-encode the PNG on every frame ----------
console.log('\nperformance')
await page.evaluate(() => {
  window.__enc = 0
  const orig = HTMLCanvasElement.prototype.toBlob
  HTMLCanvasElement.prototype.toBlob = function (...a) {
    window.__enc++
    return orig.apply(this, a)
  }
})
g = await geo()
await drag(mid(await gateTile('Z').boundingBox()), { x: g.colX[0], y: centre.y }, 40)
await page.waitForTimeout(400)
const encodes = await page.evaluate(() => window.__enc)
checkThat(
  'one drag rasterises the PNG at most twice',
  encodes <= 2,
  `(${encodes} rasterisations for ~43 pointer moves)`,
)

// ---------- report ----------
checkThat('no console errors', errors.length === 0, errors.join(' | '))
await browser.close()
await server.close()

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:\n  ' + failures.join('\n  '))
  process.exit(1)
}
