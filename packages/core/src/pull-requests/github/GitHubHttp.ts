import { createHash } from 'node:crypto'

import { Clock, DateTime, Effect, Option, Redacted, Schema } from 'effect'

import { HostedRepository } from '../../dashboard/Repositories'
import { RepositoryPage } from '../../dashboard/RepositoryDirectory'
import {
  Authentication,
  AuthenticationRequired,
  GitHubAuthenticationError,
  InvalidContinuation,
  InvalidProviderResponse,
  OpenPullRequest,
  PullRequestPage,
  type PullRequestState,
  RateLimited,
  GitHostingProvider,
  ProviderIdentity,
  ProviderRepository,
  RepositoryIdentity,
} from '../GitHostingProvider'
import { ProviderAuthentication } from '../ProviderAuthentication'
import { ProviderHttp } from '../ProviderHttp'

const Segment = Schema.String.check(Schema.isPattern(/^(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/))

const Repository = Schema.Struct({
  id: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  owner: Schema.Struct({ login: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)) }),
  name: Segment,
})

const Ref = Schema.Struct({
  ref: Schema.NonEmptyString,
  sha: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)),
  repo: Schema.NullOr(Repository),
})

const Cursor = Schema.fromJsonString(
  Schema.Struct({
    repository: Schema.String,
    query: Schema.Literals([
      'open/created/desc/30',
      'merged/created/desc/30',
      'closed/created/desc/30',
    ]),
    binding: Schema.String,
    page: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(1),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  }),
)

const PullRequests = Schema.Array(
  Schema.Struct({
    number: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
    title: Schema.String,
    draft: Schema.Boolean,
    state: Schema.Literals(['open', 'closed']),
    merged_at: Schema.NullOr(Schema.NonEmptyString),
    user: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.NonEmptyString }))),
    head: Ref,
    base: Ref,
  }),
)

function identity(owner: string, repo: string): RepositoryIdentity {
  return RepositoryIdentity.make({
    authority: 'github.com',
    key: `${owner}/${repo}`.toLowerCase(),
    displayName: `${owner}/${repo}`,
  })
}

function recognize(destination: string): Option.Option<RepositoryIdentity> {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|(?:git@)?github\.com:)([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      destination,
    )

  const owner = match?.[1]
  const repo = match?.[2]

  return owner && repo && repo !== '.' && repo !== '..'
    ? Option.some(identity(owner, repo))
    : Option.none()
}

function requestUrl(repository: RepositoryIdentity, page: number, state: PullRequestState): string {
  return `https://api.github.com/repos/${repository.key}/pulls?state=${state === 'open' ? 'open' : 'closed'}&sort=created&direction=desc&per_page=30&page=${page}`
}

const nextPage = Effect.fn('GitHub.nextPage')(function* (
  link: string | undefined,
  repository: RepositoryIdentity,
  page: number,
  state: PullRequestState,
  repositoryId: number | undefined,
) {
  if (link === undefined) return Option.none<number>()
  let next = Option.none<number>()

  for (const entry of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([a-z ]+)"\s*$/.exec(entry)

    if (!match?.[1] || !match[2]) return yield* new InvalidProviderResponse()

    if (!match[2].split(' ').includes('next')) continue

    if (Option.isSome(next)) return yield* new InvalidProviderResponse()

    const url = yield* Effect.try({
      try: () => new URL(match[1] ?? ''),
      catch: () => new InvalidProviderResponse(),
    })

    const rawPage = url.searchParams.get('page')
    const value = rawPage && /^[1-9][0-9]*$/.test(rawPage) ? Number(rawPage) : NaN

    if (!Number.isSafeInteger(value) || value <= page) return yield* new InvalidProviderResponse()
    const expected = new URL(requestUrl(repository, value, state))

    if (repositoryId !== undefined && url.pathname === `/repositories/${repositoryId}/pulls`)
      expected.pathname = url.pathname
    url.searchParams.sort()
    expected.searchParams.sort()

    if (url.href !== expected.href) return yield* new InvalidProviderResponse()
    next = Option.some(value)
  }

  return next
})

export const makeGitHubHttp = Effect.gen(function* (): Effect.gen.Return<
  GitHostingProvider,
  never,
  ProviderAuthentication | ProviderHttp
> {
  const auth = yield* ProviderAuthentication
  const http = yield* ProviderHttp
  let cooldown = 0

  const session = Effect.fn('GitHub.session')(function* (mode: 'silent' | 'connect') {
    return yield* auth.session('github', ['repo'], mode)
  })

  const authentication = Effect.fn('GitHub.authentication')(function* (mode: 'silent' | 'connect') {
    const current = yield* session(mode)

    if (Option.isSome(current) && current.value.source && current.value.source !== 'editor') {
      const source = current.value.source

      const response = yield* http
        .get('https://api.github.com/user', Option.some(current.value.token), {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'Duff',
        })
        .pipe(
          Effect.map(Option.some),
          Effect.catchTag('RepositoryUnavailable', () => Effect.succeed(Option.none())),
          Effect.mapError((error) => {
            if (error._tag === 'AuthenticationRequired')
              return new GitHubAuthenticationError({ source, reason: 'rejected' })

            if (error._tag === 'InvalidContinuation') return new InvalidProviderResponse()

            return error
          }),
        )

      if (Option.isNone(response))
        return Authentication.make({ _tag: 'Authenticated', source, account: Option.none() })

      const account = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          id: Schema.Int,
          login: Schema.NonEmptyString,
        }),
      )(response.value.body).pipe(Effect.mapError(() => new InvalidProviderResponse()))

      return Authentication.make({
        _tag: 'Authenticated',
        source,
        account: Option.some({ id: String(account.id), displayName: account.login }),
      })
    }

    return yield* Schema.decodeUnknownEffect(Authentication)(
      Option.isSome(current)
        ? {
            _tag: 'Authenticated',
            account: current.value.account,
            source: current.value.source ?? 'editor',
          }
        : { _tag: 'Unauthenticated' },
    ).pipe(Effect.mapError(() => new InvalidProviderResponse()))
  })

  const bind = (repository: RepositoryIdentity): ProviderRepository => {
    const read = Effect.fn('GitHub.readPullRequests')(function* (
      input: Parameters<ProviderRepository['listPullRequests']>[0],
      id?: string,
    ) {
      if (id !== undefined && !/^[1-9][0-9]*$/.test(id)) return yield* new InvalidProviderResponse()
      const current = yield* session('silent')
      const token = Option.map(current, (value) => value.token)

      const binding = Option.isSome(current)
        ? JSON.stringify([
            current.value.id,
            createHash('sha256').update(Redacted.value(current.value.token)).digest('hex'),
          ])
        : 'anonymous'

      let page = 1

      if (Option.isSome(input.cursor)) {
        const cursor = yield* Schema.decodeUnknownEffect(Cursor)(
          Redacted.value(input.cursor.value),
        ).pipe(Effect.mapError(() => new InvalidContinuation()))

        if (
          cursor.repository !== repository.key ||
          cursor.binding !== binding ||
          cursor.query !== `${input.state}/created/desc/30`
        )
          return yield* new InvalidContinuation()
        page = cursor.page
      }

      const now = yield* Clock.currentTimeMillis

      if (now < cooldown)
        return yield* new RateLimited({ retryAfterSeconds: Option.some((cooldown - now) / 1000) })

      const response = yield* http
        .get(
          id === undefined
            ? requestUrl(repository, page, input.state)
            : `https://api.github.com/repos/${repository.key}/pulls/${id}`,
          token,
          {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'Duff',
          },
        )
        .pipe(
          Effect.catchTags({
            AuthenticationRequired: (error) =>
              Option.match(
                Option.flatMap(current, (session) => Option.fromUndefinedOr(session.source)),
                {
                  onSome: (source) =>
                    Effect.fail(new GitHubAuthenticationError({ source, reason: 'rejected' })),
                  onNone: () => Effect.fail(error),
                },
              ),
            RepositoryUnavailable: (error) =>
              Option.match(current, {
                onNone: () => Effect.fail(new AuthenticationRequired()),
                onSome: (session) =>
                  Option.match(Option.fromUndefinedOr(session.source), {
                    onSome: (source) =>
                      Effect.fail(
                        new GitHubAuthenticationError({ source, reason: 'inaccessible' }),
                      ),
                    onNone: () => Effect.fail(error),
                  }),
              }),
          }),
          Effect.catchTag(
            'RateLimited',
            Effect.fn('GitHub.rateLimited')(function* (error) {
              if (Option.isSome(error.retryAfterSeconds))
                cooldown = (yield* Clock.currentTimeMillis) + error.retryAfterSeconds.value * 1000

              return yield* error
            }),
          ),
        )

      const delay = response.headers['retry-after']

      if (delay !== undefined) {
        const time = yield* Clock.currentTimeMillis

        const until = /^\d+$/.test(delay)
          ? time + Number(delay) * 1000
          : Option.getOrElse(Option.map(DateTime.make(delay), DateTime.toEpochMillis), () => NaN)

        if (Number.isFinite(until)) cooldown = Math.max(cooldown, until)
      }

      const decoded = yield* Schema.decodeUnknownEffect(PullRequests)(
        id === undefined ? response.body : [response.body],
      ).pipe(Effect.mapError(() => new InvalidProviderResponse()))

      const items = yield* Effect.forEach(
        decoded,
        Effect.fn('GitHub.pullRequest')(function* (pull) {
          if (id !== undefined && String(pull.number) !== id)
            return yield* new InvalidProviderResponse()

          if (pull.state === 'open' && pull.merged_at !== null)
            return yield* new InvalidProviderResponse()

          if (
            !pull.base.repo ||
            `${pull.base.repo.owner.login}/${pull.base.repo.name}`.toLowerCase() !==
              repository.key.toLowerCase()
          ) {
            return yield* new InvalidProviderResponse()
          }

          return yield* Schema.decodeUnknownEffect(OpenPullRequest)({
            id: String(pull.number),
            title: pull.title,
            author: pull.user?.login,
            draft: pull.draft,
            state: pull.merged_at !== null ? 'merged' : pull.state,
            url: `https://github.com/${repository.key}/pull/${pull.number}`,
            source: pull.head.repo
              ? {
                  _tag: 'Available',
                  repository: identity(pull.head.repo.owner.login, pull.head.repo.name),
                  ref: {
                    name: `refs/heads/${pull.head.ref}`,
                    revision: Option.some(pull.head.sha),
                  },
                }
              : { _tag: 'Unavailable' },
            target: {
              repository,
              ref: { name: `refs/heads/${pull.base.ref}`, revision: Option.some(pull.base.sha) },
            },
          }).pipe(Effect.mapError(() => new InvalidProviderResponse()))
        }),
      )

      const next =
        id === undefined
          ? yield* nextPage(
              response.headers.link,
              repository,
              page,
              input.state,
              decoded[0]?.base.repo?.id,
            )
          : Option.none<number>()

      return yield* Schema.decodeUnknownEffect(PullRequestPage)({
        items: id === undefined ? items.filter((pull) => pull.state === input.state) : items,
        next: Option.map(next, (value) => {
          const cursor = JSON.stringify({
            repository: repository.key,
            query: `${input.state}/created/desc/30`,
            binding,
            page: value,
          })

          return Redacted.make(cursor)
        }),
      }).pipe(Effect.mapError(() => new InvalidProviderResponse()))
    })

    return ProviderRepository.of({
      identity: repository,
      inspectAuthentication: () => authentication('silent'),
      connectAuthentication: () => authentication('connect'),
      listPullRequests: (input) => read(input),
      getPullRequest: Effect.fn('GitHub.getPullRequest')(function* (id) {
        const page = yield* read({ scope: 'repository', state: 'open', cursor: Option.none() }, id)
        const pull = page.items[0]

        if (!pull) return yield* new InvalidProviderResponse()

        return pull
      }),
    })
  }

  const providerIdentity = ProviderIdentity.make({
    id: 'github',
    displayName: 'GitHub',
    authenticationSource: 'github',
  })

  const destination = (repository: RepositoryIdentity): Option.Option<string> => {
    const url = `https://github.com/${repository.key}.git`

    return Option.filter(
      Option.map(recognize(url), () => url),
      () =>
        repository.authority === 'github.com' &&
        Option.exists(recognize(url), (parsed) => parsed.key === repository.key),
    )
  }

  return GitHostingProvider.of({
    identity: providerIdentity,
    destination,
    browsingScope: (repository) =>
      Option.isSome(destination(repository)) ? (repository.key.split('/')[0] ?? '') : '',
    browseRepositories: Effect.fn('GitHub.browseRepositories')(function* (scope, page, mode) {
      if (!Number.isSafeInteger(page) || page < 1) return yield* new InvalidContinuation()

      if (scope !== '' && !/^[a-zA-Z0-9_-]+$/.test(scope))
        return yield* new InvalidProviderResponse()
      const current = yield* session(mode)

      if (scope === '' && Option.isNone(current)) return yield* new AuthenticationRequired()
      const token = Option.map(current, (value) => value.token)

      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'Duff',
      }

      let path = '/user/repos'

      if (scope !== '') {
        const response = yield* http.get(`https://api.github.com/users/${scope}`, token, headers)

        const owner = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ type: Schema.Literals(['User', 'Organization']) }),
        )(response.body).pipe(Effect.mapError(() => new InvalidProviderResponse()))

        path = owner.type === 'Organization' ? `/orgs/${scope}/repos` : `/users/${scope}/repos`
      }

      const response = yield* http.get(
        `https://api.github.com${path}?sort=full_name&direction=asc&per_page=30&page=${page}`,
        token,
        headers,
      )

      const repositories = yield* Schema.decodeUnknownEffect(Schema.Array(Repository))(
        response.body,
      ).pipe(Effect.mapError(() => new InvalidProviderResponse()))

      if (repositories.length > 30) return yield* new InvalidProviderResponse()

      return RepositoryPage.make({
        items: repositories.map((repository) => {
          const repositoryIdentity = identity(repository.owner.login, repository.name)

          return HostedRepository.make({
            provider: providerIdentity,
            repository: repositoryIdentity,
            cloneUrl: `https://github.com/${repositoryIdentity.key}.git`,
          })
        }),
        hasMore: /;\s*rel="[^"]*\bnext\b[^"]*"/.test(response.headers.link ?? ''),
      })
    }),
    recognizeRemote: (remote) => Option.map(recognize(remote.destination), bind),
  })
})
