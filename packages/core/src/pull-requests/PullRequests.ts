import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from 'effect'

import { type GitContextSnapshot } from '../git-context/GitContext'
import { ReviewError, ReviewRevision, ReviewRevisions } from '../review/BranchReview'
import {
  type Authentication,
  type AuthenticationError,
  type DiscoveryError,
  type GitHostingProvider,
  InvalidContinuation,
  OpenPullRequest,
  ProviderIdentity,
  type PullRequestPage,
  type PullRequestState,
  type ProviderRepository,
  type Remote,
  RepositoryIdentity,
} from './GitHostingProvider'

export const GroupId = Schema.NonEmptyString.pipe(Schema.brand('RepositoryGroupId'))

export type GroupId = Schema.Schema.Type<typeof GroupId>

/** A repository discovered through one or more local remotes. */
export const RepositoryGroup = Schema.Struct({
  id: GroupId,
  key: Schema.String,
  provider: ProviderIdentity,
  repository: RepositoryIdentity,
  remoteNames: Schema.Array(Schema.String),
})

export interface RepositoryGroup extends Schema.Schema.Type<typeof RepositoryGroup> {}

export type DiscoveryNotice =
  | { readonly _tag: 'Unsupported'; readonly remote: Remote }
  | {
      readonly _tag: 'Ambiguous'
      readonly remote: Remote
      readonly candidates: ReadonlyArray<ProviderIdentity>
    }

/** Named constructors for internal discovery notices. */
export const DiscoveryNotice = Data.taggedEnum<DiscoveryNotice>()

export type GroupResult =
  | {
      readonly _tag: 'Ready'
      readonly group: RepositoryGroup
      readonly authentication: Authentication
      readonly items: ReadonlyArray<OpenPullRequest>
      readonly hasMore: boolean
    }
  | { readonly _tag: 'Failed'; readonly group: RepositoryGroup; readonly error: DiscoveryError }

/** Named constructors for page outcomes; these are not transport schemas. */
export const GroupResult = Data.taggedEnum<GroupResult>()

export type DiscoveryEvent =
  | {
      readonly _tag: 'Started'
      readonly groups: ReadonlyArray<RepositoryGroup>
      readonly notices: ReadonlyArray<DiscoveryNotice>
    }
  | { readonly _tag: 'Updated'; readonly result: GroupResult }

/** Named constructors for the discovery stream. */
export const DiscoveryEvent = Data.taggedEnum<DiscoveryEvent>()

class ProviderMatch {
  constructor(
    readonly provider: GitHostingProvider,
    readonly repository: ProviderRepository,
  ) {}
}

class BoundRemote {
  constructor(
    readonly remote: Remote,
    readonly repository: ProviderRepository,
  ) {}
}

class Entry {
  #group: RepositoryGroup
  #cursor: Option.Option<Redacted.Redacted> = Option.none()
  readonly #seen = new Set<string>()

  constructor(
    group: RepositoryGroup,
    readonly repository: ProviderRepository,
    readonly gate: Semaphore.Semaphore,
    readonly state: PullRequestState,
  ) {
    this.#group = group
  }

  get group() {
    return this.#group
  }

  get cursor() {
    return this.#cursor
  }

  addRemote(name: string) {
    this.#group = RepositoryGroup.make({
      id: this.#group.id,
      key: this.#group.key,
      provider: this.#group.provider,
      repository: this.#group.repository,
      remoteNames: [...this.#group.remoteNames, name],
    })
  }

  invalidateContinuation() {
    this.#cursor = Option.none()
  }

  /** Reject a repeated cursor without changing the accepted continuation. */
  acceptPage(page: PullRequestPage): boolean {
    if (Option.isSome(page.next) && this.#seen.has(Redacted.value(page.next.value))) return false

    this.#cursor = page.next

    if (Option.isSome(page.next)) this.#seen.add(Redacted.value(page.next.value))

    return true
  }
}

export class GroupNotFound extends Schema.TaggedError<GroupNotFound>()('GroupNotFound', {}) {}

export const PullRequestSelection = Schema.Struct({
  provider: Schema.String,
  repository: RepositoryIdentity,
  id: Schema.String,
  label: Schema.String,
})

export interface PullRequestSelection extends Schema.Schema.Type<typeof PullRequestSelection> {}

export const ResolvedPullRequest = Schema.Struct({
  pullRequest: OpenPullRequest,
  revisions: ReviewRevisions,
})

export interface ResolvedPullRequest extends Schema.Schema.Type<typeof ResolvedPullRequest> {}

/**
 * Owns continuation safety: same-group reads and connections queue, while different groups run
 * independently. ReviewSession owns action suppression and discovery-job cancellation.
 */
export class PullRequests extends Context.Service<
  PullRequests,
  {
    readonly discover: (
      snapshot: GitContextSnapshot,
      state?: PullRequestState,
    ) => Stream.Stream<DiscoveryEvent>
    readonly loadMore: (id: GroupId) => Effect.Effect<GroupResult, GroupNotFound>
    readonly connect: (
      id: GroupId,
    ) => Effect.Effect<Authentication, AuthenticationError | GroupNotFound>
    readonly resolve: (
      snapshot: GitContextSnapshot,
      selection: PullRequestSelection,
    ) => Effect.Effect<ResolvedPullRequest, DiscoveryError | ReviewError>
  }
>()('duff/pull-requests/PullRequests') {}

export const makePullRequestsLayer = (providers: ReadonlyArray<GitHostingProvider>) =>
  Layer.effect(
    PullRequests,
    Effect.gen(function* () {
      if (new Set(providers.map((provider) => provider.identity.id)).size !== providers.length) {
        return yield* Effect.die(new Error('Duplicate Duff provider registration.'))
      }

      const generation = yield* Ref.make(0)
      let entries = new Map<GroupId, Entry>()

      const read = Effect.fn('PullRequests.read')(function* (
        entry: Entry,
        more: boolean,
      ): Effect.fn.Return<GroupResult> {
        const cursor = more ? entry.cursor : Option.none<Redacted.Redacted>()

        if (more && Option.isNone(cursor))
          return GroupResult.Failed({ group: entry.group, error: new InvalidContinuation() })

        return yield* Effect.gen(function* () {
          const authentication = yield* entry.repository.inspectAuthentication()

          const page = yield* entry.repository.listPullRequests({
            scope: 'repository',
            cursor,
            state: entry.state,
          })

          if (!entry.acceptPage(page)) return yield* new InvalidContinuation()

          return GroupResult.Ready({
            group: entry.group,
            authentication,
            items: page.items,
            hasMore: Option.isSome(entry.cursor),
          })
        }).pipe(
          Effect.catch((error) => {
            if (['AuthenticationRequired', 'InvalidContinuation'].includes(error._tag))
              entry.invalidateContinuation()

            return Effect.succeed(GroupResult.Failed({ group: entry.group, error }))
          }),
        )
      })

      const discover = (
        snapshot: GitContextSnapshot,
        state: PullRequestState = 'open',
      ): Stream.Stream<DiscoveryEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const currentGeneration = yield* Ref.updateAndGet(generation, (value) => value + 1)
            const grouped = new Map<string, Entry>()
            const notices: DiscoveryNotice[] = []

            for (const remote of snapshot.remotes) {
              const matches = providers.flatMap((provider) => {
                const repository = provider.recognizeRemote(remote)

                return Option.isSome(repository)
                  ? [new ProviderMatch(provider, repository.value)]
                  : []
              })

              const match = matches[0]

              if (!match) {
                notices.push(DiscoveryNotice.Unsupported({ remote }))
                continue
              }

              if (matches.length > 1) {
                notices.push(
                  DiscoveryNotice.Ambiguous({
                    remote,
                    candidates: matches.map((match) => match.provider.identity),
                  }),
                )
                continue
              }

              const key = JSON.stringify([
                match.provider.identity.id,
                match.repository.identity.authority,
                match.repository.identity.key,
              ])

              const existing = grouped.get(key)

              if (existing) existing.addRemote(remote.name)
              else
                grouped.set(
                  key,
                  new Entry(
                    RepositoryGroup.make({
                      id: GroupId.make(`${currentGeneration}:${key}`),
                      key,
                      provider: match.provider.identity,
                      repository: match.repository.identity,
                      remoteNames: [remote.name],
                    }),
                    match.repository,
                    yield* Semaphore.make(1),
                    state,
                  ),
                )
            }

            entries = new Map([...grouped.values()].map((entry) => [entry.group.id, entry]))

            const started = DiscoveryEvent.Started({
              groups: [...grouped.values()].map((entry) => entry.group),
              notices,
            })

            return Stream.make(started).pipe(
              Stream.concat(
                Stream.fromIterable(grouped.values()).pipe(
                  Stream.mapEffect(
                    (entry) =>
                      read(entry, false).pipe(
                        entry.gate.withPermits(1),
                        Effect.map((result) => DiscoveryEvent.Updated({ result })),
                      ),
                    { concurrency: 4, unordered: true },
                  ),
                ),
              ),
            )
          }).pipe(Effect.withSpan('PullRequests.discover')),
        )

      const loadMore = Effect.fn('PullRequests.loadMore')(function* (id: GroupId) {
        const entry = entries.get(id)

        if (!entry) return yield* new GroupNotFound()

        return yield* Effect.gen(function* () {
          if (entries.get(id) !== entry) return yield* new GroupNotFound()

          return yield* read(entry, true)
        }).pipe(entry.gate.withPermits(1))
      })

      const connect = Effect.fn('PullRequests.connect')(function* (id: GroupId) {
        const entry = entries.get(id)

        if (!entry) return yield* new GroupNotFound()

        return yield* Effect.gen(function* () {
          if (entries.get(id) !== entry) return yield* new GroupNotFound()
          entry.invalidateContinuation()

          return yield* entry.repository.connectAuthentication()
        }).pipe(entry.gate.withPermits(1))
      })

      const resolve = Effect.fn('PullRequests.resolve')(function* (
        snapshot: GitContextSnapshot,
        selection: PullRequestSelection,
      ) {
        const provider = providers.find((provider) => provider.identity.id === selection.provider)

        if (!provider)
          return yield* new ReviewError({
            operation: 'resolve PR',
            message: 'The provider is no longer available. Refresh discovery.',
          })

        const matches = snapshot.remotes.flatMap((remote) => {
          const repository = provider.recognizeRemote(remote)

          return Option.isSome(repository) ? [new BoundRemote(remote, repository.value)] : []
        })

        const same = (left: RepositoryIdentity, right: RepositoryIdentity) =>
          left.authority === right.authority && left.key === right.key

        const target = matches.find((match) =>
          same(match.repository.identity, selection.repository),
        )

        if (!target)
          return yield* new ReviewError({
            operation: 'resolve PR',
            message:
              'The selected PR no longer belongs to this repository context. Refresh discovery.',
          })
        const pullRequest = yield* target.repository.getPullRequest(selection.id)

        if (
          !same(pullRequest.target.repository, selection.repository) ||
          pullRequest.id !== selection.id
        )
          return yield* new ReviewError({
            operation: 'resolve PR',
            message: 'Provider details do not match the selected PR.',
          })

        if (pullRequest.source._tag === 'Unavailable')
          return yield* new ReviewError({
            operation: 'resolve PR',
            message:
              'The PR source repository is unavailable. Check source access on the provider.',
          })

        const revision = Effect.fn('PullRequests.revision')(function* (
          repository: RepositoryIdentity,
          ref: OpenPullRequest['target']['ref'],
        ) {
          if (Option.isNone(ref.revision))
            return yield* new ReviewError({
              operation: 'resolve PR',
              message:
                'The provider has not supplied an exact source and target commit. Refresh later. Duff never substitutes HEAD or a merge commit.',
            })
          const match = matches.find((match) => same(match.repository.identity, repository))

          return ReviewRevision.make({
            commit: ref.revision.value.toLowerCase(),
            ref: ref.name,
            remote: match
              ? Option.some({ name: match.remote.name, destination: match.remote.destination })
              : Option.none(),
          })
        })

        const source = yield* revision(pullRequest.source.repository, pullRequest.source.ref)
        const base = yield* revision(pullRequest.target.repository, pullRequest.target.ref)

        return ResolvedPullRequest.make({
          pullRequest,
          revisions: ReviewRevisions.make({ source, target: base }),
        })
      })

      return PullRequests.of({ discover, loadMore, connect, resolve })
    }),
  )
