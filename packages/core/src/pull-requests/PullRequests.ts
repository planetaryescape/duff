import { Context, Effect, Layer, Option, Redacted, Ref, Schema, Semaphore, Stream } from 'effect'

import { type GitContextSnapshot } from '../git-context/GitContext'
import {
  type Authentication,
  type AuthenticationError,
  type DiscoveryError,
  type GitHostingProvider,
  InvalidContinuation,
  type OpenPullRequest,
  type ProviderIdentity,
  type ProviderRepository,
  type Remote,
  type RepositoryIdentity,
} from './GitHostingProvider'

export const GroupId = Schema.NonEmptyString.pipe(Schema.brand('RepositoryGroupId'))

export type GroupId = Schema.Schema.Type<typeof GroupId>

export interface RepositoryGroup {
  readonly id: GroupId
  readonly key: string
  readonly provider: ProviderIdentity
  readonly repository: RepositoryIdentity
  readonly remoteNames: ReadonlyArray<string>
}

export type DiscoveryNotice =
  | { readonly _tag: 'Unsupported'; readonly remote: Remote }
  | {
      readonly _tag: 'Ambiguous'
      readonly remote: Remote
      readonly candidates: ReadonlyArray<ProviderIdentity>
    }

export type GroupResult =
  | {
      readonly _tag: 'Ready'
      readonly group: RepositoryGroup
      readonly authentication: Authentication
      readonly items: ReadonlyArray<OpenPullRequest>
      readonly hasMore: boolean
    }
  | { readonly _tag: 'Failed'; readonly group: RepositoryGroup; readonly error: DiscoveryError }

export type DiscoveryEvent =
  | {
      readonly _tag: 'Started'
      readonly groups: ReadonlyArray<RepositoryGroup>
      readonly notices: ReadonlyArray<DiscoveryNotice>
    }
  | { readonly _tag: 'Updated'; readonly result: GroupResult }

export class GroupNotFound extends Schema.TaggedError<GroupNotFound>()('GroupNotFound', {}) {}

/**
 * Owns continuation safety: same-group reads and connections queue, while different groups run
 * independently. ReviewSession owns action suppression and discovery-job cancellation.
 */
export class PullRequests extends Context.Service<
  PullRequests,
  {
    readonly discover: (snapshot: GitContextSnapshot) => Stream.Stream<DiscoveryEvent>
    readonly loadMore: (id: GroupId) => Effect.Effect<GroupResult, GroupNotFound>
    readonly connect: (
      id: GroupId,
    ) => Effect.Effect<Authentication, AuthenticationError | GroupNotFound>
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

      interface Entry {
        group: RepositoryGroup
        readonly repository: ProviderRepository
        readonly gate: Semaphore.Semaphore
        cursor: Option.Option<Redacted.Redacted>
        readonly seen: Set<string>
      }

      let entries = new Map<GroupId, Entry>()

      const read = Effect.fn('PullRequests.read')(function* (
        entry: Entry,
        more: boolean,
      ): Effect.fn.Return<GroupResult> {
        const cursor = more ? entry.cursor : Option.none<Redacted.Redacted>()

        if (more && Option.isNone(cursor))
          return { _tag: 'Failed', group: entry.group, error: new InvalidContinuation() }

        const result = yield* Effect.result(
          Effect.gen(function* () {
            const authentication = yield* entry.repository.inspectAuthentication()

            const page = yield* entry.repository.listOpenPullRequests({
              scope: 'repository',
              cursor,
            })

            if (Option.isSome(page.next) && entry.seen.has(Redacted.value(page.next.value)))
              return yield* new InvalidContinuation()

            return { authentication, page }
          }),
        )

        if (result._tag === 'Failure') {
          if (['AuthenticationRequired', 'InvalidContinuation'].includes(result.failure._tag))
            entry.cursor = Option.none()

          return { _tag: 'Failed', group: entry.group, error: result.failure }
        }

        entry.cursor = result.success.page.next

        if (Option.isSome(entry.cursor)) entry.seen.add(Redacted.value(entry.cursor.value))

        return {
          _tag: 'Ready',
          group: entry.group,
          authentication: result.success.authentication,
          items: result.success.page.items,
          hasMore: Option.isSome(entry.cursor),
        }
      })

      const discover = (snapshot: GitContextSnapshot): Stream.Stream<DiscoveryEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const currentGeneration = yield* Ref.updateAndGet(generation, (value) => value + 1)
            const grouped = new Map<string, Entry>()
            const notices: DiscoveryNotice[] = []

            for (const remote of snapshot.remotes) {
              const matches = providers.flatMap((provider) => {
                const repository = provider.recognizeRemote(remote)

                return Option.isSome(repository) ? [{ provider, repository: repository.value }] : []
              })

              const match = matches[0]

              if (!match) {
                notices.push({ _tag: 'Unsupported', remote })
                continue
              }

              if (matches.length > 1) {
                notices.push({
                  _tag: 'Ambiguous',
                  remote,
                  candidates: matches.map((match) => match.provider.identity),
                })
                continue
              }

              const key = JSON.stringify([
                match.provider.identity.id,
                match.repository.identity.authority,
                match.repository.identity.key,
              ])

              const existing = grouped.get(key)

              if (existing)
                existing.group = {
                  ...existing.group,
                  remoteNames: [...existing.group.remoteNames, remote.name],
                }
              else
                grouped.set(key, {
                  group: {
                    id: GroupId.make(`${currentGeneration}:${key}`),
                    key,
                    provider: match.provider.identity,
                    repository: match.repository.identity,
                    remoteNames: [remote.name],
                  },
                  repository: match.repository,
                  gate: yield* Semaphore.make(1),
                  cursor: Option.none(),
                  seen: new Set(),
                })
            }

            entries = new Map([...grouped.values()].map((entry) => [entry.group.id, entry]))

            const started: DiscoveryEvent = {
              _tag: 'Started',
              groups: [...grouped.values()].map((entry) => entry.group),
              notices,
            }

            return Stream.make(started).pipe(
              Stream.concat(
                Stream.fromIterable(grouped.values()).pipe(
                  Stream.mapEffect(
                    (entry) =>
                      read(entry, false).pipe(
                        entry.gate.withPermits(1),
                        Effect.map((result): DiscoveryEvent => ({ _tag: 'Updated', result })),
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
          entry.cursor = Option.none()

          return yield* entry.repository.connectAuthentication()
        }).pipe(entry.gate.withPermits(1))
      })

      return PullRequests.of({ discover, loadMore, connect })
    }),
  )
