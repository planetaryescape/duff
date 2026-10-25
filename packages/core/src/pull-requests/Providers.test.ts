import { expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Redacted, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { type GitContextSnapshot } from '../git-context/GitContext'
import { ProviderAuthentication } from './ProviderAuthentication'
import { pullRequestsLayer } from './Providers'
import { PullRequests, PullRequestSelection } from './PullRequests'

it.effect(
  'built-ins reject redirects even when the caller supplies conflicting fetch defaults',
  () => {
    const fetch: typeof globalThis.fetch = (input, init) => {
      expect(init?.redirect).toBe('manual')
      const url = new URL(input instanceof Request ? input.url : String(input))

      if (url.hostname === 'api.github.com' && url.pathname === '/repos/owner/repo/pulls') {
        return Promise.resolve(
          Response.json([
            {
              number: 17,
              title: 'GitHub change',
              draft: true,
              state: 'open',
              merged_at: null,
              head: {
                ref: 'feature',
                sha: 'a'.repeat(40),
                repo: { owner: { login: 'fork' }, name: 'repo' },
              },
              base: {
                ref: 'main',
                sha: 'b'.repeat(40),
                repo: { owner: { login: 'owner' }, name: 'repo' },
              },
            },
          ]),
        )
      }

      if (url.hostname === 'dev.azure.com') {
        return Promise.resolve(
          Response.json({
            count: 1,
            value: [
              {
                pullRequestId: 29,
                title: 'Azure change',
                status: 'active',
                isDraft: false,
                sourceRefName: 'refs/heads/topic',
                targetRefName: 'refs/heads/main',
              },
            ],
          }),
        )
      }

      if (url.pathname === '/repos/owner/redirect/pulls') {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid' } }),
        )
      }

      return Promise.reject(new Error('Unexpected request'))
    }

    const destinations = [
      'https://github.com/owner/repo',
      'https://dev.azure.com/acme/Project/_git/Repo',
      'https://github.com/owner/redirect',
    ]

    const snapshot: GitContextSnapshot = {
      root: '/fixture',
      helpers: [],
      sshCommandConfigured: false,
      remotes: destinations.map((destination, index) => ({
        name: `remote-${index}`,
        destination,
        transport: 'https',
        credentials: { _tag: 'NotApplicable' },
      })),
    }

    return Effect.gen(function* () {
      const service = yield* PullRequests
      const events = yield* Stream.runCollect(service.discover(snapshot))

      const results = events
        .filter((event) => event._tag === 'Updated')
        .map((event) => event.result)

      expect(results).toHaveLength(3)
      const ready = results.filter((result) => result._tag === 'Ready')
      expect(
        ready
          .flatMap((result) => result.items.map((item) => [item.id, item.title, item.draft]))
          .sort(),
      ).toEqual([
        ['17', 'GitHub change', true],
        ['29', 'Azure change', false],
      ])
      expect(
        results.filter((result) => result._tag === 'Failed').map((result) => result.error._tag),
      ).toEqual(['ProviderRedirected'])
    }).pipe(
      Effect.provide(
        pullRequestsLayer.pipe(
          Layer.provide(
            Layer.succeed(ProviderAuthentication, {
              session: () =>
                Effect.succeed(
                  Option.some({
                    id: 'test-session',
                    token: Redacted.make('test-token'),
                    account: Option.some({ id: 'account', displayName: 'Test' }),
                  }),
                ),
            }),
          ),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'follow' }),
    )
  },
)

it.effect(
  'resolves fresh exact revisions for both providers and matches fork repository identities, not branch names',
  () => {
    let head = 'c'.repeat(40)
    let missingAzure = false

    const fetch: typeof globalThis.fetch = (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))

      if (url.hostname === 'api.github.com') {
        expect(url.pathname).toBe('/repos/owner/repo/pulls/17')

        return Promise.resolve(
          Response.json({
            number: 17,
            title: 'Fresh GitHub',
            draft: false,
            state: 'open',
            merged_at: null,
            head: { ref: 'topic', sha: head, repo: { owner: { login: 'fork' }, name: 'repo' } },
            base: {
              ref: 'topic',
              sha: 'b'.repeat(40),
              repo: { owner: { login: 'owner' }, name: 'repo' },
            },
          }),
        )
      }

      expect(url.pathname).toBe('/acme/Project/_apis/git/repositories/Repo/pullrequests/17')

      return Promise.resolve(
        Response.json({
          pullRequestId: 17,
          title: 'Fresh Azure',
          status: 'active',
          sourceRefName: 'refs/heads/topic',
          targetRefName: 'refs/heads/topic',
          lastMergeSourceCommit: missingAzure ? null : { commitId: head },
          lastMergeTargetCommit: { commitId: 'b'.repeat(40) },
          forkSource: { repository: { name: 'Fork', project: { name: 'Other' } } },
        }),
      )
    }

    const destinations = [
      'https://github.com/owner/repo',
      'https://github.com/fork/repo',
      'https://dev.azure.com/acme/Project/_git/Repo',
      'https://dev.azure.com/acme/Other/_git/Fork',
    ]

    const snapshot: GitContextSnapshot = {
      root: '/fixture',
      helpers: [],
      sshCommandConfigured: false,
      remotes: destinations.map((destination, index) => ({
        name: `remote-${index}`,
        destination,
        transport: 'https',
        credentials: { _tag: 'NotApplicable' },
      })),
    }

    return Effect.gen(function* () {
      const service = yield* PullRequests

      const github = PullRequestSelection.make({
        provider: 'github',
        repository: { authority: 'github.com', key: 'owner/repo', displayName: 'owner/repo' },
        id: '17',
        label: 'GitHub',
      })

      const azure = PullRequestSelection.make({
        provider: 'azure-devops',
        repository: {
          authority: 'dev.azure.com',
          key: 'acme/project/repo',
          displayName: 'acme/Project/Repo',
        },
        id: '17',
        label: 'Azure',
      })

      for (const [selection, remote] of [
        [github, 'remote-1'],
        [azure, 'remote-3'],
      ] as const) {
        const resolved = yield* service.resolve(snapshot, selection)
        expect(resolved.revisions.source.commit).toBe(head)
        expect(resolved.revisions.target.commit).toBe('b'.repeat(40))
        expect(Option.map(resolved.revisions.source.remote, (remote) => remote.name)).toEqual(
          Option.some(remote),
        )
        expect(resolved.revisions.source.ref).toBe(resolved.revisions.target.ref)
      }

      head = 'd'.repeat(40)
      expect((yield* service.resolve(snapshot, github)).revisions.source.commit).toBe(head)

      const unmatched = yield* service.resolve(
        {
          root: snapshot.root,
          helpers: snapshot.helpers,
          sshCommandConfigured: snapshot.sshCommandConfigured,
          remotes: snapshot.remotes.filter((remote) => remote.name !== 'remote-1'),
        },
        github,
      )

      expect(unmatched.revisions.source.remote).toEqual(Option.none())
      missingAzure = true
      const failure = yield* service.resolve(snapshot, azure).pipe(Effect.flip)
      expect(failure._tag).toBe('ReviewError')

      if (failure._tag === 'ReviewError')
        expect(failure.message).toContain('never substitutes HEAD')
    }).pipe(
      Effect.provide(
        pullRequestsLayer.pipe(
          Layer.provide(
            Layer.succeed(ProviderAuthentication, {
              session: () =>
                Effect.succeed(
                  Option.some({
                    id: 'fixture',
                    token: Redacted.make('fixture'),
                    account: Option.none(),
                  }),
                ),
            }),
          ),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    )
  },
)
