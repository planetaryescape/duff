# Contracts

These are wire-level design sketches. The implementation's Schema and Rust enums are the source of truth; update this file if inspection requires a change.

```ts
type Side = 'old' | 'new'
type Point = { readonly line: number; readonly character: number }
type SymbolQuery = Point & {
  readonly id: number
  readonly op: 'hover' | 'definition'
  readonly session: string
  readonly path: string
  readonly side: Side
}
type Enable = { readonly id: number; readonly op: 'language-enable'; readonly session: string }
type LanguageState = {
  readonly kind: 'language'
  readonly session: string
  readonly state: 'ready' | 'limited' | 'unavailable'
  readonly message: string
}
type Hover = Point & {
  readonly kind: 'hover'
  readonly session: string
  readonly path: string
  readonly side: Side
  readonly content: string
  readonly message: string
}
type DefinitionTarget = Point & {
  readonly path: string
  readonly commit: string
  readonly startLine: number
  readonly text: string
}
type Definition = {
  readonly kind: 'definition'
  readonly session: string
  readonly path: string
  readonly side: Side
  readonly targets: ReadonlyArray<DefinitionTarget>
  readonly message: string
}
```

Positions use zero-based UTF-16 units; all integers are nonnegative and bounded. Session identifiers and Git paths reuse existing decoders. Requests identify a saved review, never an arbitrary repository root or server executable. Resolve old paths through saved comparisons. A nonexistent side or unsupported file fails explicitly.

Every response retains the request ID. Rust owns the expected generation, review/file/side and query kind; mismatches cannot update the UI. Empty hover or zero definition targets is a valid no-result outcome, distinct from startup/protocol failure. Define a bounded cancellation control for superseded query ownership; it must not cancel durable progress writes.

```rust
// Rune extension proposal: source lines are 1-based here, byte column is UTF-8.
pub struct SymbolPosition {
    pub file: usize,
    pub side: Side,
    pub line: u32,
    pub byte: usize,
    pub window_x: f32,
    pub window_y: f32,
}
```

Rune produces positions from actual event geometry and original source text. Rust converts to the wire position only at the native boundary. Keep read-only peek state separate from the active diff, including its return scroll/selection; no storage schema migration is needed.

## Bounds and failure vocabulary

Keep existing 1-MiB review-file and 16-MiB native response-frame ceilings. Definition output contains at most eight targets, with bounded excerpts rather than arbitrary filesystem reads. Language startup, queries, source tree size/count, hover content, outstanding queries and server memory all need explicit implementation limits and tests. No uncapped stdout/stderr buffering or indefinite query retry. Missing dependency context yields limited state; corrupt/unsupported contexts do not become ready. Expected failures expose finite public diagnostics, not raw server stderr or exception text.

Revision export checks at most 4,096 tree entries and selects TS/JS-family plus JSON/JSONC inputs, excluding vendored `.yarn` directories and unrelated assets before reads/byte accounting. Selected inputs remain bounded to 1 MiB per blob and 16 MiB total; unsafe modes/paths and case/normalization aliases fail closed. This selects analysis inputs, not a complete checkout or dependency installation. Non-JSON referenced configs are rejected instead of retaining unprojected executable plugin settings.
