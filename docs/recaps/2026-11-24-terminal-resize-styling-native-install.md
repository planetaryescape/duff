# Session recap: terminal resizing, diff styling, and native installation

Date: 2026-11-23 to 2026-11-24
Workspace: Duff, with installation configuration in the owner's dotfiles

## In brief

Duff was already running the latest source, but its editor could lose synchronization after terminal resizing, and its diff colors overwhelmed added files. We fixed both problems, added a standalone executable build, and installed compiled executables on macOS and NixOS from the same committed source.

## Narrative

The starting screenshot showed a review in Rex with a large green diff background. Checking the running process and GitHub established that the installed source matched the then-current default branch, `31b00bd26ee71380c4d031c2b5854d0ba12d170f`. The editor used Catppuccin Latte with truecolor enabled, so this was not simply a stale installation.

The owner asked for diagnosis before changes and pointed out that Duff should adapt to terminal size changes. The live editor PTY measured 64 columns by 55 rows, while Neovim's attached terminal UI still reported 44 by 20. A regression through the real CLI reproduced this mismatch.

OpenTUI 0.5.6 advertised terminal resize notification mode 2048 but did not emit those notifications when its embedded terminal resized. Neovim consequently ignored normal resize signals. Duff's existing workaround forced Neovim's `columns` and `lines`, leaving its attached UI at the old size.

The fix reports mode 2048 as unsupported to the child editor and lets normal PTY resizing update Neovim. It removes the forced-dimension RPC workaround. Diff styling now uses Duff-specific highlight groups with subtle tints derived from the editor's background, separate gutter signs, and unchanged syntax foregrounds.

The first installation attempt only updated a loose JavaScript bundle on NixOS. The owner rejected this as an improper installation and clarified that a Bun app should ship compiled executables. We added a compile command, tested the compiled client itself, and replaced the launchers on both machines.

## Decisions and lessons

- Diagnose running processes and editor state before blaming an old version or a theme.
- Resize tests must inspect both Neovim's grid and its attached UI, not just the outer renderer's dimensions or visible header.
- The mode-2048 workaround belongs to Duff's shared terminal adapter, not a Nix-only source patch.
- Keep review colors separate from global Neovim diff groups. Refresh Duff's groups after background and colorscheme changes.
- A loose bundle and a shell launcher are not the requested native installation.
- Bun's compile command embeds the runtime and bundled assets. These installations need no separate Bun executable or loose `node_modules` at runtime, but still use Git and Neovim.
- Nix should build from pinned source and hash-verified dependencies, with the final compilation offline. Preserve Bun's appended executable payload by disabling stripping.
- Bun's dependency cache contains absolute self-referencing symlinks. Convert them to relative links before hashing the cache. Use `ln -srfT` so a symlink to a directory is replaced rather than treated as a destination directory.

## Work and references

Paths below are relative to the Duff repository unless stated otherwise.

- Created: `packages/terminal/src/EditorTheme.ts`, theme-relative review highlight definitions.
- Changed: `packages/terminal/src/EditorScript.ts`, review decorations and highlight refresh.
- Changed: `packages/terminal/src/Neovim.ts`, resize-protocol handling and removal of forced editor dimensions.
- Changed: `packages/terminal/src/TerminalReview.test.ts`, rendered color and syntax-foreground assertions.
- Changed: `packages/terminal/src/NavigationFlow.test.ts`, attached-UI dimension checks, colorscheme coverage, and an optional `DUFF_TERMINAL_EXECUTABLE` test entry point.
- Changed: root and terminal `package.json` files, adding `compile:terminal` and `compile`.
- Created outside this repository: `$HOME/dotfiles/nixos/pkgs/duff.nix`, a source-pinned Nix derivation with a fixed-output production dependency cache.
- Changed outside this repository: `$HOME/dotfiles/nixos/home.nix`, declaring the package in `home.packages`.
- Referenced: [terminal client contract](../terminal.md), especially configuration, resizing, and runtime ownership.
- Referenced: [Ratstack behavior testing](https://ratstack.sh/skills/test-behaviour), for proving behavior through real interfaces.

## Commands and verification

- `bun run check`: formatting, typechecking, and lint passed.
- `bun run test`: 333 application tests and 14 terminal tests passed, followed by the anti-slop rule tests.
- `bun run build`: extension and terminal bundle builds passed.
- `bun run compile:terminal`: produced a standalone executable.
- `DUFF_TERMINAL_EXECUTABLE=/absolute/path/to/duff-tui bun run test:terminal --testNamePattern 'uses dotfiles config'`: passed against compiled executables on both Linux and macOS, including the Nix-built Linux executable.
- The resize regression checks terminal sizes 80 by 24, 160 by 45, 60 by 18, and 120 by 30. Expected editor sizes are respectively 44 by 20, 116 by 41, 33 by 14, and 76 by 26.
- The original forced-dimension implementation failed the new attached-UI check. Reporting mode 2048 as unsupported and removing that workaround made the test pass.
- The Nix build fetched pinned source and dependencies, then successfully installed dependencies with `--offline` and compiled inside the sandbox.
- `nix profile add /nix/store/dgqkxs17ma508gdjjqr2xb2hgrisdiq1-duff-0.3.0-unstable-2026-11-24`: installed the Linux package.
- The Linux launcher resolves through `$HOME/.nix-profile/bin/duff-tui` to that Nix store executable. Its ELF header was verified; its recorded store reference is glibc, not Bun or a dependency tree.
- macOS `file` identified `$HOME/.local/bin/duff-tui` as a Mach-O 64-bit arm64 executable. Its linked libraries are system libraries.
- Installed `duff-tui --check-config` succeeded on both machines.

## Commits

- [`e9c9ec8cc3cc6540f296d21f457dd128c4ff34fe`](https://github.com/planetaryescape/duff/commit/e9c9ec8cc3cc6540f296d21f457dd128c4ff34fe): `fix(terminal): compile native client with reliable resize and diff styling`. Committed with repository hooks and pushed to the actual default branch, `main`. Both installations use this source revision.

## Open threads

- Existing reviews were not restarted. Reopen Duff to load the new executable.
- The NixOS installation is active through the user Nix profile. No system-wide NixOS rebuild ran, because unattended sudo was unavailable.
- The Nix package declaration and Home Manager change remained uncommitted in the owner's private dotfiles repository. They are not part of the Duff commit above.
- The integration tests use temporary repositories and isolated Neovim configuration. They do not qualify the owner's full plugin/LSP configuration.
- This session installed local executables. It did not add release automation, publish binary release assets, or configure automatic upgrades.
- Older loose bundles and launcher backups were retained, but the current launchers no longer target them.
