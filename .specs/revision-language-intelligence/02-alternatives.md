# Alternatives and decisions

| Decision | Chosen | Rejected for this slice |
| --- | --- | --- |
| Analysis engine | A pinned trusted TypeScript language server and TypeScript toolchain | Current editor's LSP: wrong revision and editor coupling. Direct TypeScript compiler embedding: possible, but adds a custom language-service host rather than exercising the intended server boundary. |
| Source context | Dedicated immutable-commit source trees, bounded and checked against Git objects | Retained checkout: deliberately editable. Changed-files-only project: breaks imports and unchanged definitions. Full virtual filesystem: larger server integration and compatibility burden. |
| Dependencies | No automatic PR installs; clearly limited results when exact declarations are unavailable | Sharing current `node_modules` silently across base/head: misleading types. Running lockfile installs/hooks automatically: unapproved code/network execution. |
| Native position mapping | Minimal Rune patch using its existing shaped-text hit testing and inverse display mapping | Fixed-width arithmetic or parsing internal element keys: wrong under Unicode, wrapping, tabs and scrolling. Replacing/vendoring the whole renderer: excessive ownership. |
| Runtime | Existing Node/Effect bridge with independent read-only query ownership | Additional unmanaged sidecar or Rust Git/provider rewrite: duplicates existing ownership and capabilities. |
| UX | Bounded native hover and read-only definition peek | Editor tab takeover, editable snippets and executing server commands: outside a review tool's first slice. |

The Rune patch is a maintenance cost. Keep it small, pinned, tested and isolated in a patch file so it can be removed if upstream gains equivalent hooks. Do not publish an upstream fork or modify another repository without separate authorisation.
