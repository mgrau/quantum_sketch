import { render, type RenderResult } from 'misty-states/render'
import { embedSvgMeta } from 'misty-states/metadata'
import { pngDataUrl as pngDataUrlFromSvg, svgToPngBlob } from 'misty-states/encode'
import {
  GATE_GALLERY, asDroppable, cycleTarget, gateAt, gateLine, insertGate, moveGate, nextQubit,
  parseCircuit, qubitAt, removeGate, setQubit,
  type CircuitDoc, type Droppable, type Edit, type Gate, type QubitSpot, type Swatch,
} from 'misty-states/kernel'
import {
  appendOffset, dropSeparator, gateTargetAt, insertQubit, moveQubit, moveQubitTo, moveSeparator,
  placeGate, removeQubit, removeSeparator, spliceRow, stateEditFor, stateInsertAt,
  type DropGeo, type QubitValue,
} from './state-edit'
import './app.css'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

// ---------- one source of truth ----------
let source = '' // the misty source every block edits
let dragPreview: Edit | null = null // what a drop would produce
let result: RenderResult | null = null // last render (svg, geometry, qubitSpots)
let pendingTerm = false // a tap on a qubit now starts a new superposition term
const history: string[] = [] // past sources, for Undo
let pngReady: { source: string; url: string } | null = null // for drag-out
let exporting = false // an empty press on the figure is a drag-out, not an edit

// ---------- elements ----------
const figureEl = $('figure')
const canvasEl = $('canvas')
const hintEl = $('hint')
const srcEl = $('src')
const carryEl = $('carry')
let termTile: HTMLButtonElement // the "| new term" tile, built into the qubit row

// ---------- palette from the real gallery ----------
const FLAT: Swatch[] = GATE_GALLERY.flatMap((g) => g.items)
const CAP: Record<string, string> = {
  H: 'H', X: 'NOT', Z: 'Z', S: 'S', T: 'T', CNOT: 'CNOT', TOFFOLI: 'CCNOT', CZ: 'CZ', SWAP: 'SWAP', CSWAP: 'Fredkin',
}
const GATE_TILES = ['H 1', 'X 1', 'Z 1', 'S 1', 'T 1', 'CNOT 1 2', 'TOFFOLI 1 2 3', 'CZ 1 2', 'SWAP 1 2', 'CSWAP 1 2 3']
  .map((code) => FLAT.find((i) => i.code === code))
  .filter((i): i is Swatch & { drop: Droppable } => !!i && !!i.drop)
const QUBITS: { v: QubitValue; cap: string; glyph: string }[] = [
  { v: 0, cap: 'qubit', glyph: '0' },
  { v: 'unknown', cap: 'unknown', glyph: '?' },
]

// ---------- history ----------
function setSource(next: string, snapshot = true) {
  if (snapshot) {
    history.push(source)
    if (history.length > 80) history.shift()
  }
  source = next
  dragPreview = null
  draw()
}
function undo() {
  if (!history.length) return
  source = history.pop()!
  dragPreview = null
  pendingTerm = false
  draw()
}
function clearAll() {
  if (!source) return
  pendingTerm = false
  setSource('')
}

// ---------- render ----------
function draw() {
  const src = dragPreview ? dragPreview.source : source
  const empty = !src
  hintEl.hidden = !empty
  figureEl.hidden = empty
  if (empty) {
    result = null
    figureEl.innerHTML = ''
  } else {
    try {
      result = render(src, { check: false, idPrefix: 'fig', highlight: dragPreview ? dragPreview.line : undefined })
      figureEl.innerHTML = result.svg
    } catch {
      result = null
      figureEl.innerHTML = ''
    }
  }
  termTile.classList.toggle('armed', pendingTerm)
  srcEl.textContent = source || '—'
  ;($('undo') as HTMLButtonElement).disabled = history.length === 0
  ;($('clear') as HTMLButtonElement).disabled = !source
  ;($('copy') as HTMLButtonElement).disabled = !source
  bakePng()
}

// The exported PNG carries its own notation: the source is written into the
// SVG's metadata and svgToPngBlob copies that into the PNG's text chunks, so a
// saved image can be traced back to (and reopened as) the sketch that made it.
function svgWithSource(): string {
  // background:false → a transparent PNG, so it drops onto any slide colour.
  return embedSvgMeta(render(source, { check: false, background: false }).svg, { source, name: 'Quantum Sketch' })
}

/**
 * The drag-out PNG, baked a beat after the drawing settles.
 *
 * Only ever once per source. `draw()` runs on every pointer move so the preview
 * can follow the finger, and rasterising there meant re-rendering and re-encoding
 * the *committed* figure dozens of times a drag for a byte-identical result.
 */
let baked = '' // the source pngReady was baked from, so the work is done once
function bakePng() {
  if (source === baked) return
  baked = source
  pngReady = null
  if (!source) return
  const forSrc = source
  pngDataUrlFromSvg(svgWithSource(), 3)
    .then((url) => {
      if (source === forSrc) pngReady = { source: forSrc, url }
    })
    // A failed bake leaves `pngReady` null, which refuses the drag-out rather
    // than handing over a stale image. No retry: the same source would fail again.
    .catch(() => {})
}

// ---------- geometry helpers ----------
function svgInv(): DOMMatrix | null {
  const svg = figureEl.querySelector('svg') as SVGGraphicsElement | null
  const m = svg?.getScreenCTM()
  return m ? m.inverse() : null
}
const toDiagram = (inv: DOMMatrix, e: PointerEvent) => {
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv)
  return { x: p.x, y: p.y }
}
function qubitUnder(e: PointerEvent): QubitSpot | undefined {
  if (!result?.qubitSpots?.length) return undefined
  const inv = svgInv()
  return inv ? qubitAt(result.qubitSpots, toDiagram(inv, e)) : undefined
}
// A placed separator has no spot; synthesise one midway between the qubits it divides.
type SepSpot = { at: number; cx: number; cy: number; size: number }
/** True where this offset sits inside a quoted label, whose `|` is not a separator. */
function quoted(src: string, at: number): boolean {
  const from = src.lastIndexOf('\n', at) + 1
  let quotes = 0
  for (let i = from; i < at; i++) if (src[i] === '"') quotes++
  return quotes % 2 === 1
}
function separatorSpots(): SepSpot[] {
  const spots = result?.qubitSpots ?? []
  const out: SepSpot[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '|' || quoted(source, i)) continue
    let left: QubitSpot | undefined
    let right: QubitSpot | undefined
    for (const s of spots) {
      if (s.at < i && (!left || s.at > left.at)) left = s
      if (s.at > i && (!right || s.at < right.at)) right = s
    }
    if (left && right && Math.round(left.cy) === Math.round(right.cy)) {
      out.push({ at: i, cx: (left.cx + right.cx) / 2, cy: left.cy, size: left.size })
    }
  }
  return out
}
function sepUnder(e: PointerEvent): SepSpot | undefined {
  const inv = svgInv()
  if (!inv) return undefined
  const p = toDiagram(inv, e)
  return separatorSpots().find((s) => Math.abs(p.x - s.cx) <= s.size / 2 && Math.abs(p.y - s.cy) <= s.size)
}
function gateUnder(e: PointerEvent): { gate: Gate; doc: CircuitDoc } | undefined {
  if (!result?.geometry) return undefined
  const inv = svgInv()
  if (!inv) return undefined
  let doc: CircuitDoc
  try {
    doc = parseCircuit(source)
  } catch {
    return undefined
  }
  const gate = gateAt(doc, result.geometry, toDiagram(inv, e))
  return gate ? { gate, doc } : undefined
}

// State qubits grouped into rows, so a picked qubit can find its nearest one.
function rowsOf(spots: QubitSpot[]): QubitSpot[][] {
  const by = new Map<number, QubitSpot[]>()
  for (const s of spots) {
    const k = Math.round(s.cy)
    const row = by.get(k) ?? []
    row.push(s)
    by.set(k, row)
  }
  return [...by.values()]
}
function nearestRow(spots: QubitSpot[], at: { x: number; y: number }): QubitSpot[] | null {
  const reach = (spots[0]?.size ?? 20) * 1.3
  let best: QubitSpot[] | null = null
  let bestD = reach
  for (const row of rowsOf(spots)) {
    const d = Math.abs(at.y - row[0].cy)
    if (d <= bestD) {
      bestD = d
      best = row
    }
  }
  return best
}
function wireFromSpots(spots: QubitSpot[], x: number): number {
  if (!spots.length) return 1
  const sorted = [...spots].sort((a, b) => a.cx - b.cx)
  let wire = 1
  let best = Infinity
  sorted.forEach((s, i) => {
    const d = Math.abs(x - s.cx)
    if (d < best) {
      best = d
      wire = i + 1
    }
  })
  return wire
}

// ---------- one carry system for every block ----------
const GM = { qubit: 12, pipeWidth: 14, colGap: 10, gateHeight: 24, fontSize: 11 } // gate-swatch metrics
type StateCarry =
  | { type: 'add'; value: QubitValue; x0: number; y0: number; moved: boolean }
  | { type: 'sep'; x0: number; y0: number; moved: boolean }
  | { type: 'pick'; spot: QubitSpot; x0: number; y0: number; moved: boolean }
  | { type: 'pickSep'; at: number; x0: number; y0: number; moved: boolean }
  | { type: 'gate'; drop: Droppable; face: string; x0: number; y0: number; moved: boolean }
  | { type: 'pickGate'; gate: Gate; x0: number; y0: number; moved: boolean }
let carry: StateCarry | null = null
let carryId = -1 // the pointer that owns the carry; a second finger is ignored
let frozen: { spots: QubitSpot[]; inv: DOMMatrix | null; geo: DropGeo | null; doc: CircuitDoc | null } | null = null
let carryFace = '' // the block being dragged, drawn, so you can see it in hand

const glyphOf = (v: QubitValue) => (v === 0 ? '0' : v === 1 ? '1' : '?')
const within = (el: Element, x: number, y: number) => {
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}
// Touch taps jitter more than a mouse; a finger that lands and lifts within this
// slop is a tap (cycle/toggle/add), not a drag — decided by the release point.
let slop = 5
const strayed = (c: { x0: number; y0: number }, e: PointerEvent) =>
  Math.abs(e.clientX - c.x0) > slop || Math.abs(e.clientY - c.y0) > slop
const isTap = (c: { x0: number; y0: number }, e: PointerEvent) =>
  Math.abs(e.clientX - c.x0) <= slop && Math.abs(e.clientY - c.y0) <= slop

// The rendered face of whatever is being carried, so the chip shows the real thing.
function faceOf(c: StateCarry): string {
  if (c.type === 'gate') return c.face
  if (c.type === 'add') return swatch(glyphOf(c.value), { qubit: 22 }, 'cf')
  if (c.type === 'pick') return swatch(glyphOf(c.spot.value), { qubit: 22 }, 'cf')
  if (c.type === 'pickGate') {
    const d = asDroppable(c.gate)
    return swatch(gateLine(d, 1, d.wires), GM, 'cf')
  }
  return '<span class="glyph">|</span>' // sep, pickSep
}

function chip(x: number, y: number, html: string, removing = false) {
  carryEl.hidden = false
  carryEl.innerHTML = html
  carryEl.classList.toggle('removing', removing)
  carryEl.style.left = x + 'px'
  carryEl.style.top = y + 'px'
}
function showChip(e: PointerEvent, removing = false) {
  chip(e.clientX, e.clientY, removing ? 'remove' : carryFace, removing)
}
const hideChip = () => {
  carryEl.hidden = true
  carryEl.classList.remove('removing')
}

function startCarry(c: StateCarry, e: PointerEvent, doc?: CircuitDoc) {
  if (carry) return // one block at a time: a second finger does not start another
  // A press on the figure must not also start a native image drag; a press on a
  // palette tile must NOT preventDefault, so a horizontal touch can still scroll.
  if (c.type === 'pick' || c.type === 'pickSep' || c.type === 'pickGate') e.preventDefault()
  slop = e.pointerType === 'touch' ? 12 : 5
  carry = c
  carryId = e.pointerId
  exporting = false
  let parsed: CircuitDoc | null = doc ?? null
  if (!parsed && source) {
    try {
      parsed = parseCircuit(source)
    } catch {
      parsed = null
    }
  }
  frozen = {
    spots: result?.qubitSpots ?? [],
    inv: svgInv(),
    geo: (result?.geometry ?? null) as DropGeo | null,
    doc: parsed,
  }
  carryFace = faceOf(c)
  showChip(e)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey)
}

/** Put the carried block down and let go of every listener, whatever ended it. */
function releaseCarry(): StateCarry | null {
  const c = carry
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onCancel)
  window.removeEventListener('keydown', onKey)
  carry = null
  carryId = -1
  hideChip()
  return c
}

// A touch that turns into a scroll cancels the pointer; drop the carry cleanly.
function onCancel(e: PointerEvent) {
  if (e.pointerId !== carryId) return
  releaseCarry()
  dragPreview = null
  draw()
}

// What a gate carry would produce at this point (a palette drop, or moving one).
function gateEditAt(e: PointerEvent, drop: Droppable | null, gate: Gate | null): Edit | null {
  if (!frozen) return null
  if (!within(canvasEl, e.clientX, e.clientY)) {
    // Dragged out of the canvas: delete an existing gate; a palette gate vanishes.
    if (gate && frozen.doc) {
      const cut = removeGate(source, frozen.doc, gate)
      return cut ? { source: cut.source, line: 0 } : null
    }
    return null
  }
  const p = frozen.inv ? toDiagram(frozen.inv, e) : null
  if (drop) {
    if (!source) return { source: gateLine(drop, 1, 0), line: 1 } // empty diagram
    if (!p || !frozen.doc) return null
    if (frozen.geo) return placeGate(source, frozen.doc, frozen.geo, drop, p) // a circuit: any row
    // A bare state has no laid-out grid: above it goes a new top row, below it the next.
    const wire = wireFromSpots(frozen.spots, p.x)
    const cy = frozen.spots[0]?.cy ?? -Infinity
    const line = p.y < cy ? 1 : source.split('\n').length + 1
    return spliceRow(source, line, gateLine(drop, wire, frozen.doc.qubits))
  }
  if (gate && frozen.doc && frozen.geo && p) {
    try {
      return moveGate(source, frozen.doc, gate, gateTargetAt(frozen.doc, frozen.geo, p))
    } catch {
      return null
    }
  }
  return null
}

function onMove(e: PointerEvent) {
  const c = carry
  if (!c || !frozen || e.pointerId !== carryId) return
  if (!c.moved && strayed(c, e)) c.moved = true

  if (c.type === 'gate' || c.type === 'pickGate') {
    const drop = c.type === 'gate' ? c.drop : null
    const gate = c.type === 'pickGate' ? c.gate : null
    const off = c.type === 'pickGate' && !within(canvasEl, e.clientX, e.clientY)
    showChip(e, off)
    dragPreview = gateEditAt(e, drop, gate)
    draw()
    return
  }

  if (c.type === 'pick') {
    const inCanvas = within(canvasEl, e.clientX, e.clientY)
    const p = frozen.inv ? toDiagram(frozen.inv, e) : null
    if (c.moved && !inCanvas) {
      showChip(e, true)
      dragPreview = removeQubit(source, c.spot) // dragged out: delete
    } else if (c.moved && p) {
      showChip(e)
      dragPreview =
        frozen.doc && frozen.geo
          ? moveQubitTo(source, frozen.doc, frozen.geo, frozen.spots, c.spot, c.spot.value, p)
          : bareMove(c.spot, c.spot.value, p)
    } else {
      showChip(e)
      dragPreview = null
    }
    draw()
    return
  }

  if (c.type === 'pickSep') {
    const inCanvas = within(canvasEl, e.clientX, e.clientY)
    const p = frozen.inv ? toDiagram(frozen.inv, e) : null
    const row = p ? nearestRow(frozen.spots, p) : null
    if (c.moved && !inCanvas) {
      showChip(e, true)
      dragPreview = removeSeparator(source, c.at)
    } else if (c.moved && row && p) {
      showChip(e)
      dragPreview = moveSeparator(source, c.at, stateInsertAt(row, p))
    } else {
      showChip(e)
      dragPreview = null
    }
    draw()
    return
  }

  // add / sep from the palette
  showChip(e)
  dragPreview = within(canvasEl, e.clientX, e.clientY) ? stateEditAt(c, e) : null
  draw()
}

function bareMove(spot: QubitSpot, value: QubitValue, p: { x: number; y: number }): Edit | null {
  const row = nearestRow(frozen!.spots, p)
  return row ? moveQubit(source, spot.at, value, stateInsertAt(row, p)) : null
}

function stateEditAt(c: { type: 'add'; value: QubitValue } | { type: 'sep' }, e: PointerEvent): Edit | null {
  if (!frozen) return null
  if (!source) return c.type === 'add' ? insertQubit(source, 0, c.value) : null // truly empty
  if (!frozen.inv) return null
  const p = toDiagram(frozen.inv, e)
  if (frozen.doc && frozen.geo) {
    // A circuit: extend a state row, or start a new one on any gate row or gap.
    return stateEditFor(source, frozen.doc, frozen.geo, frozen.spots, c.type === 'sep' ? { sep: true } : { value: c.value }, p)
  }
  // A bare state (no laid-out rows): extend the row, or stack a new state row.
  const row = nearestRow(frozen.spots, p)
  if (c.type === 'sep') return row ? dropSeparator(source, stateInsertAt(row, p)) : null
  if (row) return insertQubit(source, stateInsertAt(row, p), c.value)
  const cy = frozen.spots[0]?.cy ?? -Infinity
  return spliceRow(source, p.y < cy ? 1 : source.split('\n').length + 1, glyphOf(c.value))
}

/* -- what a tap does, shared by pointer taps and the keyboard -------------- */

/** Add a qubit at the end of the state (a new term when the `|` is armed). */
function tapQubit(value: QubitValue): Edit | null {
  const at = appendOffset(result?.qubitSpots ?? [])
  const edit = insertQubit(source, at, value, pendingTerm && !!source)
  pendingTerm = false
  return edit
}
/** Arm the separator, so the next qubit starts a new superposition term. */
function tapSeparator() {
  if (source) pendingTerm = !pendingTerm
  draw()
}
/** A tapped gate drops in at the bottom of the circuit (a new gate row). */
function tapAddGate(drop: Droppable): Edit | null {
  if (!source) return { source: gateLine(drop, 1, 0), line: 1 }
  let doc: CircuitDoc
  try {
    doc = parseCircuit(source)
  } catch {
    return null
  }
  const layer = doc.layers.length ? doc.layers.length - 1 : 0
  try {
    return insertGate(source, doc, { wire: 1, layer, where: 'after' }, drop)
  } catch {
    return null
  }
}
/** Commit an edit, or say so when the block had nowhere to go. */
function commit(edit: Edit | null) {
  if (edit) setSource(edit.source)
  else {
    draw()
    toast('That block has nowhere to go there')
  }
}

function onUp(e: PointerEvent) {
  if (e.pointerId !== carryId) return
  const c = releaseCarry()
  if (!c) return

  const tap = isTap(c, e) // decided by the release point, so jitter is still a tap
  const edit = dragPreview
  dragPreview = null

  // pick: a tap toggles the qubit; a real drag commits the move/remove.
  if (c.type === 'pick') {
    if (tap) {
      const t = setQubit(source, c.spot.at, nextQubit(c.spot.value))
      t ? setSource(t.source) : draw()
    } else commit(edit)
    return
  }

  // pickGate: a tap cycles a controlled gate's control; a drag moves/removes it.
  if (c.type === 'pickGate') {
    if (tap) {
      // A gate with no control to move (an H, say) simply has nothing to cycle.
      const spun = frozen?.doc ? cycleTarget(source, frozen.doc, c.gate) : null
      spun ? setSource(spun.source) : draw()
    } else commit(edit)
    return
  }

  // gate from the palette: a tap drops it in at the bottom; a drag places it.
  if (c.type === 'gate') {
    commit(tap ? tapAddGate(c.drop) : edit)
    return
  }

  if (c.type === 'pickSep') {
    commit(edit)
    return
  }

  // add / sep from the palette
  if (tap) {
    if (c.type === 'sep') tapSeparator()
    else commit(tapQubit(c.value))
  } else if (c.type === 'sep' && edit) {
    setSource(edit.source)
    pendingTerm = false
  } else commit(edit)
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !carry) return
  releaseCarry()
  dragPreview = null
  draw()
}

// ---------- palette ----------
function swatch(src: string, metrics: Record<string, number>, prefix: string) {
  try {
    return render(src, { check: false, idPrefix: prefix, metrics }).svg
  } catch {
    return ''
  }
}
function tile(cls: string, face: string, cap: string) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'tile ' + cls
  b.title = cap
  b.innerHTML = `<span class="face">${face}</span><span class="cap">${cap}</span>`
  return b
}
/**
 * Enter and Space on a focused tile do what a tap does.
 *
 * The tiles are dragged with pointer events, which the keyboard has no way to
 * produce — so a keyboard-generated click (`detail === 0`, no mouse behind it)
 * is routed to the same tap action a finger gets.
 */
function onKeyActivate(el: HTMLElement, run: () => void) {
  el.addEventListener('click', (e) => {
    if ((e as MouseEvent).detail === 0) run()
  })
}
function buildPalette() {
  const qWrap = $('qubits')
  QUBITS.forEach((q, i) => {
    const t = tile('qubit', swatch(q.glyph, { qubit: 26 }, 'q' + i), q.cap)
    t.addEventListener('pointerdown', (e) =>
      startCarry({ type: 'add', value: q.v, x0: e.clientX, y0: e.clientY, moved: false }, e),
    )
    onKeyActivate(t, () => commit(tapQubit(q.v)))
    qWrap.appendChild(t)
  })
  // The superposition separator sits on the same row as the qubits.
  termTile = tile('glyph term', '|', 'new term')
  termTile.id = 'term'
  termTile.title = 'Split into a superposition'
  termTile.addEventListener('pointerdown', (e) =>
    startCarry({ type: 'sep', x0: e.clientX, y0: e.clientY, moved: false }, e),
  )
  onKeyActivate(termTile, tapSeparator)
  qWrap.appendChild(termTile)

  const gWrap = $('gates')
  GATE_TILES.forEach((item, i) => {
    const cap = CAP[item.drop.head] || item.drop.head
    const face = swatch(item.source || item.code, GM, 'g' + i)
    const t = tile('gate', face, cap)
    t.addEventListener('pointerdown', (e) =>
      startCarry({ type: 'gate', drop: item.drop, face, x0: e.clientX, y0: e.clientY, moved: false }, e),
    )
    onKeyActivate(t, () => commit(tapAddGate(item.drop)))
    gWrap.appendChild(t)
  })
}

// ---------- the figure: press a block to edit it, or an empty spot to drag it out ----------
figureEl.addEventListener('pointerdown', (e) => {
  const spot = qubitUnder(e)
  if (spot) {
    startCarry({ type: 'pick', spot, x0: e.clientX, y0: e.clientY, moved: false }, e)
    return
  }
  const sep = sepUnder(e)
  if (sep) {
    startCarry({ type: 'pickSep', at: sep.at, x0: e.clientX, y0: e.clientY, moved: false }, e)
    return
  }
  const g = gateUnder(e)
  if (g) {
    startCarry({ type: 'pickGate', gate: g.gate, x0: e.clientX, y0: e.clientY, moved: false }, e, g.doc)
    return
  }
  exporting = true // empty press: let the native drag export a PNG
})
figureEl.addEventListener('dragstart', (e) => {
  if (!exporting || !pngReady || pngReady.source !== source) {
    e.preventDefault()
    return
  }
  e.dataTransfer!.setData('DownloadURL', `image/png:quantum-sketch.png:${pngReady.url}`)
  e.dataTransfer!.setData('text/uri-list', pngReady.url)
  e.dataTransfer!.setData('text/html', `<img src="${pngReady.url}" alt="quantum sketch">`)
  e.dataTransfer!.effectAllowed = 'copy'
})

// ---------- buttons ----------
let toastTimer: ReturnType<typeof setTimeout>
function toast(msg: string) {
  const el = $('toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600)
}
$('undo').addEventListener('click', undo)
$('clear').addEventListener('click', clearAll)
const sourcePane = $('source-pane')
$('notation').addEventListener('click', () => {
  const show = sourcePane.hidden
  sourcePane.hidden = !show
  $('notation').setAttribute('aria-pressed', String(show))
})
$('copy').addEventListener('click', async () => {
  if (!source) return
  // The clipboard image API needs a secure context (HTTPS or localhost); over
  // plain HTTP on a phone it is absent, so fall back to saving the PNG.
  const canCopy = !!(window.isSecureContext && navigator.clipboard && window.ClipboardItem)
  if (canCopy) {
    try {
      // Hand ClipboardItem the *promise* and call write synchronously, so the
      // copy stays inside the tap gesture — iOS Safari rejects it otherwise.
      const png = svgToPngBlob(svgWithSource(), 3)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      toast('Copied as PNG — paste into your doc')
      return
    } catch {
      /* fall through to a download */
    }
  }
  try {
    const blob = await svgToPngBlob(svgWithSource(), 3)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'quantum-sketch.png'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    toast(canCopy ? 'Saved PNG' : 'Saved PNG — clipboard needs HTTPS')
  } catch {
    toast('Could not export the PNG')
  }
})

buildPalette()
$('logo').innerHTML = swatch('0|1', { qubit: 20 }, 'logo') // the wordmark's mark is a misty state
draw()

// Dev-only hook so end-to-end tests can read state + geometry.
if (import.meta.env.DEV)
  (window as unknown as { __qs: () => unknown }).__qs = () => ({
    source,
    spots: result?.qubitSpots ?? [],
    geometry: result?.geometry ?? null,
    pngUrl: pngReady?.url ?? null,
  })
