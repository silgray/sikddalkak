# sikddalkak

A symbolic calculator notebook. Write formulas, stack them as cells, and let
named variables flow between them.

## Demo

<!-- GIF: type an expression, define a variable, reference it in the next cell -->

<!-- GIF: select part of an expression and apply expand / simplify / factor -->

## Features

- **Visual math input** — powered by [MathLive](https://cortexjs.io/mathlive/),
  so you type and edit formulas the way you'd write them on paper.
- **Cell stack notebook** — cells reference each other by variable name, not
  position. Define `a = 3` in one cell and use `a` in any other, in any order.
- **Selection transforms** — select any part of an expression and apply
  `expand`, `simplify`, or `factor` to just that part.
- **Shape-aware algebra** — every symbol has a shape (scalar, vector, matrix),
  so the engine never applies scalar commutativity where it doesn't hold.
  `ABA` stays `ABA`, it doesn't collapse into `A²B`.

## Getting started

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`.

## Supported notation

### Arithmetic

| Notation | Meaning |
|---|---|
| `+`, `-` | addition, subtraction |
| `\cdot`, `\times`, juxtaposition | multiplication — kept distinct so the engine can tell scalar product, dot product, and cross product apart once it knows the operands' shapes |
| `\frac{p}{q}` | fraction, kept as written (not rewritten as `p \cdot q^{-1}`) |
| `x^n` | power |

### Functions

Built-in scalar functions: `\sin`, `\cos`, `\tan`, `\sin^{-1}`/`\cos^{-1}`/`\tan^{-1}`
(arcsin/arccos/arctan), `\sinh`, `\cosh`, `\tanh`, `\exp`, `\ln`, `\log`, `\sqrt`,
`|x|` (abs), `\det`, `\mathrm{tr}`, `\mathrm{Re}`, `\mathrm{Im}`, conjugate, dagger.

User-defined functions: write `f(x) = x^2`, then call it as `f(3)` or `f(A)`.
Function bodies are shape-polymorphic — `f(A)` squares a scalar if `A` is a
scalar, or computes a matrix power if `A` is a square matrix.

### Matrix notation

| Notation | Meaning |
|---|---|
| `A^T` | transpose |
| `A^*` | complex conjugate, entry by entry |
| `A^\dagger` (also `A^\ast`, `A^\star`) | conjugate transpose |
| `A^{-1}` | inverse |
| `A \cdot B` | dot / matrix product (explicit) |
| `A \times B` | cross product |
| `AB` (juxtaposition) | product — resolved to scalar multiplication or matrix product once the operands' shapes are known |

Conjugate and conjugate-transpose only compute once the cell is evaluated and
the matrix is concrete — on a plain symbol they stay exactly as written.

### Calculus

| Notation | Meaning |
|---|---|
| `\frac{d}{dx}f`, `f'(x)`, `f''(x)` | derivative, including higher orders |
| `\frac{d}{d(x,y,z)}` | multivariable derivative |
| `\frac{d^3}{dx^3}` | higher-order derivative |
| `\sum_{k=lo}^{hi}`, `\prod_{k=lo}^{hi}` | sum / product (bounds optional) |
| `\int_{lo}^{hi} \ldots \, dx` | definite or indefinite integral |

### Cells & variables

Write `a = 3` to define a variable — any other cell can use `a`, regardless of
where it sits in the stack. Cells are organized into groups; groups can be
reordered by drag, and results always follow their definitions, not their
position on screen.

## Selection transforms

Select part of an expression — by dragging, `Shift`+arrows, or `Ctrl`+`D` to
grow the selection by structure — and `expand` / `simplify` / `factor` buttons
appear:

- **expand** — multiplies out products and powers, and computes selected
  matrix products.
- **simplify** — algebraic cleanup: cancellation, trig identities.
- **factor** — pulls out common factors (including non-polynomial ones like
  `\cos x`) and factors polynomials.

Selections can't cut across matrix cells — select the whole matrix instead.
Selecting a whole matrix also shows a floating toolbar for changing its
delimiters.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Confirm the result — stays shown until you edit the group. Focus doesn't move |
| `Ctrl`+`Enter` / `Ctrl`+`Shift`+`Enter` | New empty cell below / above, outside the current group, and focus it |
| `Alt`+`↑`/`↓` | Move this cell's whole group up / down |
| `Shift`+`Alt`+`↑`/`↓` | Duplicate this cell into its own group, placed below / above (cursor stays put) |
| `Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` | Undo / redo — whole keywords (`cos`, `sin`, …) and numbers undo in one step |
| `Shift`+`←`/`→` | Extend selection one item at a time — fractions and matrices select whole |
| `Ctrl`+`D` | Grow selection by structure: innermost group → enclosing element → whole expression |
| `↑`/`↓` | At the edge of a cell, move to the previous / next cell |
| `Backspace` | In an empty cell, deletes it and moves to the end of the cell above |
| `Ctrl`+`Shift`+`E`/`S`/`F` | Apply expand / simplify / factor to the selection |
| `Alt`+`-` | Overline — wraps the selection, or the item before the caret |
| `)` | With no open paren, wraps everything to the left at the same level |
| Drag ⠿ | Reorder whole groups (results follow their definitions, not their position) |

## Development

```bash
npm test              # unit tests (vitest, jsdom)
npm run test:browser  # browser tests (playwright/Chromium, real MathLive)
npm run typecheck     # tsc -b --noEmit
npm run build         # typecheck + vite build
```
