import { BranchReview, type Review, ReviewError, Snapshot } from '@duff/core/review'
import { fileSnapshots, ReviewProgress, ViewedFiles } from '@duff/core/review-progress'
import { Effect, Option, Schema } from 'effect'
import * as vscode from 'vscode'

import { type CommandRuntime, runOperation } from '../Operations'
import { chooseDirectory } from '../Repository'
import { observeOperation } from '../telemetry/Telemetry'
import { ReviewFile, ReviewView, snapshotUri } from './ReviewView'

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
  const view = vscode.window.createTreeView('duff.files', { treeDataProvider: provider })
  let review: Review | undefined
  let progress: ReviewProgress | undefined

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

  const updateActive = async () => {
    const file = activeFile()
    const state = file ? (progress?.isViewed(file.path) ? 'viewed' : 'unviewed') : undefined
    await vscode.commands.executeCommand('setContext', 'duff.activeFileState', state)
  }

  const renderProgress = () => {
    if (!progress) return
    const current = progress.review
    const paths = progress.saved().paths
    provider.setReview(current, paths)
    view.message =
      current.files.length === 0
        ? 'No committed changes since the common ancestor. Working-tree edits are excluded.'
        : `${paths.length}/${current.files.length} viewed · committed changes only`
  }

  const showReview = async (next: Review) => {
    onReview(next.root)
    review = next

    const saved = Schema.decodeUnknownOption(ViewedFiles)(
      context.workspaceState.get<unknown>('viewedFiles'),
    )

    progress = new ReviewProgress(next, progress?.saved() ?? Option.getOrUndefined(saved))
    renderProgress()
    const base = next.baseBranch.replace(/^refs\/(heads|remotes)\//, '')
    view.description = `${base} → ${next.headBranch}`
    view.title = 'Changed Files'
    await context.workspaceState.update('viewedFiles', progress.saved())
    await updateActive()
  }

  const mark = async (item: unknown, viewed: boolean) => {
    if (!progress) return
    const path = item instanceof ReviewFile ? item.change.path : activeFile()?.path
    const target = item instanceof ReviewFile ? item.review : review

    if (!target || !path || !progress.setViewed(target, path, viewed)) return
    renderProgress()
    await context.workspaceState.update('viewedFiles', progress.saved())
    await updateActive()
  }

  const compare = async () => {
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

    if (!next) return
    await showReview(next)
    await vscode.commands.executeCommand('duff.files.focus')
  }

  context.subscriptions.push(
    provider,
    view,
    vscode.window.tabGroups.onDidChangeTabs(() => runtime.runFork(Effect.promise(updateActive))),
    vscode.window.tabGroups.onDidChangeTabGroups(() =>
      runtime.runFork(Effect.promise(updateActive)),
    ),
    vscode.window.onDidChangeActiveTextEditor(() => runtime.runFork(Effect.promise(updateActive))),
    vscode.commands.registerCommand('duff.markViewed', (item: unknown) => mark(item, true)),
    vscode.commands.registerCommand('duff.markUnviewed', (item: unknown) => mark(item, false)),
    vscode.commands.registerCommand('duff.compare', compare),
    vscode.commands.registerCommand('duff.toggleLayout', async () => {
      await context.workspaceState.update('reviewLayout', provider.toggleLayout())
    }),
    vscode.commands.registerCommand('duff.refresh', async () => {
      if (!review) return compare()
      const current = review

      const next = await runOperation(
        runtime,
        'Duff.refresh',
        BranchReview.use((service) => service.compare(current.root, current.baseBranch)),
      )

      if (next) await showReview(next)
    }),
    vscode.commands.registerCommand('duff.openDiff', async (item: unknown) => {
      if (!(item instanceof ReviewFile)) return
      const { review: current, change } = item
      const [base, head] = fileSnapshots(current, change)
      await vscode.commands.executeCommand(
        'vscode.diff',
        snapshotUri(base),
        snapshotUri(head),
        `${change.path}: ${current.baseBranch.replace(/^refs\/(heads|remotes)\//, '')} ↔ ${current.headBranch}`,
      )
    }),
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
