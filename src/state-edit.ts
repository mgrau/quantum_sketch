/**
 * Building a *state* by dropping blocks onto it — the one edit the core drawing
 * library can't do yet (it drags gates, not qubits).
 *
 * Like the circuit editor, every edit is expressed as new source *text*, which
 * is then re-parsed and re-drawn: there is one representation, so nothing to
 * keep in step. A state lays a register out left-to-right and its superposition
 * terms left-to-right too, separated by `|` bars — so "where" is a horizontal
 * question, and the separator is its own block because that is what tells a run
 * of qubits from two terms.
 *
 * These live in the app for now; they are pure and portable, so they can be
 * lifted into `misty-states` core (a real `state/edit.ts`) once the behaviour
 * has settled.
 */
import { gateLine, insertGate, parseCircuit } from 'misty-states/kernel'
import type { CircuitDoc, DropTarget, Droppable, Edit, QubitSpot } from 'misty-states/kernel'

export type QubitValue = QubitSpot['value']
export interface Point {
  x: number
  y: number
}

/**
 * The diagram as a stack of rows.
 *
 * A row is either a *gate* layer or a *state* (the input, an intermediate view,
 * or the output) — never both, which is the whole rule. Both are just lines in
 * the source: the input is the first state line, a view is a bare state line
 * between gates, the output is a bare state line after the last gate. So placing
 * anything is the same question — which row, or which gap between rows — asked
 * once here and answered the same way for a gate and for a qubit.
 */
export interface DropGeo {
  columns: number[]
  layers: { y: number; h: number }[]
  startY: number
  endY: number
}

interface Row {
  kind: 'gate' | 'state'
  cy: number
  /** doc.layers index, or -1 for the input row, -2 for the output row. */
  li: number
}

function wireAt(columns: number[], x: number): number {
  if (!columns.length) return 1
  let wire = 1
  let best = Infinity
  columns.forEach((cx, i) => {
    const d = Math.abs(x - cx)
    if (d < best) {
      best = d
      wire = i + 1
    }
  })
  const gap = columns.length > 1 ? columns[1] - columns[0] : 60
  if (x > columns[columns.length - 1] + gap * 0.6) wire = columns.length + 1
  return wire
}

function buildRows(doc: CircuitDoc, geo: DropGeo): Row[] {
  const rows: Row[] = []
  if (doc.input) rows.push({ kind: 'state', cy: geo.startY, li: -1 })
  doc.layers.forEach((layer, i) => {
    const view = layer.gates.length > 0 && layer.gates.every((g) => g.kind === 'view')
    const gl = geo.layers[i]
    rows.push({ kind: view ? 'state' : 'gate', cy: gl.y + gl.h / 2, li: i })
  })
  if (doc.output?.length) rows.push({ kind: 'state', cy: geo.endY, li: -2 })
  return rows
}

/** Which row a height falls in, and whether it lands *on* the row or at an edge. */
function locate(rows: Row[], y: number): { i: number; zone: 'in' | 'before' | 'after' } {
  for (let i = 0; i < rows.length; i++) {
    const lo = i > 0 ? (rows[i - 1].cy + rows[i].cy) / 2 : -Infinity
    const hi = i < rows.length - 1 ? (rows[i].cy + rows[i + 1].cy) / 2 : Infinity
    if (y >= lo && y < hi) {
      // The middle half of a row's territory lands on it; the outer quarters,
      // top and bottom, read as going between — the same split for every row.
      const half = Math.min(rows[i].cy - lo, hi - rows[i].cy)
      const inner = Number.isFinite(half) ? half * 0.5 : Infinity
      if (y < rows[i].cy - inner) return { i, zone: 'before' }
      if (y > rows[i].cy + inner) return { i, zone: 'after' }
      return { i, zone: 'in' }
    }
  }
  return { i: rows.length - 1, zone: 'after' }
}

/**
 * Where dropping a gate lands, row-aware: onto a gate row it shares the layer;
 * onto a state row or a gap it takes a new layer of its own, so a gate and a
 * state never end up on one row.
 */
export function gateTargetAt(doc: CircuitDoc, geo: DropGeo, at: Point): DropTarget {
  const wire = wireAt(geo.columns, at.x)
  const rows = buildRows(doc, geo)
  if (!rows.length) return { wire, layer: 0, where: 'after' }
  const t = locate(rows, at.y)
  const row = rows[t.i]
  if (row.kind === 'gate' && row.li >= 0 && t.zone === 'in') return { wire, layer: row.li, where: 'in' }
  const where: 'before' | 'after' = t.zone === 'in' ? (at.y < row.cy ? 'before' : 'after') : t.zone
  if (row.li >= 0) return { wire, layer: row.li, where }
  if (row.li === -1) return { wire, layer: 0, where: doc.layers.length ? 'before' : 'after' } // input row
  return { wire, layer: Math.max(0, doc.layers.length - 1), where: 'after' } // output row
}

/**
 * Where dropping a qubit (or a separator) lands: onto a state row it extends it;
 * onto a gate row or a gap it starts a new state row (a separator only ever
 * extends, since it divides a state rather than being one).
 */
export function stateEditFor(
  source: string,
  doc: CircuitDoc,
  geo: DropGeo,
  spots: QubitSpot[],
  kind: { value: QubitValue } | { sep: true },
  at: Point,
): Edit | null {
  const rows = buildRows(doc, geo)
  if (!rows.length) return 'value' in kind ? insertQubit(source, 0, kind.value) : null
  const t = locate(rows, at.y)
  const row = rows[t.i]

  if (row.kind === 'state' && t.zone === 'in') {
    const near = spots.filter((s) => Math.abs(s.cy - row.cy) <= (spots[0]?.size ?? 20))
    const off = stateInsertAt(near.length ? near : spots, at)
    return 'value' in kind ? insertQubit(source, off, kind.value) : dropSeparator(source, off)
  }

  if (!('value' in kind)) return null // a separator can't start a row

  const where: 'before' | 'after' = t.zone === 'in' ? (at.y < row.cy ? 'before' : 'after') : t.zone
  return spliceRow(source, rowLineFor(doc, rows, t.i, where), charOf(kind.value))
}

/** The source line a new row belongs on, before/after the row it was aimed at. */
function rowLineFor(doc: CircuitDoc, rows: Row[], i: number, where: 'before' | 'after'): number {
  const row = rows[i]
  if (row.li >= 0) {
    const ls = doc.layers[row.li].lines
    return where === 'before' ? Math.min(...ls) : Math.max(...ls) + 1
  }
  if (row.li === -1) {
    const inLine = doc.inputLine ?? 1
    return where === 'before' ? inLine : inLine + 1
  }
  const lastGate = doc.layers.length ? Math.max(...doc.layers.flatMap((l) => l.lines)) : doc.inputLine ?? 1
  return where === 'before' ? lastGate + 1 : Infinity // Infinity → clamped to the end
}

/** Put `text` on its own line before source line `line` (clamped into range). */
export function spliceRow(source: string, line: number, text: string): Edit | null {
  const lines = source.split('\n')
  const at = Math.max(1, Math.min(line, lines.length + 1))
  const next = [...lines.slice(0, at - 1), text, ...lines.slice(at - 1)].join('\n')
  if (next === source || !parses(next)) return null
  return { source: next, line: at }
}

/**
 * Where a dragged gate lands, row-aware and covering every row.
 *
 * Onto a gate row it shares the layer; onto a state row or a gap it takes a new
 * row; above the input state it goes on top, turning that state into the result
 * drawn below it — a case the layer-based insert cannot reach, so it is spliced
 * as a plain line.
 */
export function placeGate(source: string, doc: CircuitDoc, geo: DropGeo, drop: Droppable, at: Point): Edit | null {
  const wire = wireAt(geo.columns, at.x)
  const rows = buildRows(doc, geo)
  if (!rows.length) return spliceRow(source, 1, gateLine(drop, wire, doc.qubits))
  if (rows[0].li === -1 && at.y < rows[0].cy) {
    return spliceRow(source, doc.inputLine ?? 1, gateLine(drop, wire, doc.qubits)) // a new top gate row
  }
  try {
    return insertGate(source, doc, gateTargetAt(doc, geo, at), drop)
  } catch {
    return null
  }
}

const charOf = (v: QubitValue) => (v === 0 ? '0' : v === 1 ? '1' : '?')
const lineOf = (source: string, at: number) => source.slice(0, at).split('\n').length

/** A state parses as a circuit too (one with an input and nothing done to it). */
function parses(source: string): boolean {
  try {
    parseCircuit(source)
    return true
  } catch {
    return false
  }
}

/** The input state is line 0; its text and where it ends in the source. */
function inputLine(source: string): { text: string; end: number } {
  const nl = source.indexOf('\n')
  return { text: nl === -1 ? source : source.slice(0, nl), end: nl === -1 ? source.length : nl }
}

/** True if splicing would leave an empty superposition term (`||`, leading/trailing `|`). */
function ragged(source: string): boolean {
  const { text } = inputLine(source)
  const body = text.replace(/^(in |out )/, '')
  return /\|\s*\||^\s*\||\|\s*$/.test(body)
}

/**
 * Where, in source offset, a dropped block belongs — from the qubits on screen
 * and the point aimed at, both in the drawing's own coordinates.
 *
 * Everything is on one row, so this is which qubit the pointer sits left of;
 * past the last, it appends. Multiple rows (several input lines) pick the
 * nearest by height first, which this tool never makes but costs nothing.
 */
export function stateInsertAt(spots: QubitSpot[], at: Point): number {
  if (!spots.length) return 0
  const cys = [...new Set(spots.map((s) => Math.round(s.cy)))]
  let cy = cys[0]
  let best = Infinity
  for (const c of cys) {
    const d = Math.abs(at.y - c)
    if (d < best) {
      best = d
      cy = c
    }
  }
  const row = spots.filter((s) => Math.round(s.cy) === cy).sort((a, b) => a.cx - b.cx)
  const k = row.findIndex((s) => at.x < s.cx)
  return k === -1 ? row[row.length - 1].at + 1 : row[k].at
}

/** The offset that appends to the end of the input state (after its last qubit). */
export function appendOffset(spots: QubitSpot[]): number {
  return spots.length ? Math.max(...spots.map((s) => s.at)) + 1 : 0
}

/**
 * Splice a qubit into the state at `at`. `newTerm` writes a `|` before it, which
 * is how a tap on a qubit after arming the separator starts a fresh term.
 */
export function insertQubit(source: string, at: number, value: QubitValue, newTerm = false): Edit | null {
  const ins = (newTerm ? '|' : '') + charOf(value)
  const next = source.slice(0, at) + ins + source.slice(at)
  if (ragged(next) || !parses(next)) return null
  return { source: next, line: lineOf(next, at) }
}

/** Splice a superposition separator at `at`. Refused where it would empty a term. */
export function insertSeparator(source: string, at: number): Edit | null {
  const next = source.slice(0, at) + '|' + source.slice(at)
  if (ragged(next) || !parses(next)) return null
  return { source: next, line: lineOf(next, at) }
}

/**
 * Drop a separator to start a new term. Between two qubits it splits them; where
 * there is nothing to split off (an end, an edge, beside another bar) it brings
 * its own qubit, so `0` → `0|0` and `0|1` → `0|1|0` rather than doing nothing.
 */
export function dropSeparator(source: string, at: number): Edit | null {
  const split = insertSeparator(source, at)
  if (split) return split
  // The empty side gets a fresh 0: a qubit on the right means the left is empty.
  const after = source[at]
  const rightIsQubit = after !== undefined && '01?'.includes(after)
  const ins = rightIsQubit ? '0|' : '|0'
  const next = source.slice(0, at) + ins + source.slice(at)
  if (ragged(next) || !parses(next)) return null
  return { source: next, line: lineOf(next, at) }
}

/** Move a placed qubit to another position, keeping its value. */
export function moveQubit(source: string, from: number, value: QubitValue, to: number): Edit | null {
  if (!'01?'.includes(source[from] ?? '')) return null
  const cut = source.slice(0, from) + source.slice(from + 1)
  const at = to > from ? to - 1 : to // the removal shifts everything after it left
  const next = cut.slice(0, at) + charOf(value) + cut.slice(at)
  if (next === source || ragged(next) || !parses(next)) return null
  return { source: next, line: lineOf(next, at) }
}

/** Remove a placed separator (its `|` character). */
export function removeSeparator(source: string, at: number): Edit | null {
  if (source[at] !== '|') return null
  const cut = source.slice(0, at) + source.slice(at + 1)
  if (ragged(cut) || !parses(cut)) return null
  return { source: cut, line: lineOf(cut, at) }
}

/** Move a placed separator from one gap to another. */
export function moveSeparator(source: string, from: number, to: number): Edit | null {
  if (source[from] !== '|') return null
  const cut = source.slice(0, from) + source.slice(from + 1)
  const at = to > from ? to - 1 : to // the removal shifts everything after it left
  const next = cut.slice(0, at) + '|' + cut.slice(at)
  if (next === source || ragged(next) || !parses(next)) return null
  return { source: next, line: lineOf(next, at) }
}

/**
 * Take one qubit character out of the source and tidy the line it was on: a bar
 * left dangling collapses (`0|1` minus its `1` is `0`), and a line left empty is
 * dropped entirely. Works on whichever row the qubit was in — input, view or
 * output — not just the first line. Reports whether a whole line went, so a
 * following insert can renumber against it.
 */
function cutQubitChar(source: string, at: number): { source: string; removed: number | null } | null {
  if (!'01?'.includes(source[at] ?? '')) return null // a stale offset writes nothing
  const lineNo = source.slice(0, at).split('\n').length
  const s = source.slice(0, at) + source.slice(at + 1)
  const lines = s.split('\n')
  const line = lines[lineNo - 1] ?? ''
  const m = /^(in |out )/.exec(line)
  const head = m ? m[1] : ''
  const body = line.slice(head.length).replace(/\|{2,}/g, '|').replace(/^\|+/, '').replace(/\|+$/, '')
  let removed: number | null = null
  if (body === '') {
    lines.splice(lineNo - 1, 1)
    removed = lineNo
  } else {
    lines[lineNo - 1] = head + body
  }
  return { source: lines.join('\n'), removed }
}

/** Remove one qubit; an emptied state row disappears with it. */
export function removeQubit(source: string, spot: QubitSpot): Edit | null {
  const cut = cutQubitChar(source, spot.at)
  if (!cut || cut.source === source) return null
  if (cut.source.trim() === '') return { source: '', line: 1 }
  if (!parses(cut.source)) return null
  return { source: cut.source, line: 1 }
}

/**
 * Move a picked qubit to wherever it is dropped: along or into another state row
 * it slides across; onto a gate row or a gap it leaves its old row and starts a
 * new state row there — which is how a state moves to the other side of a gate.
 */
export function moveQubitTo(
  source: string,
  doc: CircuitDoc,
  geo: DropGeo,
  spots: QubitSpot[],
  spot: QubitSpot,
  value: QubitValue,
  at: Point,
): Edit | null {
  const rows = buildRows(doc, geo)
  if (!rows.length) return moveQubit(source, spot.at, value, stateInsertAt(spots, at))
  const t = locate(rows, at.y)
  const row = rows[t.i]
  if (row.kind === 'state' && t.zone === 'in') {
    const near = spots.filter((s) => Math.abs(s.cy - row.cy) <= (spots[0]?.size ?? 20))
    return moveQubit(source, spot.at, value, stateInsertAt(near.length ? near : spots, at))
  }
  // Land it as a new state row at the aimed boundary.
  const where: 'before' | 'after' = t.zone === 'in' ? (at.y < row.cy ? 'before' : 'after') : t.zone
  const target = rowLineFor(doc, rows, t.i, where)
  const cut = cutQubitChar(source, spot.at)
  if (!cut) return null
  const lines = cut.source.split('\n')
  let insertAt = target === Infinity ? lines.length + 1 : target
  if (cut.removed !== null && insertAt > cut.removed) insertAt -= 1
  insertAt = Math.max(1, Math.min(insertAt, lines.length + 1))
  lines.splice(insertAt - 1, 0, charOf(value))
  const next = lines.join('\n')
  if (next === source || !parses(next)) return null
  return { source: next, line: insertAt }
}
