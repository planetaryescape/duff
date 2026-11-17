# Terminal review PoC

Status: implemented, separate from the VS Code client. Not a published binary.

## First flow

From the repository root:

```sh
bun install
bun run tui --repo /path/to/repository --base main
```

Duff reuses core's local branch comparison, including its merge-base and immutable-revision validation. It lists committed changes between that merge base and HEAD. It does not fetch or switch branches.

Select a file to open its real workspace buffer in Neovim at its first diff. Reopening returns to that first diff rather than the previous cursor position. Additions have diff highlighting; removed lines are non-editable virtual lines, never inserted into file contents. Decorations recompute after edits. Deleted files open as read-only snapshot buffers. Additions and renames use their current paths and the appropriate base snapshot.

The editor shows live workspace contents against the pinned base, not an immutable HEAD diff. Uncommitted and unsaved edits are deliberately visible. Refresh rereads the committed comparison, clears previous decorations, and opens the selected path if still available. Uncommitted-only paths are not added to the list in this slice.

Opening a file does not mark it viewed. Marking records a content fingerprint. A save with different contents, reopening a changed buffer, or resuming with different disk contents invalidates the mark. Changing the comparison's immutable revisions clears all terminal marks. Fingerprints conservatively invalidate files whose disk encoding differs from Neovim's normalized buffer text.

## Controls

By default, F6 switches between the sidebar and editor, and F7/F8 move to the previous/next review hunk. At a buffer's last hunk, next opens the next changed file at its first diff; previous crosses to the preceding file's last hunk. Navigation stops at the review boundaries. These three keys are configurable and globally reserved. Other editor input, including Tab, Escape, Ctrl-C, motions, search, completion and user mappings, goes to Neovim.

| Sidebar | Action |
| --- | --- |
| `j` / `k`, up/down | Select a visible row |
| `h` / left | Fold a directory or select the parent |
| `l` / right | Expand a directory, enter it, or open a file |
| Home / `g`, End / `G` | Select the first / last visible row |
| Enter or click | Toggle a directory, or open a file at its first diff and focus the editor |
| Tab | Focus the editor |
| `t` | Switch list/tree for this session |
| `u` | Select the next unviewed file, wrapping at the end |
| `v` | Open selected file and toggle viewed |
| `[` / `]` | Previous / next review hunk, including across files |
| `r` | Refresh the committed comparison |
| `q` | Ask Neovim to quit, with unsaved-buffer confirmation |

Neovim commands: `:DuffFiles`, `:DuffViewed`, `:DuffNextHunk`, `:DuffPreviousHunk`, `:DuffToggleView`. Changing buffers through Neovim updates the active path and sidebar selection for reviewed files. No user mappings are rewritten. Normal `:qa`, `:wqa` and explicit `:qa!` remain available.

## Configuration

Duff reads `$XDG_CONFIG_HOME/duff/config.json` when `XDG_CONFIG_HOME` is absolute, otherwise `~/.config/duff/config.json`. `--config /path/to/config.json` overrides that path. Validate without starting Neovim:

```sh
bun run tui --check-config
bun run tui --config /path/to/config.json --check-config
```

Defaults, also available in [config.example.json](../packages/terminal/config.example.json):

```json
{
  "fileView": "tree",
  "sidebarWidth": 40,
  "keys": {
    "focus": "f6",
    "previousHunk": "f7",
    "nextHunk": "f8"
  }
}
```

Effect Schema validates JSON before starting the UI. Omitted fields receive defaults. `fileView` accepts `list` or `tree`; `sidebarWidth` accepts integers from 24 through 80, capped on narrow terminals; global keys must be distinct lowercase `f1` through `f12`. Unknown fields, invalid values, malformed JSON and unreadable files fail visibly. Only an absent default file falls back to all defaults; an absent explicit `--config` file is an error.

List mode prioritizes filenames and dims their parent paths. Tree mode groups real directories with folding. Switching views preserves file identity and does not rewrite configuration.

On the owner's Mac and desktop, the source is `~/dotfiles/duff/.config/duff/config.json`, linked from `~/.config/duff`. Both use tree mode, width 44 and F6/F7/F8. GNU Stow can create this link with `stow --dir="$HOME/dotfiles" --target="$HOME" duff`.

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

The complete CLI is driven through a PTY: focus switching, custom config mapping, readable deep filenames, list/tree switching and folding, first-diff reopening, cross-file hunk movement, Neovim buffer synchronization, real editing and saving, virtual deletions, viewed-state restart recovery and invalidation, resize, unsaved-buffer quit cancellation, and clean exit. Separate checks cover configuration defaults/rejection, read-only deleted buffers and symlink/binary refusal.

The 13 terminal tests passed on Linux and in an isolated macOS preview using Bun 1.4.4 and Neovim 0.12.5. Tests use temporary repositories and isolated Neovim configuration, not the owner's full plugins. Set `DUFF_TERMINAL_EVIDENCE_DIR=/absolute/output/path` during the navigation regression to save native rendered frames as JSON and text. These frames use synthetic source, not private project files.

Not qualified: the owner's full plugin/LSP configuration for this iteration, Windows, clipboard-provider integration, large-diff responsiveness or concurrent filesystem mutation. Comments, provider PR discovery, split diffs and unchanged-code folding are outside this first flow. Hunk informs the minimal navigation/layout, but its read-only renderer is not used because Neovim owns the code surface.
