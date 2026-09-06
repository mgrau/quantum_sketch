# Quantum Sketch

A simple, forgiving way for students to *draw* quantum states and circuits in the
visual language of Terry Rudolph's *Q is for Quantum* — drag qubits and gates
onto graph paper, on a laptop or a phone, and get a picture out.

**Live:** https://mgrau.github.io/quantum_sketch/

## What it does

- Drag **qubits** (○ 0, ● 1, ? unknown) and the **| separator** to build states —
  registers and superpositions.
- Drag **gates** (H, NOT, Z, S, T, CNOT, CCNOT, CZ, SWAP, Fredkin) onto wires to
  make a circuit. Drop qubits between or below the gates to draw the state at any
  point.
- Click a qubit to flip it; click a controlled gate to cycle its control ports.
- Drag a block away to delete it.
- **Copy PNG** or drag the figure out — the notation travels inside the image, so
  a saved picture can be traced back to the sketch that made it.

Deliberately less than the full editor: no animation, no simulation, no themes —
just drawing.

## Development

```bash
npm install
npm run dev      # http://localhost:5199
npm run build    # static site in dist/
```

The drawing itself is done by [misty_states](https://github.com/mgrau/misty_states)
(`../misty_states`), aliased at build time; check both out as siblings.

TypeScript + Vite. Deploys to GitHub Pages via `.github/workflows/deploy.yml`.
