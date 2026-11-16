# Terminal review PoC

Status: implemented, separate from the VS Code client. Not a published binary.

## First flow

From the repository root:

```sh
bun install
bun run tui --repo /path/to/repository --base main
```

Duff reuses core's local branch comparison, including its merge-base and immutable-revision validation. It lists committed changes between that merge base and HEAD. It does not fetch or switch branches.

Select a file to open its real workspace buffer in Neovim. Additions have diff highlighting; removed lines are non-editable virtual lines, never inserted into file contents. Decorations recompute after edits. Deleted files open as read-only snapshot buffers. Additions and renames use their current paths and the appropriate base snapshot.

The editor shows live workspace contents against the pinned base, not an immutable HEAD diff. Uncommitted and unsaved edits are deliberately visible. Refresh rereads the committed comparison, clears previous decorations, and opens the selected path if still available. Uncommitted-only paths are not added to the list in this slice.

Opening a file does not mark it viewed. Marking records a content fingerprint. A save with different contents, reopening a changed buffer, or resuming with different disk contents invalidates the mark. Changing the comparison's immutable revisions clears all terminal marks. Fingerprints conservatively invalidate files whose disk encoding differs from Neovim's normalized buffer text.

## Controls

F6 switches between the file list and editor. It is the only globally reserved key. All other editor input, including Tab, Escape, Ctrl-C, motions, search, completion and user mappings, goes to Neovim.

| File list | Action |
| --- | --- |
| `j` / `k`, arrows | Select a file |
| Enter or click | Open selected file and focus the editor |
| `v` | Open selected file and toggle viewed |
| `[` / `]` | Previous / next hunk in the active editor buffer |
| `r` | Refresh the committed comparison |
| `q` | Ask Neovim to quit, with unsaved-buffer confirmation |

Neovim commands: `:DuffFiles`, `:DuffViewed`, `:DuffNextHunk`, `:DuffPreviousHunk`. No default editor mappings are overwritten. Normal `:qa`, `:wqa` and explicit `:qa!` remain available.

## Editor and runtime

Linux and macOS only. Requires Bun 1.3.5+ and Neovim 0.10+. The tested local runtime is Bun 1.3.13 and Neovim 0.12.4. CI provisions Neovim 0.11.5.

Editor selection: `--editor`, `DUFF_NVIM`, `VISUAL`, `EDITOR`, then `nvim` on PATH. The command must launch Neovim and accept `--listen`. Quoted arguments and executable wrapper scripts are supported. Shell operators, shell functions and aliases are not evaluated; point Duff at the underlying executable or a wrapper instead. An arbitrary `$EDITOR` is not an embedded-Neovim substitute.

OpenTUI hosts the real terminal process. A private, temporary RPC socket connects Duff to Neovim for opening buffers, diff decorations and save notifications. Scope cleanup closes the socket, child process and UI. Normal quit waits for Neovim's decision; it does not kill an editor containing unsaved changes.

Neovim owns syntax, plugins, completion, language servers, navigation and undo. Duff does not install project dependencies or configure an LSP. Those require the same setup as opening the repository directly in your editor.

The terminal adapter normalizes OpenTUI parser key codes before native terminal encoding, including Kitty Escape and function keys. Resize updates both PTY dimensions and Neovim dimensions, then requests a full redraw.

## Storage and safety

Terminal progress is separate from extension sessions and databases:

```text
$XDG_STATE_HOME/duff/terminal/<repository-and-base-hash>.json
```

Without an absolute `XDG_STATE_HOME`, use `~/.local/state/duff/terminal`. JSON stores commit IDs, relative paths and viewed fingerprints, never file contents. Writes use a same-directory temporary file and rename. One exclusive `.lock` file prevents concurrent writers for the same repository/base. A crash can leave this lock: after verifying no reviewer is still using that comparison, remove only its `.lock` file to resume. Invalid progress fails visibly rather than being overwritten.

Only regular, existing text files up to 2 MiB whose resolved paths remain inside the repository are opened for editing. Symlinks, special files and NUL-containing files are refused. These checks are not a sandbox against a concurrently hostile filesystem; Neovim and its user plugins have normal editor privileges.

## Verification and limits

Run `bun run check`, `bun run test`, and `bun run build`. `bun run test:terminal` runs Effect-aware tests under Bun, with real temporary Git repositories, real Neovim processes and the native embedded-terminal renderer.

The complete CLI is driven through a PTY: focus switching, custom config mapping, real editing and saving, virtual deletions, viewed-state restart recovery and invalidation, resize, unsaved-buffer quit cancellation, and clean exit. Separate checks cover read-only deleted buffers and symlink/binary refusal.

Not qualified: macOS execution, the owner's full plugin/LSP configuration, Windows, clipboard-provider integration, large-diff responsiveness or concurrent filesystem mutation. Comments, provider PR discovery, split diffs and unchanged-code folding are outside this first flow. Hunk informs the minimal navigation/layout, but its read-only renderer is not used because Neovim owns the code surface.
