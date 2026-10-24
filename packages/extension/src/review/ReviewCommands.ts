import {
  PullRequestReview,
  type PreparationState,
  type PreparedReview,
} from '@duff/core/pull-request-review'
import { BranchReview, type Review, ReviewError, Snapshot } from '@duff/core/review'
import { fileSnapshots, ReviewProgress, ViewedFiles } from '@duff/core/review-progress'
import { ReviewSessions } from '@duff/core/saved-review-sessions'
import { Effect, Match, Option, Schema } from 'effect'
import * as vscode from 'vscode'

import { type CommandRuntime, reviewStorageMessage, runOperation } from '../Operations'
import { registerPullRequestReviewCommands } from '../pull-requests/PullRequestReviewCommands'
import { providerError } from '../pull-requests/PullRequestView'
import { chooseDirectory } from '../Repository'
import { observeOperation } from '../telemetry/Telemetry'
import { ReviewFile, ReviewFolder, ReviewView, snapshotUri } from './ReviewView'
import { registerSnapshotNavigation } from './SnapshotNavigation'

class BranchChoice implements vscode.QuickPickItem {
  readonly label: string
  readonly description: string

  constructor(readonly ref: string) {
    this.label = ref.replace(/^refs\/(heads|remotes)\//, '')
    this.description = ref.startsWith('refs/remotes/') ? 'remote-tracking' : 'local'
  }
}

class ReviewCommands {
  constructor(readonly currentRoot: () => string | undefined) {}
}

export function registerReviewCommands(
  context: vscode.ExtensionContext,
  runtime: CommandRuntime,
  onReview: (root: string) => void,
) {
  const savedLayout = context.workspaceState.get<unknown>('reviewLayout')
  const provider = new ReviewView(savedLayout === 'tree' ? 'tree' : 'list')

  const view = vscode.window.createTreeView('duff.files', {
    treeDataProvider: provider,
    manageCheckboxStateManually: true,
  })

  let review: Review | undefined
  let progress: ReviewProgress | undefined
  let localReview: Review | undefined
  let prepared: PreparedReview | undefined
  let preparation: PreparationState | undefined
  let localGeneration = 0

  const activeFile = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input

    if (
      !(input instanceof vscode.TabInputTextDiff) ||
      input.original.scheme !== 'duff-snapshot' ||
      input.modified.scheme !== 'duff-snapshot'
    )
      return
    const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Snapshot))
    const original = decode(input.original.query)
    const modified = decode(input.modified.query)

    if (Option.isNone(original) || Option.isNone(modified)) return

    return progress?.activeFile(original.value, modified.value)
  }

  const openDiff = async (item: ReviewFile, preserveFocus: boolean) => {
    const { review: current, change } = item
    const [base, head] = fileSnapshots(current, change)
    await vscode.commands.executeCommand(
      'vscode.diff',
      snapshotUri(base),
      snapshotUri(head),
      `${change.path}: ${current.baseCommit.slice(0, 8)} ↔ ${current.headCommit.slice(0, 8)}`,
      { preview: false, preserveFocus },
    )
  }

  // The native diff editor moves its modified-side cursor between changes, whichever side has focus.
  // Diff sides have no view column; duplicate snapshot URIs need the active editor, not the first match.
  const modifiedEditor = async () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab
    const input = tab?.input

    if (!(input instanceof vscode.TabInputTextDiff)) return
    const active = vscode.window.activeTextEditor

    const matches = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document.uri.toString() === input.modified.toString(),
    )

    const visibleCopies = vscode.window.tabGroups.all.filter((group) => {
      const visible = group.activeTab?.input

      return (
        visible instanceof vscode.TabInputTextDiff &&
        visible.modified.toString() === input.modified.toString()
      )
    }).length

    // Splitting activates the new tab before its editor exists. Do not navigate the old copy meanwhile.
    if (matches.length < visibleCopies) return

    if (matches.length < 2) return matches[0]

    await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide')

    if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) return
    const modified = vscode.window.activeTextEditor

    if (active?.document.uri.toString() === input.original.toString())
      await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide')

    if (
      vscode.window.tabGroups.activeTabGroup.activeTab === tab &&
      modified &&
      matches.includes(modified)
    )
      return modified
  }

  let navigating = false

  const unconfirmedNavigation = () =>
    vscode.window.setStatusBarMessage(
      'Duff: No native cursor movement. Select an adjacent file in Changed Files.',
      7000,
    )

  const goToChange = async (direction: 'next' | 'previous') => {
    const file = activeFile()
    const current = review
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab

    if (navigating || !file || !current || !tab) return
    navigating = true

    try {
      const editor = await modifiedEditor()

      if (!editor || review !== current || vscode.window.tabGroups.activeTabGroup.activeTab !== tab)
        return
      const before = editor.selection
      await vscode.commands.executeCommand(`workbench.action.compareEditor.${direction}Change`)

      if (review !== current || vscode.window.tabGroups.activeTabGroup.activeTab !== tab) return
      const line = editor.selection.active.line

      // An unchanged line can mean a single hunk, no hunks, or a timed-out native diff.
      // Only movement in the opposite direction establishes a wrap into the adjacent file.
      if (line === before.active.line) {
        unconfirmedNavigation()

        return
      }

      if (direction === 'next' ? line > before.active.line : line < before.active.line) return
      const files = provider.files()
      const index = files.findIndex((item) => item.change.path === file.path)

      if (index < 0) return
      const target = files[direction === 'next' ? index + 1 : index - 1]

      if (!target) {
        editor.selection = before
        editor.revealRange(before, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        vscode.window.setStatusBarMessage(
          `Duff: ${direction === 'next' ? 'Last' : 'First'} change in this review`,
          3000,
        )

        return
      }

      await openDiff(target, false)

      if (review !== current || activeFile()?.path !== target.change.path) return
      const openedTab = vscode.window.tabGroups.activeTabGroup.activeTab

      if (view.visible) await view.reveal(target, { select: true, focus: false })

      if (review !== current || vscode.window.tabGroups.activeTabGroup.activeTab !== openedTab)
        return
      const opened = await modifiedEditor()

      if (
        !opened ||
        review !== current ||
        vscode.window.tabGroups.activeTabGroup.activeTab !== openedTab
      )
        return

      // Ask native navigation for the first/last change; unavailable mappings may leave it here.
      const position =
        direction === 'next'
          ? opened.document.lineAt(opened.document.lineCount - 1).range.end
          : new vscode.Position(0, 0)

      opened.selection = new vscode.Selection(position, position)
      await vscode.commands.executeCommand(`workbench.action.compareEditor.${direction}Change`)

      if (
        review === current &&
        vscode.window.tabGroups.activeTabGroup.activeTab === openedTab &&
        opened.selection.active.line === position.line
      )
        unconfirmedNavigation()
    } finally {
      navigating = false
    }
  }

  // Review position while a Duff diff is active. Navigation has no default keys, so the hover links to them.
  const hint = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  hint.command = 'duff.nextChange'
  const shortcuts = encodeURIComponent(JSON.stringify(['Change in Review']))

  const hintTooltip = (position: string) => {
    const tooltip = new vscode.MarkdownString(
      `Duff review · ${position}\n\n[$(arrow-circle-up) Previous change](command:duff.previousChange) · [$(arrow-circle-down) Next change](command:duff.nextChange)\n\nContinues into the adjacent file when native navigation wraps. If the cursor does not move, select an adjacent file in Changed Files, including for single-hunk files. [$(keyboard) Set keyboard shortcuts…](command:workbench.action.openGlobalKeybindings?${shortcuts})`,
      true,
    )

    tooltip.isTrusted = {
      enabledCommands: [
        'duff.previousChange',
        'duff.nextChange',
        'workbench.action.openGlobalKeybindings',
      ],
    }

    return tooltip
  }

  const updateActive = async () => {
    const file = activeFile()
    const state = file ? (progress?.isViewed(file.path) ? 'viewed' : 'unviewed') : undefined
    const files = provider.files()
    const index = files.findIndex((item) => item.change.path === file?.path)

    if (index === -1) hint.hide()
    else {
      hint.text = `$(arrow-circle-down) File ${index + 1}/${files.length}`
      hint.tooltip = hintTooltip(`file ${index + 1} of ${files.length}`)
      hint.show()
    }

    await vscode.commands.executeCommand('setContext', 'duff.activeFileState', state)

    if (file && prepared) {
      const current = prepared
      await runOperation(
        runtime,
        'Duff.preparePullRequest',
        ReviewSessions.use((service) =>
          service.opened(current.saved.key, current.review, file.path),
        ),
      )
    }
  }

  const renderProgress = () => {
    if (!progress) return
    const current = progress.review
    const paths = progress.saved().paths
    provider.setReview(current, paths)

    const summary =
      current.files.length === 0
        ? 'No committed changes since the common ancestor. Working-tree edits are excluded.'
        : `${paths.length}/${current.files.length} viewed · committed changes only`

    if (!preparation || preparation.activity._tag === 'Idle')
      view.message = prepared
        ? `${prepared.resolved.pullRequest.source._tag === 'Available' ? prepared.resolved.pullRequest.source.ref.name.replace('refs/heads/', '') : 'Unavailable'} → ${prepared.resolved.pullRequest.target.ref.name.replace('refs/heads/', '')} · ${summary}`
        : summary
  }

  const showReview = async (next: Review) => {
    if (!prepared) onReview(next.root)
    review = next

    const saved = Schema.decodeUnknownOption(ViewedFiles)(
      context.workspaceState.get<unknown>('viewedFiles'),
    )

    progress = new ReviewProgress(
      next,
      prepared
        ? ViewedFiles.make({
            root: next.root,
            baseCommit: next.baseCommit,
            headCommit: next.headCommit,
            paths: prepared.saved.viewed,
          })
        : (progress?.saved() ?? Option.getOrUndefined(saved)),
    )
    renderProgress()
    const base = next.baseBranch.replace(/^refs\/(heads|remotes)\//, '')
    const head = next.headBranch.replace(/^refs\/(heads|remotes)\//, '')
    view.description = prepared ? `${head} → ${base}` : `${base} → ${head}`
    view.title = prepared
      ? `PR #${prepared.resolved.pullRequest.id}: ${prepared.resolved.pullRequest.title}`
      : 'Changed Files'

    if (!prepared) await context.workspaceState.update('viewedFiles', progress.saved())
    await updateActive()
  }

  const mark = async (item: unknown, viewed: boolean) => {
    if (!progress) return

    const path =
      item instanceof ReviewFolder
        ? item.path
        : item instanceof ReviewFile
          ? item.change.path
          : activeFile()?.path

    const target = item instanceof ReviewFile || item instanceof ReviewFolder ? item.review : review

    if (!target || !path) return

    if (prepared) {
      const paths =
        item instanceof ReviewFolder
          ? target.files.filter((file) => file.path.startsWith(`${path}/`)).map((file) => file.path)
          : [path]

      await runOperation(
        runtime,
        'Duff.preparePullRequest',
        PullRequestReview.use((service) => service.mark(target, paths, viewed)),
        renderProgress,
      )

      return
    }

    const changed =
      item instanceof ReviewFolder
        ? progress.setFolderViewed(target, path, viewed)
        : progress.setViewed(target, path, viewed)

    if (!changed) return
    renderProgress()
    await context.workspaceState.update('viewedFiles', progress.saved())
    await updateActive()
  }

  const compare = async () => {
    const generation = ++localGeneration
    await runtime.runPromise(PullRequestReview.use((service) => service.cancel()))
    const before = await runtime.runPromise(PullRequestReview.use((service) => service.current()))
    const directory = await chooseDirectory()

    if (!directory) return

    const repository = await runOperation(
      runtime,
      'Duff.listBranches',
      BranchReview.use((service) => service.branches(directory)),
    )

    if (!repository) return

    if (repository.branches.length === 0) {
      await vscode.window.showInformationMessage(
        'Duff: No other local or remote-tracking branches are available. Fetch or create a branch, then try again.',
      )

      return
    }

    const selected = await vscode.window.showQuickPick(
      repository.branches.map((ref) => new BranchChoice(ref)),
      {
        title: `Compare ${repository.current} Against Branch`,
        placeHolder: 'Choose the base branch (changes since the common ancestor)',
      },
    )

    if (!selected) return

    const next = await runOperation(
      runtime,
      'Duff.compare',
      BranchReview.use((service) => service.compare(repository.root, selected.ref)),
    )

    if (!next || generation !== localGeneration) return
    const current = await runtime.runPromise(PullRequestReview.use((service) => service.current()))

    if (current !== before) return

    const left = await runOperation(
      runtime,
      'Duff.preparePullRequest',
      PullRequestReview.use((service) => service.exit().pipe(Effect.as(true))),
    )

    if (!left) return
    prepared = undefined
    localReview = next
    await showReview(next)
    await vscode.commands.executeCommand('duff.files.focus')
  }

  const renderPreparation = async (state: PreparationState) => {
    preparation = state
    const accepted = Option.getOrUndefined(state.accepted)

    if (accepted !== prepared) {
      const previous = prepared
      prepared = accepted

      if (accepted) {
        await showReview(accepted.review)

        if (accepted.review !== previous?.review) {
          await vscode.commands.executeCommand('duff.files.focus')
          const path = Option.getOrUndefined(accepted.saved.lastFile)
          const change = accepted.review.files.find((file) => file.path === path)

          if (change) {
            const [base, head] = fileSnapshots(accepted.review, change)
            await vscode.commands.executeCommand(
              'vscode.diff',
              snapshotUri(base),
              snapshotUri(head),
              `${change.path}: ${accepted.review.baseCommit.slice(0, 8)} ↔ ${accepted.review.headCommit.slice(0, 8)}`,
              { preview: false, preserveFocus: true },
            )
          }
        }
      } else if (previous) {
        if (localReview && localReview.root === Option.getOrUndefined(state.root))
          await showReview(localReview)
        else {
          review = undefined
          progress = undefined
          provider.clear()
          view.title = 'Changed Files'
          view.description = undefined
          view.message = undefined
          await updateActive()
        }
      }
    }

    if (state.activity._tag === 'Preparing')
      view.message = `Preparing ${state.activity.selection.label}…${review ? ' Existing review remains available.' : ''} Cancel Preparation to stop.`
    else if (state.activity._tag === 'AwaitingFetch')
      view.message = `PR #${state.activity.selection.id}: ${state.activity.resolved.pullRequest.title} · Missing commits. Use Fetch PR Revisions… to consent, or Cancel Preparation.${review ? ' Existing review is unchanged.' : ''}`
    else if (state.activity._tag === 'Failed')
      view.message = Match.value(state.activity.error).pipe(
        Match.tag('ReviewError', (error) => error.message),
        Match.tag('ReviewStorageError', reviewStorageMessage),
        Match.orElse(providerError),
      )
    else if (progress) renderProgress()
    else view.message = undefined
  }

  registerPullRequestReviewCommands(context, runtime, renderPreparation)
  registerSnapshotNavigation(context)

  context.subscriptions.push(
    hint,
    provider,
    view,
    view.onDidChangeCheckboxState((event) =>
      runtime.runFork(
        Effect.forEach(event.items, ([item, state]) =>
          Effect.promise(() => mark(item, state === vscode.TreeItemCheckboxState.Checked)),
        ),
      ),
    ),
    vscode.window.tabGroups.onDidChangeTabs(() => runtime.runFork(Effect.promise(updateActive))),
    vscode.window.tabGroups.onDidChangeTabGroups(() =>
      runtime.runFork(Effect.promise(updateActive)),
    ),
    vscode.window.onDidChangeActiveTextEditor(() => runtime.runFork(Effect.promise(updateActive))),
    vscode.commands.registerCommand('duff.markViewed', (item: unknown) => mark(item, true)),
    vscode.commands.registerCommand('duff.markUnviewed', (item: unknown) => mark(item, false)),
    vscode.commands.registerCommand('duff.openSelectedFile', () => {
      const selected = view.selection[0]

      if (selected instanceof ReviewFile)
        return vscode.commands.executeCommand('duff.openFile', selected)
    }),
    vscode.commands.registerCommand('duff.compare', compare),
    vscode.commands.registerCommand('duff.toggleLayout', async () => {
      await context.workspaceState.update('reviewLayout', provider.toggleLayout())
      await updateActive()
    }),
    vscode.commands.registerCommand('duff.refresh', async () => {
      if (prepared) return vscode.commands.executeCommand('duff.refreshPullRequestReview')

      if (!review) return compare()
      const current = review
      const generation = ++localGeneration
      const before = await runtime.runPromise(PullRequestReview.use((service) => service.current()))

      const next = await runOperation(
        runtime,
        'Duff.refresh',
        BranchReview.use((service) => service.compare(current.root, current.baseBranch)),
      )

      const after = await runtime.runPromise(PullRequestReview.use((service) => service.current()))

      if (next && review === current && generation === localGeneration && before === after) {
        localReview = next
        await showReview(next)
      }
    }),
    vscode.commands.registerCommand('duff.openDiff', async (item: unknown) => {
      if (item instanceof ReviewFile) await openDiff(item, true)
    }),
    vscode.commands.registerCommand('duff.nextChange', () => goToChange('next')),
    vscode.commands.registerCommand('duff.previousChange', () => goToChange('previous')),
    vscode.commands.registerCommand('duff.openFile', async (item: unknown) => {
      try {
        let root: string
        let path: string

        if (item instanceof ReviewFile) {
          if (item.change.status === 'D') return
          root = item.review.root
          path = item.change.path
        } else {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input

          const uri =
            input instanceof vscode.TabInputTextDiff
              ? input.modified
              : vscode.window.activeTextEditor?.document.uri

          if (uri?.scheme !== 'duff-snapshot') return
          const value: unknown = JSON.parse(uri.query)
          const snapshot = Schema.decodeUnknownSync(Snapshot)(value)

          if (snapshot.path === undefined) {
            await vscode.window.showInformationMessage(
              'Duff: This file was deleted in the reviewed revision and has no current-side file to open.',
            )

            return
          }

          root = snapshot.root
          path = snapshot.path
        }

        await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(root), path), {
          preview: false,
        })
      } catch {
        await vscode.window.showErrorMessage(
          'Duff: This file is not available in the current working tree. Its committed version is still available in the diff.',
        )
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider('duff-snapshot', {
      provideTextDocumentContent: async (uri, token) => {
        const abort = new AbortController()
        const listener = token.onCancellationRequested(() => abort.abort())

        if (token.isCancellationRequested) abort.abort()

        try {
          const input = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot))(uri.query).pipe(
            Effect.mapError(
              () =>
                new ReviewError({ operation: 'read snapshot', message: 'Invalid snapshot URI.' }),
            ),
            Effect.flatMap((snapshot) => BranchReview.use((service) => service.read(snapshot))),
          )

          return await runtime.runPromise(observeOperation('Duff.readSnapshot', input), {
            signal: abort.signal,
          })
        } finally {
          listener.dispose()
        }
      },
    }),
  )

  return new ReviewCommands(() => review?.root)
}
