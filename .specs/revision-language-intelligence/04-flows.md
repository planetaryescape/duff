# Flows and failure ownership

## Enable

Disabled → explicit trust action → prepare two revision contexts → start trusted server(s) → ready or limited. Any failure cleans partial contexts/processes and returns unavailable. Re-enabling must not duplicate processes. Review replacement invalidates trust and pending results for the old session. Trust does not authorise dependency installation, plugins, builds or network bootstrap.

## Hover

Native pointer event → shaped-text source position → debounce/dedupe → UTF-16 query → matching base/head context → decoded bounded hover → current-generation check → native hover card. Pointer movement, file/side/revision change or dismissal supersedes it. The pointer can enter the card without immediately losing it. Escape dismisses and restores keyboard use of the review.

## Definition

Actual Cmd-click position or F12's current code position → correlated query → decode/authorise target URI → read pinned target source or explicitly trusted declaration → bounded excerpt → zero-result message, one peek or target picker. Display side/revision and target path. Escape/Back closes the peek without changing the active diff's scroll, selection, viewed marks or last changed file.

## Failure and interruption

- Unsupported language/content, missing side, no definition and missing declarations are honest UI states, not synthetic results.
- Reject malformed response frames, unsupported URI schemes, out-of-root canonical paths, symlink escapes and oversized content before reading/displaying it.
- Late responses cannot update dismissed cards, a different file or a new review, even if server cancellation arrives too late.
- A crashed server reports a finite failure and offers explicit retry; do not silently spin/restart forever.
- Closing the native app sends the existing independent shutdown control. Abort all language work, dispose its Effect scope and reap owned server/child processes, then close Node. Test the actual native close path, not only an idle bridge signal.
- No new exporter. Any local outcome instrumentation must omit content, URLs, identity, paths, argv and raw exception text.
