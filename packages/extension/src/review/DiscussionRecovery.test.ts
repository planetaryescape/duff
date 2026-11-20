import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { AttemptId, discussionKey, DraftId, ThreadId, ResolutionInput } from '@duff/core/discussion'
import {
  DiscussionDraftStore,
  DiscussionIds,
  Draft,
  DraftEnvelope,
  type AttemptIntent,
} from '@duff/core/discussion-drafts'
import { Discussions } from '@duff/core/discussions'
import { PullRequests } from '@duff/core/pull-requests'
import { BranchReview } from '@duff/core/review'
import { it } from '@effect/vitest'
import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect } from 'vitest'

import { makeDiscussionDraftStoreLayer } from './DiscussionDraftStore'
import { discussionFixture } from './DiscussionFixture'

function draftFixture(index: number, pr: string): Draft {
  const origin = discussionFixture(pr)
  const change = origin.review.files[0]

  if (!change) throw new Error('Missing fixture change')

  return Draft.make({
    id: DraftId.make(`draft-${index.toString().padStart(4, '0')}`),
    key: origin.key,
    origin,
    target: {
      _tag: 'NewThread',
      anchor: {
        comparison: origin.comparison,
        change,
        side: 'head',
        path: change.path,
        commit: origin.review.headCommit,
        range: { start: 1, end: 1 },
      },
    },
    version: 1,
    body: `Recovered draft ${index}`,
  })
}

function seedDrafts(directory: string, drafts: readonly Draft[]) {
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DraftEnvelope)))
  const db = new DatabaseSync(join(directory, 'discussion.sqlite'))

  try {
    db.exec('BEGIN IMMEDIATE')

    const insert = db.prepare(
      'INSERT INTO drafts (id, discussion_key, revision, payload_json) VALUES (?, ?, ?, ?)',
    )

    for (const draft of drafts) {
      insert.run(
        draft.id,
        discussionKey(draft.key),
        draft.version,
        encode({ version: 1, value: draft }),
      )
    }

    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

describe('global discussion recovery through real SQLite', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'duff-recovery-'))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const run = <A, E>(effect: Effect.Effect<A, E, DiscussionDraftStore>) =>
    effect.pipe(Effect.provide(makeDiscussionDraftStoreLayer(directory)))

  it.effect(
    'pages at most 100 combined records across PRs with scope-bound continuation',
    Effect.fnUntraced(function* () {
      const drafts = Array.from({ length: 102 }, (_, index) =>
        draftFixture(index, index < 101 ? '22' : '23'),
      )

      const [firstDraft, ...remainingDrafts] = drafts

      if (!firstDraft) throw new Error('Missing fixture draft')

      yield* run(DiscussionDraftStore.use((store) => store.create(firstDraft)))
      seedDrafts(directory, remainingDrafts)

      const pending: AttemptIntent = {
        id: AttemptId.make('pending'),
        key: firstDraft.key,
        input: { _tag: 'Draft', draft: firstDraft },
      }

      yield* run(DiscussionDraftStore.use((store) => store.prepare(pending)))

      const command = ResolutionInput.make({
        attempt: AttemptId.make('terminal'),
        thread: { discussion: firstDraft.key, id: ThreadId.make('thread') },
        expected: { _tag: 'Open', detail: 'unresolved' },
        desired: 'resolved',
      })

      const terminal: AttemptIntent = {
        id: command.attempt,
        key: firstDraft.key,
        input: { _tag: 'Resolution', command },
      }

      yield* run(DiscussionDraftStore.use((store) => store.prepare(terminal)))
      yield* run(DiscussionDraftStore.use((store) => store.dispatch(terminal.id)))
      yield* run(
        DiscussionDraftStore.use((store) =>
          store.finish({
            _tag: 'Confirmed',
            intent: terminal,
            receipt: {
              _tag: 'Resolution',
              thread: command.thread,
              resolution: { _tag: 'Resolved', detail: 'resolved' },
            },
          }),
        ),
      )
      const first = yield* run(DiscussionDraftStore.use((store) => store.listAll(Option.none())))
      expect(first.drafts.length + first.attempts.length).toBe(100)
      expect(first.attempts).toEqual([{ _tag: 'Prepared', intent: pending }])
      expect(Option.isSome(first.next)).toBe(true)
      const second = yield* run(DiscussionDraftStore.use((store) => store.listAll(first.next)))
      expect(second.drafts).toHaveLength(3)
      expect(second.attempts).toHaveLength(0)
      expect(second.next).toEqual(Option.none())
      const recovered = [...first.drafts, ...second.drafts]
      expect(new Set(recovered.map((draft) => draft.id)).size).toBe(102)
      expect(new Set(recovered.map((draft) => draft.key.pullRequestId))).toEqual(
        new Set(['22', '23']),
      )

      const scoped = yield* run(
        DiscussionDraftStore.use((store) => store.list(firstDraft.key, Option.none())),
      )

      expect(Option.isSome(scoped.next)).toBe(true)
      expect(
        (yield* run(
          DiscussionDraftStore.use((store) => store.listAll(scoped.next)).pipe(Effect.result),
        ))._tag,
      ).toBe('Failure')
      expect(
        (yield* run(
          DiscussionDraftStore.use((store) => store.list(firstDraft.key, first.next)).pipe(
            Effect.result,
          ),
        ))._tag,
      ).toBe('Failure')
    }),
  )

  it.effect(
    'recovers while Inactive without Git, auth, discovery or a selected PR',
    Effect.fnUntraced(function* () {
      const first = draftFixture(1, 'forgotten-review')
      const second = draftFixture(2, 'other-review')
      yield* run(DiscussionDraftStore.use((store) => store.create(first)))
      yield* run(DiscussionDraftStore.use((store) => store.create(second)))
      const forbidden = () => Effect.die('Recovery must not call external services')

      const layer = Discussions.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            makeDiscussionDraftStoreLayer(directory),
            Layer.succeed(
              BranchReview,
              BranchReview.of({
                branches: forbidden,
                compare: forbidden,
                prepare: forbidden,
                read: forbidden,
                comparisons: forbidden,
                retain: forbidden,
                release: forbidden,
              }),
            ),
            Layer.succeed(
              PullRequests,
              PullRequests.of({
                discussion: forbidden,
                discover: () => Stream.die('Recovery must not discover'),
                loadMore: forbidden,
                connect: forbidden,
                resolve: forbidden,
              }),
            ),
            Layer.succeed(
              DiscussionIds,
              DiscussionIds.of({ draft: forbidden, attempt: forbidden }),
            ),
          ),
        ),
      )

      yield* Discussions.use((service) =>
        Effect.gen(function* () {
          expect((yield* service.current())._tag).toBe('Inactive')
          const page = yield* service.allDrafts(Option.none())
          expect(page.drafts).toEqual([first, second])
          expect((yield* service.current())._tag).toBe('Inactive')
        }),
      ).pipe(Effect.provide(layer))
    }),
  )
})
