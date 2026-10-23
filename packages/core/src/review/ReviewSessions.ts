import { createHash } from 'node:crypto'

import { Clock, Context, Effect, Layer, Option, Semaphore } from 'effect'

import { type PullRequestSelection, type ResolvedPullRequest } from '../pull-requests/PullRequests'
import { BranchReview, type FileComparison, type Review, ReviewError } from './BranchReview'
import { SavedReview, SavedReviewCatalog, SavedReviews, ReviewStorageError } from './SavedReviews'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function reviewSessionKey(root: string, selection: PullRequestSelection): string {
  return digest(
    JSON.stringify([
      root,
      selection.provider,
      selection.repository.authority,
      selection.repository.key,
      selection.id,
    ]),
  )
}

function comparisonKey(file: FileComparison): string {
  return JSON.stringify([
    file.change.status,
    file.change.path,
    file.change.previousPath,
    Option.map(file.base, (value) => [value.id, value.mode]),
    Option.map(file.head, (value) => [value.id, value.mode]),
  ])
}

export class ReviewSessions extends Context.Service<
  ReviewSessions,
  {
    readonly list: () => Effect.Effect<SavedReviewCatalog, ReviewStorageError>
    readonly accept: (
      selection: PullRequestSelection,
      resolved: ResolvedPullRequest,
      review: Review,
    ) => Effect.Effect<SavedReview, ReviewStorageError | ReviewError>
    readonly resume: (key: string) => Effect.Effect<SavedReview, ReviewStorageError | ReviewError>
    readonly progress: (
      key: string,
      review: Review,
      path: string,
      viewed: boolean,
    ) => Effect.Effect<SavedReview, ReviewStorageError | ReviewError>
    readonly opened: (
      key: string,
      review: Review,
      path: string,
    ) => Effect.Effect<void, ReviewStorageError | ReviewError>
    readonly leave: () => Effect.Effect<void, ReviewStorageError>
    readonly forget: (key: string) => Effect.Effect<void, ReviewStorageError>
  }
>()('duff/ReviewSessions') {
  static readonly layer = Layer.effect(
    ReviewSessions,
    Effect.gen(function* () {
      const store = yield* SavedReviews
      const git = yield* BranchReview
      const gate = yield* Semaphore.make(1)
      let catalog: SavedReviewCatalog | undefined

      const persist = Effect.fn('ReviewSessions.persist')(function* (next: SavedReviewCatalog) {
        yield* store.save(next)
        catalog = next
      })

      const clean = Effect.fn('ReviewSessions.clean')(function* (current: SavedReviewCatalog) {
        const pending = []

        for (const entry of current.pendingRelease) {
          if (
            current.sessions.some(
              (session) => session.retention === entry.prefix && session.review.root === entry.root,
            )
          )
            continue
          const released = yield* Effect.result(git.release(entry.root, entry.prefix))

          if (released._tag === 'Failure') pending.push(entry)
        }

        if (pending.length !== current.pendingRelease.length) {
          yield* persist(
            SavedReviewCatalog.make({
              version: 1,
              active: current.active,
              sessions: current.sessions,
              pendingRelease: pending,
            }),
          )
        }
      })

      const load = Effect.fn('ReviewSessions.load')(function* () {
        if (!catalog) {
          const loaded = yield* store.load()
          const owned = `refs/duff/sessions/${store.owner}/`

          if (
            !/^[a-f0-9]{64}$/.test(store.owner) ||
            loaded.sessions.some((session) => !session.retention.startsWith(owned)) ||
            loaded.pendingRelease.some((entry) => !entry.prefix.startsWith(owned))
          )
            return yield* new ReviewStorageError({ reason: 'invalid' })
          catalog = loaded
        }

        // Cleanup is retryable housekeeping, not part of accepting a durable snapshot.
        yield* clean(catalog).pipe(Effect.ignore)

        return catalog
      })

      const replace = Effect.fn('ReviewSessions.replace')(function* (
        current: SavedReviewCatalog,
        session: SavedReview,
      ) {
        yield* persist(
          SavedReviewCatalog.make({
            version: 1,
            active: current.active,
            pendingRelease: current.pendingRelease,
            sessions: [session, ...current.sessions.filter((item) => item.key !== session.key)],
          }),
        )

        return session
      })

      const find = (current: SavedReviewCatalog, key: string) => {
        const session = current.sessions.find((item) => item.key === key)

        return session
          ? Effect.succeed(session)
          : Effect.fail(
              new ReviewError({
                operation: 'resume',
                message: 'This saved review is no longer available.',
              }),
            )
      }

      const matching = Effect.fn('ReviewSessions.matching')(function* (
        current: SavedReviewCatalog,
        key: string,
        review: Review,
      ) {
        const session = yield* find(current, key)

        if (
          session.review.root !== review.root ||
          session.review.baseCommit !== review.baseCommit ||
          session.review.headCommit !== review.headCommit
        )
          return yield* new ReviewError({
            operation: 'saved progress',
            message: 'This diff belongs to an older review snapshot. Open the current file list.',
          })

        return session
      })

      const accept = Effect.fn('ReviewSessions.accept')(
        function* (selection: PullRequestSelection, resolved: ResolvedPullRequest, review: Review) {
          const current = yield* load()
          const key = reviewSessionKey(review.root, selection)
          const previous = current.sessions.find((item) => item.key === key)
          const comparisons = yield* git.comparisons(review)

          const viewed = comparisons
            .filter(
              (file) =>
                previous?.viewed.includes(file.change.path) &&
                previous.comparisons.some((old) => comparisonKey(old) === comparisonKey(file)),
            )
            .map((file) => file.change.path)

          const generation = digest(
            JSON.stringify([
              review.baseCommit,
              review.headCommit,
              resolved.revisions.target.commit,
            ]),
          )

          const retention = `refs/duff/sessions/${store.owner}/${key}/${generation}`

          const session = SavedReview.make({
            key,
            selection,
            resolved,
            review,
            comparisons,
            viewed,
            lastFile:
              previous &&
              Option.isSome(previous.lastFile) &&
              review.files.some((file) => file.path === Option.getOrUndefined(previous.lastFile))
                ? previous.lastFile
                : Option.none(),
            updatedAt: yield* Clock.currentTimeMillis,
            retention,
          })

          const candidate = { root: review.root, prefix: retention }

          const staged = SavedReviewCatalog.make({
            version: 1,
            active: current.active,
            sessions: current.sessions,
            pendingRelease: [...current.pendingRelease, candidate],
          })

          yield* persist(staged)
          yield* git.retain(review.root, retention, [
            review.baseCommit,
            review.headCommit,
            resolved.revisions.target.commit,
          ])

          const pendingRelease =
            previous && previous.retention !== retention
              ? [
                  ...current.pendingRelease,
                  { root: previous.review.root, prefix: previous.retention },
                ]
              : current.pendingRelease

          yield* replace(
            SavedReviewCatalog.make({
              version: 1,
              active: Option.some(session.key),
              sessions: staged.sessions,
              pendingRelease,
            }),
            session,
          )
          yield* load()

          return session
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const resume = Effect.fn('ReviewSessions.resume')(
        function* (key: string) {
          const current = yield* load()
          const session = yield* find(current, key)
          yield* git.retain(session.review.root, session.retention, [
            session.review.baseCommit,
            session.review.headCommit,
            session.resolved.revisions.target.commit,
          ])
          const actual = yield* git.comparisons(session.review)

          if (
            JSON.stringify(actual.map(comparisonKey)) !==
            JSON.stringify(session.comparisons.map(comparisonKey))
          )
            return yield* new ReviewError({
              operation: 'resume',
              message:
                'Saved Git comparison metadata does not match. The session is preserved; restore its repository or objects before resuming.',
            })

          return yield* replace(
            SavedReviewCatalog.make({
              version: 1,
              active: Option.some(session.key),
              sessions: current.sessions,
              pendingRelease: current.pendingRelease,
            }),
            SavedReview.make({ ...session, updatedAt: yield* Clock.currentTimeMillis }),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const progress = Effect.fn('ReviewSessions.progress')(
        function* (key: string, review: Review, path: string, viewed: boolean) {
          const current = yield* load()
          const session = yield* matching(current, key, review)

          if (!session.review.files.some((file) => file.path === path)) return session
          const paths = new Set(session.viewed)

          if (viewed) paths.add(path)
          else paths.delete(path)

          return yield* replace(
            current,
            SavedReview.make({
              ...session,
              viewed: [...paths],
              updatedAt: yield* Clock.currentTimeMillis,
            }),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const opened = Effect.fn('ReviewSessions.opened')(
        function* (key: string, review: Review, path: string) {
          const current = yield* load()
          const session = yield* matching(current, key, review)

          if (
            !session.review.files.some((file) => file.path === path) ||
            Option.getOrUndefined(session.lastFile) === path
          )
            return
          yield* replace(
            current,
            SavedReview.make({
              ...session,
              lastFile: Option.some(path),
              updatedAt: yield* Clock.currentTimeMillis,
            }),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const leave = Effect.fn('ReviewSessions.leave')(
        function* () {
          const current = yield* load()

          if (Option.isNone(current.active)) return
          yield* persist(
            SavedReviewCatalog.make({
              version: 1,
              active: Option.none(),
              sessions: current.sessions,
              pendingRelease: current.pendingRelease,
            }),
          )
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      const forget = Effect.fn('ReviewSessions.forget')(
        function* (key: string) {
          const current = yield* load()
          const session = current.sessions.find((item) => item.key === key)

          if (!session) return

          const next = SavedReviewCatalog.make({
            version: 1,
            active: Option.getOrUndefined(current.active) === key ? Option.none() : current.active,
            sessions: current.sessions.filter((item) => item.key !== key),
            pendingRelease: [
              ...current.pendingRelease,
              { root: session.review.root, prefix: session.retention },
            ],
          })

          yield* persist(next)
          yield* clean(next).pipe(Effect.ignore)
        },
        gate.withPermits(1),
        Effect.uninterruptible,
      )

      return ReviewSessions.of({
        list: () => load().pipe(gate.withPermits(1), Effect.uninterruptible),
        accept,
        resume,
        progress,
        opened,
        leave,
        forget,
      })
    }),
  )
}
