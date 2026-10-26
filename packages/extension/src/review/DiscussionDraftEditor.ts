import { DraftId, discussionKey } from '@duff/core/discussion'
import { type Draft, type Attempt } from '@duff/core/discussion-drafts'
import { Discussions } from '@duff/core/discussions'
import { Effect, type ManagedRuntime, Option, Schema, Semaphore } from 'effect'
import * as vscode from 'vscode'

import { DiscussionSaveLoop } from './DiscussionSaveLoop'

type DraftEditorRuntime = Pick<
  ManagedRuntime.ManagedRuntime<Discussions, never>,
  'runPromise' | 'runPromiseExit' | 'runFork'
>

export function draftDestination(draft: Draft): string {
  const destination = `${draft.key.providerId} · ${draft.key.repository.displayName} · PR #${draft.key.pullRequestId}`

  return draft.target._tag === 'Reply'
    ? `${destination} · reply to ${draft.target.thread.id}`
    : `${destination} · ${draft.target.anchor.path}:${draft.target.anchor.range.start} (${draft.target.anchor.side}, ${draft.target.anchor.commit.slice(0, 12)})`
}

export function draftUri(id: DraftId): vscode.Uri {
  return vscode.Uri.from({ scheme: 'duff-draft', path: `/${encodeURIComponent(id)}.md` })
}

function draftId(uri: vscode.Uri): DraftId {
  if (
    uri.scheme !== 'duff-draft' ||
    uri.authority ||
    uri.query ||
    uri.fragment ||
    !/^\/[^/]+\.md$/.test(uri.path)
  )
    throw vscode.FileSystemError.FileNotFound()
  const parsed = Schema.decodeUnknownOption(DraftId)(decodeURIComponent(uri.path.slice(1, -3)))

  if (Option.isNone(parsed)) throw vscode.FileSystemError.FileNotFound()

  return parsed.value
}

interface Binding {
  draft: Draft
  readonly writes: Semaphore.Semaphore
  readonly saves: DiscussionSaveLoop
  failed: boolean
}

export class DiscussionDraftEditor implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.changes.event
  private readonly bindings = new Map<DraftId, Binding>()
  private readonly initialization = Semaphore.makeUnsafe(1)
  private readonly reserved = new Map<string, Set<DraftId>>()
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)

  constructor(
    private readonly runtime: DraftEditorRuntime,
    context: vscode.ExtensionContext,
  ) {
    context.subscriptions.push(
      this,
      vscode.workspace.registerFileSystemProvider('duff-draft', this, { isCaseSensitive: true }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme === 'duff-draft') {
          this.showStatus(event.document)
          runtime.runFork(
            Effect.promise(() => this.flush(event.document)).pipe(
              Effect.catchCause(() => Effect.sync(() => this.showStatus(event.document))),
            ),
          )
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.showStatus(editor?.document)),
    )
  }

  private async binding(uri: vscode.Uri): Promise<Binding> {
    const id = draftId(uri)

    return await this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const existing = this.bindings.get(id)

        if (existing) return existing
        const draft = yield* Discussions.use((service) => service.draft(id))

        if (Option.isNone(draft))
          return yield* Effect.fail(vscode.FileSystemError.FileNotFound(uri))

        const binding: Binding = {
          draft: draft.value,
          writes: Semaphore.makeUnsafe(1),
          saves: new DiscussionSaveLoop(),
          failed: false,
        }

        this.bindings.set(id, binding)

        return binding
      }).pipe(this.initialization.withPermits(1)),
    )
  }

  async open(draft: Draft) {
    const uri = draftUri(draft.id)
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.languages.setTextDocumentLanguage(document, 'markdown')
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    })
    this.showStatus(document)
  }

  async flush(document: vscode.TextDocument): Promise<void> {
    const binding = await this.binding(document.uri)

    const exit = await this.runtime.runPromiseExit(
      binding.saves.flush(document, () => binding.draft.body),
    )

    if (exit._tag === 'Failure') binding.failed = true
    this.showStatus(document)

    if (exit._tag === 'Failure')
      throw vscode.FileSystemError.Unavailable(
        'Draft not saved. Keep this text open; use Save to retry or copy it to recover.',
      )
  }

  async current(uri: vscode.Uri): Promise<Draft> {
    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.toString() === uri.toString(),
    )

    if (document) await this.flush(document)
    const binding = await this.binding(uri)

    if (this.reserved.get(discussionKey(binding.draft.key))?.has(binding.draft.id))
      throw vscode.FileSystemError.Unavailable(
        'This draft has an unresolved send attempt. Inspect the saved attempt before sending or discarding it.',
      )

    if (binding.failed || (document && binding.draft.body !== document.getText()))
      throw vscode.FileSystemError.Unavailable('Save this draft before sending.')

    return binding.draft
  }

  async destination(uri: vscode.Uri): Promise<Draft> {
    return (await this.binding(uri)).draft
  }

  setRecoveryAttempts(attempts: ReadonlyArray<Attempt>): void {
    this.reserved.clear()

    for (const attempt of attempts) {
      if (
        attempt.intent.input._tag !== 'Draft' ||
        (attempt._tag !== 'Prepared' &&
          attempt._tag !== 'Dispatching' &&
          attempt._tag !== 'Uncertain')
      )
        continue
      const key = discussionKey(attempt.intent.key)
      const ids = this.reserved.get(key) ?? new Set<DraftId>()
      ids.add(attempt.intent.input.draft.id)
      this.reserved.set(key, ids)
    }

    this.showStatus(vscode.window.activeTextEditor?.document)
  }

  async copy(uri: vscode.Uri): Promise<void> {
    const id = draftId(uri)

    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.toString() === uri.toString(),
    )

    const binding = this.bindings.get(id)

    if (!document && !binding) throw vscode.FileSystemError.FileNotFound(uri)
    await vscode.env.clipboard.writeText(
      document ? document.getText() : (binding?.draft.body ?? ''),
    )
    await vscode.window.showInformationMessage(
      'Duff: Draft text copied for recovery. Its saved destination was not changed.',
    )
  }

  async refresh(id: DraftId): Promise<void> {
    const current = await this.runtime.runPromise(Discussions.use((service) => service.draft(id)))

    if (Option.isSome(current)) return
    const uri = draftUri(id)

    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.toString() === uri.toString(),
    )

    const binding = this.bindings.get(id)

    if (document?.isDirty) {
      if (binding) binding.failed = true
      this.showStatus(document)
      await vscode.window.showWarningMessage(
        'Duff: The submitted draft is complete, but this tab has newer unsaved text. Copy Draft for Recovery before closing it; the old ID will not be recreated.',
      )

      return
    }

    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
      )

    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs)
    this.bindings.delete(id)
  }

  private showStatus(document?: vscode.TextDocument) {
    if (
      document?.uri.scheme === 'duff-draft' &&
      document.uri.toString() !== vscode.window.activeTextEditor?.document.uri.toString()
    )
      return

    if (!document || document.uri.scheme !== 'duff-draft') {
      this.status.hide()
      this.runtime.runFork(
        Effect.promise(async () => {
          await vscode.commands.executeCommand('setContext', 'duff.draftReady', false)
        }),
      )

      return
    }

    const parsed = Schema.decodeUnknownOption(DraftId)(
      decodeURIComponent(document.uri.path.slice(1, -3)),
    )

    const binding = Option.isSome(parsed) ? this.bindings.get(parsed.value) : undefined

    if (!binding) return

    const reserved =
      this.reserved.get(discussionKey(binding.draft.key))?.has(binding.draft.id) ?? false

    this.runtime.runFork(
      Effect.promise(async () => {
        await vscode.commands.executeCommand(
          'setContext',
          'duff.draftReady',
          !reserved && !binding.failed && !document.isDirty && document.getText().trim().length > 0,
        )
      }),
    )
    this.status.text = `Duff draft: ${reserved ? 'Inspect saved send attempt' : binding.failed ? 'Save failed' : document.isDirty ? 'Saving' : 'Saved'} · ${draftDestination(binding.draft)}`
    this.status.tooltip =
      'Only acknowledged saved text survives restart. Save conflicts keep your dirty text; copy it before reloading.'
    this.status.show()
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const binding = await this.binding(uri)

    return new DraftFileStat(binding.draft)
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from((await this.binding(uri)).draft.body, 'utf8')
  }
  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const binding = await this.binding(uri)
    const body = new TextDecoder('utf-8', { fatal: true }).decode(content)

    const work = Effect.gen(function* () {
      const service = yield* Discussions

      const saved = yield* service.save({
        id: binding.draft.id,
        expectedVersion: binding.draft.version,
        body,
      })

      binding.draft = saved
      binding.failed = false

      return saved
    }).pipe(binding.writes.withPermits(1))

    const exit = await this.runtime.runPromiseExit(work)

    if (exit._tag === 'Failure') {
      binding.failed = true
      throw vscode.FileSystemError.Unavailable(
        'Could not save draft. Disk access or another window may have changed it. Keep or copy your text before reloading.',
      )
    }
  }
  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions()
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions()
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Use Duff: Discard Draft.')
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions()
  }
  dispose() {
    this.changes.dispose()
    this.status.dispose()
  }
}

class DraftFileStat implements vscode.FileStat {
  readonly type = vscode.FileType.File
  readonly ctime = 0
  readonly mtime: number
  readonly size: number
  constructor(draft: Draft) {
    this.mtime = draft.version
    this.size = Buffer.byteLength(draft.body, 'utf8')
  }
}
