import {
  type DiscussionReview,
  type DiscussionSnapshot,
  type DiscussionThread,
  type DiscussionComment,
  discussionKey,
} from '@duff/core/discussion'
import * as vscode from 'vscode'

import { discussionCommentLabel } from './DiscussionCommentPresentation'
import { snapshotUri } from './ReviewView'
import { snapshotDocument } from './SnapshotDocument'

function inertBody(body: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString()
  markdown.appendText(body)
  markdown.isTrusted = false
  markdown.supportHtml = false

  return markdown
}

export class DiscussionComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(
    'duff.discussion',
    'Duff PR Comments',
  )
  private readonly threads = new Map<
    string,
    { readonly native: vscode.CommentThread; thread: DiscussionThread }
  >()

  owns(value: unknown): value is vscode.CommentThread {
    for (const item of this.threads.values()) if (item.native === value) return true

    return false
  }

  lookup(value: vscode.CommentThread): DiscussionThread | undefined {
    for (const item of this.threads.values()) if (item.native === value) return item.thread

    return undefined
  }

  render(review: DiscussionReview, snapshot: DiscussionSnapshot, shown: boolean) {
    const retained = new Set<string>()

    if (shown)
      for (const thread of snapshot.threads) {
        if (thread.anchor._tag !== 'Exact') continue
        const anchor = thread.anchor.anchor
        const change = review.review.files.find((file) => file.path === anchor.change.path)

        if (!change) continue
        const document = snapshotDocument(review, change, anchor.side)
        const uri = snapshotUri(document.snapshot, document)

        const key = JSON.stringify([
          discussionKey(thread.key.discussion),
          thread.key.id,
          uri.toString(),
        ])

        retained.add(key)

        const comments = thread.comments.map(
          (comment) =>
            new NativeDiscussionComment(
              comment.author,
              comment.deleted ? '[Deleted comment]' : comment.body,
              comment.publication,
              thread.commentsComplete,
            ),
        )

        const existing = this.threads.get(key)

        const native =
          existing?.native ??
          this.controller.createCommentThread(
            uri,
            new vscode.Range(anchor.range.start - 1, 0, anchor.range.end - 1, 0),
            comments,
          )

        native.comments = comments
        native.canReply = false
        native.contextValue = `duff.thread.${thread.reply._tag !== 'Unavailable' ? 'reply.' : ''}${thread.resolution._tag === 'Open' && thread.resolve._tag !== 'Unavailable' ? 'resolve' : thread.resolution._tag === 'Resolved' && thread.reopen._tag !== 'Unavailable' ? 'reopen' : 'readonly'}`
        native.state =
          thread.resolution._tag === 'Resolved'
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved
        native.label =
          thread.resolution._tag === 'Unknown' ? 'Unknown resolution' : thread.resolution.detail

        if (!existing)
          native.collapsibleState =
            thread.resolution._tag === 'Resolved'
              ? vscode.CommentThreadCollapsibleState.Collapsed
              : vscode.CommentThreadCollapsibleState.Expanded
        this.threads.set(key, { native, thread })
      }

    for (const [key, item] of this.threads)
      if (!retained.has(key)) {
        item.native.dispose()
        this.threads.delete(key)
      }
  }

  clear() {
    for (const item of this.threads.values()) item.native.dispose()
    this.threads.clear()
  }
  dispose() {
    this.clear()
    this.controller.dispose()
  }
}

class NativeDiscussionComment implements vscode.Comment {
  readonly body: vscode.MarkdownString
  readonly mode = vscode.CommentMode.Preview
  readonly author: vscode.CommentAuthorInformation
  readonly label: string | undefined
  constructor(
    author: string,
    body: string,
    publication: DiscussionComment['publication'],
    complete: boolean,
  ) {
    this.body = inertBody(body)
    this.author = { name: author }
    this.label = discussionCommentLabel(publication, complete)
  }
}
