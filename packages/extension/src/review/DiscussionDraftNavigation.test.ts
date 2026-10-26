import {
  CodeAnchor,
  DiscussionReview,
  DiscussionSnapshot,
  DiscussionThread,
  DiscussionUnsupported,
  DraftId,
  ThreadId,
  type DiscussionState,
} from '@duff/core/discussion'
import { Draft } from '@duff/core/discussion-drafts'
import { BranchReview, FileComparison, Review } from '@duff/core/review'
import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { describe, expect } from 'vitest'

import { draftDiffAnchor } from './DiscussionDraftNavigation'
import { discussionFixture } from './DiscussionFixture'

function fixture() {
  const origin = discussionFixture()
  const change = origin.review.files[0]

  if (!change) throw new Error('Missing change')

  const anchor = CodeAnchor.make({
    comparison: origin.comparison,
    change,
    side: 'head',
    path: change.path,
    commit: origin.review.headCommit,
    range: { start: 1, end: 1 },
  })

  const thread = DiscussionThread.make({
    key: { discussion: origin.key, id: ThreadId.make('reply-thread') },
    comments: [],
    commentsComplete: true,
    resolution: { _tag: 'Open', detail: 'unresolved' },
    anchor: { _tag: 'Exact', anchor, outdated: false },
    reply: { _tag: 'Allowed' },
    resolve: { _tag: 'Allowed' },
    reopen: { _tag: 'Allowed' },
    providerPage: Option.none(),
  })

  const draft = Draft.make({
    id: DraftId.make('reply'),
    key: origin.key,
    target: { _tag: 'Reply', thread: thread.key },
    origin,
    version: 1,
    body: 'Preserved reply',
  })

  const review = DiscussionReview.make({
    key: origin.key,
    selection: origin.selection,
    comparison: origin.comparison,
    review: Review.make({
      root: '/different/active/checkout',
      baseBranch: origin.review.baseBranch,
      headBranch: origin.review.headBranch,
      baseCommit: origin.review.baseCommit,
      headCommit: origin.review.headCommit,
      files: origin.review.files,
    }),
  })

  const snapshot = DiscussionSnapshot.make({
    key: origin.key,
    threads: [thread],
    completeness: { _tag: 'Complete' },
  })

  const ready: DiscussionState = { _tag: 'Ready', review, snapshot }

  return { origin, change, anchor, draft, review, snapshot, ready }
}

describe('returning reply drafts to immutable code', () => {
  it.effect(
    'validates current exact placement in the original checkout, not the active checkout',
    Effect.fnUntraced(function* () {
      const input = fixture()
      const roots: string[] = []
      const forbidden = () => Effect.die('Unexpected Git operation')

      const git = BranchReview.of({
        branches: forbidden,
        compare: forbidden,
        retain: forbidden,
        release: forbidden,
        prepare: (root) => {
          roots.push(root)

          return Effect.succeed(input.origin.review)
        },
        comparisons: (review) => {
          roots.push(review.root)

          return Effect.succeed([
            FileComparison.make({
              change: input.change,
              base: Option.some({ id: input.origin.review.baseCommit, mode: '100644' }),
              head: Option.some({ id: input.origin.review.headCommit, mode: '100644' }),
            }),
          ])
        },
        read: (snapshot) => {
          roots.push(snapshot.root)

          return Effect.succeed('Immutable line\n')
        },
      })

      const anchor = yield* draftDiffAnchor(input.draft, input.ready).pipe(
        Effect.provideService(BranchReview, git),
      )

      expect(anchor).toEqual(input.anchor)
      expect(roots).toEqual([
        input.origin.review.root,
        input.origin.review.root,
        input.origin.review.root,
      ])
    }),
  )

  it.effect(
    'refuses stale, refreshing and inactive placement without a Git read',
    Effect.fnUntraced(function* () {
      const input = fixture()
      const forbidden = () => Effect.die('Unavailable placement must not reach Git')

      const git = BranchReview.of({
        branches: forbidden,
        compare: forbidden,
        prepare: forbidden,
        comparisons: forbidden,
        read: forbidden,
        retain: forbidden,
        release: forbidden,
      })

      const states: ReadonlyArray<DiscussionState> = [
        { _tag: 'Inactive' },
        { _tag: 'Refreshing', review: input.review, snapshot: input.snapshot },
        {
          _tag: 'Stale',
          review: input.review,
          snapshot: input.snapshot,
          error: new DiscussionUnsupported(),
        },
      ]

      for (const state of states) {
        const result = yield* draftDiffAnchor(input.draft, state).pipe(
          Effect.provideService(BranchReview, git),
          Effect.result,
        )

        expect(result._tag).toBe('Failure')

        if (result._tag === 'Failure') expect(result.failure.reason).toBe('invalid-anchor')
      }

      expect(input.draft.body).toBe('Preserved reply')
    }),
  )
})
