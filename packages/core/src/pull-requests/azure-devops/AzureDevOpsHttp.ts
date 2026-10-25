import { createHash, randomUUID } from 'node:crypto'

import { Cache, Clock, DateTime, Effect, Option, Redacted, Schema } from 'effect'

import { HostedRepository } from '../../dashboard/Repositories'
import { RepositoryPage } from '../../dashboard/RepositoryDirectory'
import {
  Authentication,
  AuthenticationRequired,
  AvatarImage,
  ChangeCount,
  type ChangeStatistics,
  type ComparisonIdentity,
  type DiscoveryError,
  GitHostingProvider,
  InvalidContinuation,
  InvalidProviderResponse,
  OpenPullRequest,
  ProviderIdentity,
  ProviderRepository,
  PullRequestDetails,
  PullRequestPage,
  type PullRequestState,
  RateLimited,
  RepositoryIdentity,
} from '../GitHostingProvider'
import { ProviderAuthentication } from '../ProviderAuthentication'
import { ProviderHttp, type ProviderResponse } from '../ProviderHttp'
import { azureStatistics } from './AzureStatistics'

const scopes = ['499b84ac-1321-427f-aa17-267ca6975798/user_impersonation']

const Segment = Schema.NonEmptyString.check(Schema.isPattern(/^[^/\\?#\x00-\x1f]+$/))

const Address = Schema.Struct({ org: Segment, project: Segment, repo: Segment })

type Address = Schema.Schema.Type<typeof Address>

const Revision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i))

const Commit = Schema.NullOr(Schema.Struct({ commitId: Revision }))

const ForkRepository = Schema.Struct({
  name: Segment,
  project: Schema.Struct({ name: Segment }),
  remoteUrl: Schema.optional(Schema.String),
})

const WirePullRequest = Schema.Struct({
  pullRequestId: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdBy: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        displayName: Schema.optionalKey(Schema.NonEmptyString),
        _links: Schema.optionalKey(Schema.Unknown),
        imageUrl: Schema.optionalKey(Schema.Unknown),
      }),
    ),
  ),
  status: Schema.Literals(['active', 'completed', 'abandoned']),
  isDraft: Schema.optional(Schema.Boolean),
  sourceRefName: OpenPullRequest.fields.target.fields.ref.fields.name,
  targetRefName: OpenPullRequest.fields.target.fields.ref.fields.name,
  lastMergeSourceCommit: Schema.optional(Commit),
  lastMergeTargetCommit: Schema.optional(Commit),
  forkSource: Schema.optional(
    Schema.NullOr(Schema.Struct({ repository: Schema.optional(Schema.Unknown) })),
  ),
})

const WirePage = Schema.Struct({
  value: Schema.Array(WirePullRequest),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

const ReadResult = Schema.Struct({ page: PullRequestPage, description: Schema.String })

const Iterations = Schema.Struct({
  value: Schema.Array(Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)) })),
})

const Changes = Schema.Struct({
  changeEntries: Schema.Array(
    Schema.Struct({
      item: Schema.Struct({
        path: Schema.NonEmptyString,
        isFolder: Schema.optionalKey(Schema.Boolean),
      }),
    }),
  ),
  nextSkip: Schema.optionalKey(ChangeCount),
  nextTop: Schema.optionalKey(ChangeCount),
})

// Only org-bound identity image routes are authorized, never Graph or arbitrary links.
function avatarDestination(value: string, org: string): Option.Option<string> {
  const match =
    /^https:\/\/(?:dev\.azure\.com\/([^/]+)|([a-z0-9-]+)\.visualstudio\.com)\/(?:_apis\/Identities\/([^/]+)\/avatar|_api\/_common\/identityImage\?id=([^&]+))$/i.exec(
      value,
    )

  if (!match || (match[1] ?? match[2])?.toLowerCase() !== org.toLowerCase()) return Option.none()
  const id = match[3] ?? match[4]

  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
    return Option.none()

  const route = match[3]
    ? `_apis/Identities/${id.toLowerCase()}/avatar`
    : `_api/_common/identityImage?id=${id.toLowerCase()}`

  return Option.some(`https://dev.azure.com/${encodeURIComponent(org)}/${route}`)
}

const statusByState = {
  open: 'active',
  merged: 'completed',
  closed: 'abandoned',
} satisfies Record<PullRequestState, string>

const stateByStatus = {
  active: 'open',
  completed: 'merged',
  abandoned: 'closed',
} satisfies Record<Schema.Schema.Type<typeof WirePullRequest>['status'], PullRequestState>

function parseRemote(destination: string): Option.Option<Address> {
  const modern = /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/?$/i.exec(
    destination,
  )

  const legacy = /^https:\/\/([a-z0-9-]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/?$/i.exec(
    destination,
  )

  const ssh =
    /^(?:ssh\.dev\.azure\.com:v3\/|ssh:\/\/ssh\.dev\.azure\.com\/v3\/)([^/]+)\/([^/]+)\/([^/]+)\/?$/i.exec(
      destination,
    )

  const match = modern ?? legacy ?? ssh

  if (!match) return Option.none()

  try {
    const org = decodeURIComponent(match[1] ?? '').toLowerCase()
    const project = decodeURIComponent(match[2] ?? '')
    const repo = decodeURIComponent(match[3] ?? '')

    if ([org, project, repo].some((part) => part === '.' || part === '..')) return Option.none()

    return Schema.decodeUnknownOption(Address)({ org, project, repo })
  } catch {
    return Option.none()
  }
}

function identity(address: Address): RepositoryIdentity {
  return RepositoryIdentity.make({
    authority: 'dev.azure.com',
    key: [address.org, address.project, address.repo]
      .map((part) => encodeURIComponent(part.toLowerCase()))
      .join('/'),
    displayName: `${address.org}/${address.project}/${address.repo}`,
  })
}

function repositoryUrl(address: Address): string {
  return `https://dev.azure.com/${encodeURIComponent(address.org)}/${encodeURIComponent(address.project)}/_git/${encodeURIComponent(address.repo)}`
}

export const makeAzureDevOpsHttp = Effect.gen(function* (): Effect.gen.Return<
  GitHostingProvider,
  never,
  ProviderAuthentication | ProviderHttp
> {
  const authentication = yield* ProviderAuthentication
  const http = yield* ProviderHttp

  const completed = yield* Cache.make<string, ChangeStatistics>({
    capacity: 100,
    lookup: () => Effect.die(new Error('Completed comparison missing.')),
  })

  const comparisonKey = (value: ComparisonIdentity) =>
    JSON.stringify([
      value.providerId,
      value.authority,
      value.targetRepository.authority,
      value.targetRepository.key,
      value.sourceRepository.authority,
      value.sourceRepository.key,
      value.pullRequestId,
      value.targetRevision,
      value.sourceRevision,
      value.baseRevision,
      value.mode,
    ])

  const continuations = new Map<
    string,
    {
      readonly key: string
      readonly session: string
      readonly skip: number
      readonly state: PullRequestState
    }
  >()

  const cooldowns = new Map<string, number>()
  const avatars = new Map<string, string>()
  const avatarKeys = new Map<string, string>()

  const recognizeRemote: GitHostingProvider['recognizeRemote'] = (remote) =>
    Option.map(parseRemote(remote.destination), (address) => {
      const boundIdentity = identity(address)
      const continuationOwner = JSON.stringify([remote.name, boundIdentity.key])
      const endpoint = `https://dev.azure.com/${encodeURIComponent(address.org)}/${encodeURIComponent(address.project)}/_apis/git/repositories/${encodeURIComponent(address.repo)}/pullrequests`

      const avatarKey = (author: Schema.Schema.Type<typeof WirePullRequest>['createdBy']) => {
        const links = Schema.decodeUnknownOption(
          Schema.Struct({ avatar: Schema.Struct({ href: Schema.String }) }),
        )(author?.['_links'])

        const preferred = Option.flatMap(links, (value) =>
          avatarDestination(value.avatar.href, address.org),
        )

        const destination = Option.orElse(preferred, () =>
          Option.flatMap(Schema.decodeUnknownOption(Schema.String)(author?.imageUrl), (url) =>
            avatarDestination(url, address.org),
          ),
        )

        return Option.getOrUndefined(
          Option.map(destination, (url) => {
            const owner = JSON.stringify([boundIdentity.key, url])
            const existing = avatarKeys.get(owner)

            if (existing !== undefined) return existing
            const key = randomUUID()
            avatarKeys.set(owner, key)
            avatars.set(JSON.stringify([boundIdentity.key, key]), url)

            return key
          }),
        )
      }

      const inspect = Effect.fn('AzureDevOps.inspectAuthentication')(function* (
        mode: 'silent' | 'connect',
      ) {
        const session = yield* authentication.session('microsoft', scopes, mode)

        return yield* Schema.decodeUnknownEffect(Authentication)(
          Option.isSome(session)
            ? { _tag: 'Authenticated', account: session.value.account }
            : { _tag: 'Unauthenticated' },
        ).pipe(Effect.mapError(() => new InvalidProviderResponse()))
      })

      const read = Effect.fn('AzureDevOps.readPullRequests')(function* (
        input: Parameters<ProviderRepository['listPullRequests']>[0],
        id?: string,
      ) {
        if (id !== undefined && !/^[1-9][0-9]*$/.test(id))
          return yield* new InvalidProviderResponse()
        const session = yield* authentication.session('microsoft', scopes, 'silent')

        if (Option.isNone(session)) return yield* new AuthenticationRequired()

        const sessionKey = createHash('sha256')
          .update(
            JSON.stringify([
              session.value.id,
              Option.map(session.value.account, (account) => account.id),
              Redacted.value(session.value.token),
            ]),
          )
          .digest('hex')

        let skip = 0

        if (Option.isSome(input.cursor)) {
          const continuation = continuations.get(continuationOwner)

          if (
            !continuation ||
            continuation.key !== Redacted.value(input.cursor.value) ||
            continuation.session !== sessionKey ||
            continuation.state !== input.state
          ) {
            return yield* new InvalidContinuation()
          }

          skip = continuation.skip
        } else if (id === undefined) continuations.delete(continuationOwner)
        const now = yield* Clock.currentTimeMillis
        const cooldown = cooldowns.get(boundIdentity.key) ?? 0

        if (cooldown > now)
          return yield* new RateLimited({ retryAfterSeconds: Option.some((cooldown - now) / 1000) })

        const url =
          id === undefined
            ? `${endpoint}?searchCriteria.status=${statusByState[input.state]}&$top=50&$skip=${skip}&api-version=7.1`
            : `${endpoint}/${id}?api-version=7.1`

        const response = yield* http.get(url, Option.some(session.value.token)).pipe(
          Effect.tapError(
            Effect.fn('AzureDevOps.recordRateLimit')(function* (error) {
              if (error._tag === 'RateLimited' && Option.isSome(error.retryAfterSeconds)) {
                cooldowns.set(
                  boundIdentity.key,
                  (yield* Clock.currentTimeMillis) + error.retryAfterSeconds.value * 1000,
                )
              }
            }),
          ),
        )

        const delay = response.headers['retry-after']

        if (delay !== undefined) {
          const received = yield* Clock.currentTimeMillis

          const seconds = /^\d+$/.test(delay)
            ? Number(delay)
            : Option.getOrElse(
                Option.map(
                  DateTime.make(delay),
                  (time) => (DateTime.toEpochMillis(time) - received) / 1000,
                ),
                () => NaN,
              )

          if (Number.isFinite(seconds) && seconds > 0)
            cooldowns.set(boundIdentity.key, received + seconds * 1000)
        }

        const page = yield* Schema.decodeUnknownEffect(WirePage)(
          id === undefined ? response.body : { count: 1, value: [response.body] },
        ).pipe(Effect.mapError(() => new InvalidProviderResponse()))

        if (page.count !== page.value.length || page.value.length > 50)
          return yield* new InvalidProviderResponse()

        const items = yield* Effect.forEach(
          page.value,
          Effect.fn('AzureDevOps.normalizePullRequest')(function* (pr) {
            if (id !== undefined && String(pr.pullRequestId) !== id)
              return yield* new InvalidProviderResponse()

            if (id === undefined && stateByStatus[pr.status] !== input.state)
              return yield* new InvalidProviderResponse()
            let sourceRepository: Option.Option<RepositoryIdentity> = Option.some(boundIdentity)

            if (pr.forkSource !== undefined) {
              const fork = Schema.decodeUnknownOption(ForkRepository)(pr.forkSource?.repository)
              sourceRepository = Option.flatMap(fork, (repository) =>
                repository.remoteUrl !== undefined
                  ? Option.map(parseRemote(repository.remoteUrl), identity)
                  : Option.some(
                      identity({
                        org: address.org,
                        project: repository.project.name,
                        repo: repository.name,
                      }),
                    ),
              )
            }

            return yield* Schema.decodeUnknownEffect(OpenPullRequest)({
              id: String(pr.pullRequestId),
              title: pr.title,
              author: pr.createdBy?.displayName,
              authorAvatarKey: avatarKey(pr.createdBy),
              state: stateByStatus[pr.status],
              url: `${repositoryUrl(address)}/pullrequest/${pr.pullRequestId}`,
              draft: pr.isDraft ?? false,
              source: Option.isSome(sourceRepository)
                ? {
                    _tag: 'Available',
                    repository: sourceRepository.value,
                    ref: {
                      name: pr.sourceRefName,
                      revision: Option.fromNullishOr(pr.lastMergeSourceCommit?.commitId),
                    },
                  }
                : { _tag: 'Unavailable' },
              target: {
                repository: boundIdentity,
                ref: {
                  name: pr.targetRefName,
                  revision: Option.fromNullishOr(pr.lastMergeTargetCommit?.commitId),
                },
              },
            }).pipe(Effect.mapError(() => new InvalidProviderResponse()))
          }),
        )

        if (id === undefined) continuations.delete(continuationOwner)
        let next: Option.Option<Redacted.Redacted> = Option.none()

        if (id === undefined && page.value.length === 50) {
          const key = randomUUID()
          continuations.set(continuationOwner, {
            key,
            session: sessionKey,
            skip: skip + 50,
            state: input.state,
          })
          next = Option.some(Redacted.make(key))
        }

        return ReadResult.make({
          page: PullRequestPage.make({ items, next }),
          description: page.value[0]?.description ?? '',
        })
      })

      const fileCount = Effect.fn('AzureDevOps.fileCount')(function* (id: string) {
        const session = yield* authentication.session('microsoft', scopes, 'silent')

        if (Option.isNone(session)) return yield* new AuthenticationRequired()
        const token = Option.some(session.value.token)
        const response = yield* http.get(`${endpoint}/${id}/iterations?api-version=7.1`, token)

        const iterations = yield* Schema.decodeUnknownEffect(Iterations)(response.body).pipe(
          Effect.mapError(() => new InvalidProviderResponse()),
        )

        const latest = Math.max(...iterations.value.map((iteration) => iteration.id))

        if (!Number.isSafeInteger(latest)) return yield* new InvalidProviderResponse()
        let skip = 0
        let top = 2000
        const paths = new Set<string>()

        while (true) {
          const response = yield* http.get(
            `${endpoint}/${id}/iterations/${latest}/changes?$compareTo=0&$top=${top}&$skip=${skip}&api-version=7.1`,
            token,
          )

          const changes = yield* Schema.decodeUnknownEffect(Changes)(response.body).pipe(
            Effect.mapError(() => new InvalidProviderResponse()),
          )

          if (changes.changeEntries.length > top) return yield* new InvalidProviderResponse()

          for (const change of changes.changeEntries) {
            if (change.item.isFolder !== true) paths.add(change.item.path)
          }

          // Azure omits paging fields on terminal pages. A full page alone proves no total.
          if (changes.nextSkip === undefined && changes.nextTop === undefined) {
            if (changes.changeEntries.length < top) return paths.size

            return yield* new InvalidProviderResponse()
          }

          if (changes.nextSkip === 0 && changes.nextTop === 0) return paths.size

          if (
            changes.nextSkip === undefined ||
            changes.nextTop === undefined ||
            changes.nextSkip <= skip ||
            changes.nextTop === 0 ||
            changes.nextTop > 2000
          )
            return yield* new InvalidProviderResponse()
          skip = changes.nextSkip
          top = changes.nextTop
        }
      })

      return ProviderRepository.of({
        identity: boundIdentity,
        inspectAuthentication: () => inspect('silent'),
        connectAuthentication: () => inspect('connect'),
        listPullRequests: (input) => read(input).pipe(Effect.map((result) => result.page)),
        getPullRequestStatistics: Effect.fn('AzureDevOps.getPullRequestStatistics')(
          function* (expected) {
            if (
              expected.target.repository.key !== boundIdentity.key ||
              !/^[1-9][0-9]*$/.test(expected.id)
            )
              return yield* new InvalidProviderResponse()
            const session = yield* authentication.session('microsoft', scopes, 'silent')

            if (Option.isNone(session)) return yield* new AuthenticationRequired()

            const guarded = Effect.fn('AzureDevOps.statisticsRequest')(function* (
              request: Effect.Effect<ProviderResponse, DiscoveryError>,
            ) {
              const now = yield* Clock.currentTimeMillis
              const cooldown = cooldowns.get(boundIdentity.key) ?? 0

              if (cooldown > now)
                return yield* new RateLimited({
                  retryAfterSeconds: Option.some((cooldown - now) / 1000),
                })

              return yield* request.pipe(
                Effect.tapError(
                  Effect.fn('AzureDevOps.statisticsRateLimit')(function* (error) {
                    if (error._tag === 'RateLimited' && Option.isSome(error.retryAfterSeconds))
                      cooldowns.set(
                        boundIdentity.key,
                        (yield* Clock.currentTimeMillis) + error.retryAfterSeconds.value * 1000,
                      )
                  }),
                ),
              )
            })

            const post = http.post

            return yield* azureStatistics(
              {
                get: (url, token, headers, format, maxResponseBytes) =>
                  guarded(http.get(url, token, headers, format, maxResponseBytes)),
                post: (url, token, body) => guarded(post(url, token, body)),
              },
              Option.some(session.value.token),
              endpoint,
              expected,
              {
                get: (comparison) => Cache.getOption(completed, comparisonKey(comparison)),
                set: (value) => Cache.set(completed, comparisonKey(value.comparison), value),
              },
            )
          },
        ),
        getPullRequestMetadata: Effect.fn('AzureDevOps.getPullRequestMetadata')(function* (id) {
          const result = yield* read(
            { scope: 'repository', state: 'open', cursor: Option.none() },
            id,
          )

          const pullRequest = result.page.items[0]

          if (!pullRequest) return yield* new InvalidProviderResponse()

          return PullRequestDetails.make({
            pullRequest,
            description: result.description,
            filesChanged: Option.none(),
            linesChanged: Option.none(),
          })
        }),
        getPullRequestDetails: Effect.fn('AzureDevOps.getPullRequestDetails')(function* (id) {
          const result = yield* read(
            { scope: 'repository', state: 'open', cursor: Option.none() },
            id,
          )

          const pullRequest = result.page.items[0]

          if (!pullRequest) return yield* new InvalidProviderResponse()
          // Statistics are optional; a failed page discards the whole count, not the description.
          const filesChanged = yield* fileCount(id).pipe(Effect.option)

          return PullRequestDetails.make({
            pullRequest,
            description: result.description,
            filesChanged,
            linesChanged: Option.none(),
          })
        }),
        getAvatar: Effect.fn('AzureDevOps.getAvatar')(function* (key) {
          const url = avatars.get(JSON.stringify([boundIdentity.key, key]))

          if (url === undefined) return Option.none()
          const session = yield* authentication.session('microsoft', scopes, 'silent')

          if (Option.isNone(session)) return Option.none()
          const response = yield* http.get(url, Option.some(session.value.token), {}, 'image')

          return Schema.decodeUnknownOption(AvatarImage)(response.body)
        }),
        getPullRequest: Effect.fn('AzureDevOps.getPullRequest')(function* (id) {
          const result = yield* read(
            { scope: 'repository', state: 'open', cursor: Option.none() },
            id,
          )

          const pull = result.page.items[0]

          if (!pull) return yield* new InvalidProviderResponse()

          return pull
        }),
      })
    })

  const providerIdentity = ProviderIdentity.make({
    id: 'azure-devops',
    displayName: 'Azure DevOps',
    authenticationSource: 'azure-cli',
  })

  return GitHostingProvider.of({
    identity: providerIdentity,
    browsingScope: (repository) => {
      const [org, project, repo] = repository.key.split('/')

      if (!org || !project || !repo || repository.authority !== 'dev.azure.com') return ''

      return Option.match(parseRemote(`https://dev.azure.com/${org}/${project}/_git/${repo}`), {
        onNone: () => '',
        onSome: (address) => `${address.org}/${address.project}`,
      })
    },
    destination: (repository) => {
      const [org, project, repo] = repository.key.split('/')

      if (!org || !project || !repo || repository.authority !== 'dev.azure.com')
        return Option.none()

      return Option.flatMap(
        parseRemote(`https://dev.azure.com/${org}/${project}/_git/${repo}`),
        (address) =>
          identity(address).key === repository.key
            ? Option.some(repositoryUrl(address))
            : Option.none(),
      )
    },
    browseRepositories: Effect.fn('AzureDevOps.browseRepositories')(function* (scope, page, mode) {
      if (!Number.isSafeInteger(page) || page < 1) return yield* new InvalidContinuation()
      const parts = scope.split('/')

      const parsed = yield* Schema.decodeUnknownEffect(Schema.Array(Segment))(parts).pipe(
        Effect.mapError(() => new InvalidProviderResponse()),
      )

      const org = parsed[0]
      const project = parsed[1]

      if (!org || parsed.length > 2 || parsed.some((part) => part === '.' || part === '..'))
        return yield* new InvalidProviderResponse()
      const session = yield* authentication.session('microsoft', scopes, mode)

      if (Option.isNone(session)) return yield* new AuthenticationRequired()
      const path = [org, ...(project ? [project] : [])].map(encodeURIComponent).join('/')

      // Git repositories/list has no server pagination parameters. Page the decoded collection.
      const response = yield* http.get(
        `https://dev.azure.com/${path}/_apis/git/repositories?api-version=7.1`,
        Option.some(session.value.token),
      )

      const repositories = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          value: Schema.Array(
            Schema.Struct({
              name: Segment,
              project: Schema.Struct({ name: Segment }),
            }),
          ),
        }),
      )(response.body).pipe(Effect.mapError(() => new InvalidProviderResponse()))

      if (repositories.count !== repositories.value.length)
        return yield* new InvalidProviderResponse()

      const items = yield* Effect.forEach(
        repositories.value,
        Effect.fn('AzureDevOps.repository')(function* (repository) {
          const address = { org, project: repository.project.name, repo: repository.name }
          const cloneUrl = repositoryUrl(address)

          if (Option.isNone(parseRemote(cloneUrl))) return yield* new InvalidProviderResponse()

          if (project && project.toLowerCase() !== repository.project.name.toLowerCase())
            return yield* new InvalidProviderResponse()

          return HostedRepository.make({
            provider: providerIdentity,
            repository: identity(address),
            cloneUrl,
          })
        }),
      )

      items.sort((left, right) => left.repository.key.localeCompare(right.repository.key))
      const offset = (page - 1) * 50

      return RepositoryPage.make({
        items: items.slice(offset, offset + 50),
        hasMore: offset + 50 < items.length,
      })
    }),
    recognizeRemote,
  })
})
