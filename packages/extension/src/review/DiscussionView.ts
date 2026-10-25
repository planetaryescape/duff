import { type DiscussionState, type DiscussionThread } from '@duff/core/discussion'
import { type Attempt, type Draft, type DraftPage } from '@duff/core/discussion-drafts'
import { Option } from 'effect'
import * as vscode from 'vscode'

import { draftDestination } from './DiscussionDraftEditor'

export class DiscussionItem extends vscode.TreeItem {
  constructor(
    readonly value: DiscussionThread | Draft | Attempt,
    label: string,
    description: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = description
    this.tooltip = `${label}: ${description}`
  }
}

export class DiscussionView implements vscode.TreeDataProvider<DiscussionItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changes.event
  private items: DiscussionItem[] = []
  private readonly tree: vscode.TreeView<DiscussionItem>
  constructor() {
    this.tree = vscode.window.createTreeView('duff.discussion', { treeDataProvider: this })
  }

  render(state: DiscussionState, page?: DraftPage, localError?: string) {
    this.items = []
    const messages = [localError]

    if (state._tag === 'Inactive')
      messages.push(
        'Saved drafts and send attempts remain available. Open a PR review to load live discussion.',
      )

    if (state._tag === 'Loading') messages.push('Loading comments…')

    if (state._tag === 'Failed')
      messages.push(
        'Comments could not be loaded. Saved drafts remain available. Refresh Comments to try a new read.',
      )

    if ('snapshot' in state) {
      if (state._tag === 'Stale')
        messages.push('Showing stale comments. Refresh failed; code and drafts are unchanged.')

      if (state._tag === 'Refreshing') messages.push('Refreshing comments…')

      if (state.snapshot.completeness._tag === 'Limited')
        messages.push(
          `Limited comments: ${state.snapshot.completeness.reason}. Open the PR in your browser for the full discussion.`,
        )

      if (state.snapshot.threads.length === 0 && state.snapshot.completeness._tag === 'Complete')
        messages.push('No published comments.')

      for (const thread of state.snapshot.threads) {
        if (thread.anchor._tag !== 'Unplaced') continue

        const item = new DiscussionItem(
          thread,
          thread.comments[0]?.author ?? 'Thread',
          `Unplaced: ${thread.anchor.reason}${thread.commentsComplete ? '' : ' · partial'}`,
        )

        item.contextValue = 'duff.unplacedThread'
        item.command = {
          command: 'duff.inspectDiscussionThread',
          title: 'Read Thread',
          arguments: [item],
        }
        this.items.push(item)
      }
    }

    if (page) {
      for (const draft of page.drafts) {
        const item = new DiscussionItem(draft, 'Saved draft', draftDestination(draft))
        item.contextValue = 'duff.discussionDraft'
        item.command = {
          command: 'duff.openDiscussionDraft',
          title: 'Open Draft',
          arguments: [item],
        }
        this.items.push(item)
      }

      for (const attempt of page.attempts) {
        const item = new DiscussionItem(
          attempt,
          attempt._tag === 'Prepared' ? 'Not dispatched' : 'Send outcome uncertain',
          `${attempt.intent.key.providerId} · ${attempt.intent.key.repository.displayName} · PR #${attempt.intent.key.pullRequestId} · Inspect before sending again; never automatically retried`,
        )

        item.contextValue = 'duff.discussionAttempt'
        item.command = {
          command: 'duff.inspectDiscussionAttempt',
          title: 'Inspect Attempt',
          arguments: [item],
        }
        this.items.push(item)
      }

      if (Option.isSome(page.next))
        messages.push(
          'More saved drafts or attempts are available. Use Load More Saved Discussion.',
        )
    }

    this.tree.message = messages.filter((message) => message !== undefined).join(' ')
    this.changes.fire()
  }
  getTreeItem(item: DiscussionItem) {
    return item
  }
  getChildren() {
    return this.items
  }
  owns(item: unknown): item is DiscussionItem {
    return item instanceof DiscussionItem && this.items.includes(item)
  }
  dispose() {
    this.tree.dispose()
    this.changes.dispose()
  }
}
