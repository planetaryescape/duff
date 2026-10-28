import { Script } from 'node:vm'

import { WatchedRepository } from '@duff/core/dashboard-repositories'
import { OpenPullRequest, PullRequestDetails } from '@duff/core/git-hosting-provider'
import { Option } from 'effect'
import { expect, it } from 'vitest'

import { dashboardHtml } from './DashboardHtml'
import { DashboardState } from './DashboardState'
import { comparison } from './DashboardTestData'

it('ships executable dashboard JavaScript inside its nonce-bound document', () => {
  const html = dashboardHtml('fixture-nonce')
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]

  expect(script).toBeDefined()
  expect(() => new Script(script ?? '')).not.toThrow()
})

function renderDashboard(
  value: Pick<DashboardState, 'mode' | 'repositories' | 'repositoryId' | 'pulls' | 'filter'> &
    Partial<
      Pick<
        DashboardState,
        'details' | 'statistics' | 'avatars' | 'pullRequestId' | 'labels' | 'query'
      >
    >,
): string {
  const html = dashboardHtml('fixture-nonce')
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]
  const app = { innerHTML: '' }

  new Script(script ?? '').runInNewContext({
    acquireVsCodeApi: () => ({ postMessage: () => {} }),
    document: {
      getElementById: () => app,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: {
      addEventListener: (event: string, receive: (event: { data: unknown }) => void) => {
        if (event === 'message') receive({ data: { type: 'state', value } })
      },
    },
  })

  return app.innerHTML
}

const pull = OpenPullRequest.make({
  id: '17',
  title: 'Improve onboarding',
  url: 'https://forge.test/owner/repository/pulls/17',
  draft: false,
  source: { _tag: 'Unavailable' },
  target: {
    repository: {
      authority: 'forge.test',
      key: 'owner/repository',
      displayName: 'owner/repository',
    },
    ref: { name: 'refs/heads/main', revision: Option.none() },
  },
})

const model: Parameters<typeof renderDashboard>[0] = {
  mode: 'dashboard',
  repositories: [
    WatchedRepository.make({
      id: 'repository',
      name: 'owner/repository',
      localPaths: [],
      hosting: Option.some({
        provider: { id: 'fixture', displayName: 'Fixture forge', authenticationSource: 'editor' },
        repository: pull.target.repository,
        cloneUrl: 'https://forge.test/owner/repository.git',
      }),
    }),
  ],
  repositoryId: 'repository',
  pulls: [pull],
  filter: 'open',
}

it('renders escaped authors in PR rows and labels unavailable authors', () => {
  const html = renderDashboard({
    ...model,
    pulls: [
      { ...pull, author: 'original-author' },
      { ...pull, id: '18', author: '<img src=x onerror=alert(1)>' },
      { ...pull, id: '19' },
    ],
  })

  expect(html).toContain('Opened by original-author')
  expect(html).toContain('Opened by &lt;img src=x onerror=alert(1)&gt;')
  expect(html).not.toContain('<img')
  expect(html).toContain('Opened by Unknown author')
})

it('filters loaded PRs by author without losing title or number search', () => {
  const pulls = [
    { ...pull, author: 'Guide Fari' },
    { ...pull, id: '28', title: 'Fix checkout', author: 'Lisa Quluba' },
    { ...pull, id: '39', title: 'Update documentation' },
  ]

  const search = (query: string) => renderDashboard({ ...model, pulls, query })

  const rows = (html: string) =>
    [...html.matchAll(/data-action="pull" data-id="([^"]+)"/g)].map((match) => match[1])

  expect(rows(search('fArI'))).toEqual(['17'])
  expect(rows(search('Lisa Quluba'))).toEqual(['28'])
  expect(rows(search('checkout'))).toEqual(['28'])
  expect(rows(search('#39'))).toEqual(['39'])
  expect(rows(search('nobody'))).toEqual([])
  expect(rows(search(''))).toEqual(['17', '28', '39'])
})

it('shows descriptions, independent change counts and inert avatars for any forge', () => {
  const details = PullRequestDetails.make({
    pullRequest: pull,
    description: '<script>alert(1)</script>\nReview details\n\n**NOTE**: Keep `AppDelegate`.',
    filesChanged: Option.some(7),
    linesChanged: Option.some({ additions: 53, deletions: 0 }),
  })

  const state = new DashboardState()
  const version = state.beginDetails('17')
  state.finishDetails(version, details, {
    comparison,
    files: 7,
    lines: { additions: 53, deletions: 0 },
    reason: '',
  })

  const html = renderDashboard({
    ...model,
    pullRequestId: '17',
    pulls: [{ ...pull, author: 'Original Author', authorAvatarKey: 'author' }],
    avatars: { author: 'data:image/png;base64,aW1hZ2U=' },
    details: state.details,
    statistics: state.statistics,
  })

  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('Review details')
  expect(html).toContain('<strong>NOTE</strong>: Keep <code>AppDelegate</code>.')
  expect(html).not.toContain('<script>')
  expect(html).toContain('<dd>7</dd>')
  expect(html).toContain('+53')
  expect(html).toContain('−0')
  expect(html).toContain('src="data:image/png;base64,aW1hZ2U="')

  const unavailable = renderDashboard({
    ...model,
    pullRequestId: '17',
    details: {
      _tag: 'Current',
      value: {
        metadata: { ...details, description: '' },
        descriptionHtml: '<p>No description provided.</p>\n',
      },
    },
    statistics: {
      _tag: 'Current',
      value: {
        comparison,
        files: 0,
        lines: undefined,
        reason: 'Line totals unavailable for this comparison.',
      },
    },
    pulls: [{ ...pull, authorAvatarKey: 'author' }],
    avatars: { author: 'https://untrusted.test/track' },
  })

  expect(unavailable).toContain('<dd>0</dd>')
  expect(unavailable).toContain('Line totals unavailable')
  expect(unavailable).toContain('No description provided.')
  expect(unavailable).not.toContain('untrusted.test')

  const states: ReadonlyArray<DashboardState['details']> = [
    { _tag: 'Loading' },
    { _tag: 'Unavailable', reason: 'Could not load PR details.' },
  ]

  for (const state of states) {
    const pending = renderDashboard({ ...model, pullRequestId: '17', details: state })
    const text = state._tag === 'Loading' ? 'Loading PR details' : 'Could not load PR details'

    expect(pending).toContain(text)
    expect(pending).not.toContain('Review details')
  }
})

it('keeps column positions on background updates and resets only the changed selection', () => {
  const html = dashboardHtml('fixture-nonce')
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]

  const panes = {
    nav: { scrollTop: 0, dataset: { scrollKey: '' } },
    main: { scrollTop: 0, dataset: { scrollKey: '' } },
    aside: { scrollTop: 0, dataset: { scrollKey: '' } },
  }

  const listeners: Array<(event: { data: { type: string; value: typeof model } }) => void> = []

  new Script(script ?? '').runInNewContext({
    acquireVsCodeApi: () => ({ postMessage: () => {} }),
    document: {
      getElementById: () => ({
        set innerHTML(_value: string) {
          for (const pane of Object.values(panes)) {
            pane.scrollTop = 0
            pane.dataset.scrollKey = ''
          }
        },
      }),
      querySelector: (selector: string) => {
        if (selector === '.layout>nav') return panes.nav

        if (selector === '.layout>main') return panes.main

        if (selector === '.layout>aside') return panes.aside

        return null
      },
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: {
      addEventListener: (event: string, receive: (typeof listeners)[number]) => {
        if (event === 'message') listeners.push(receive)
      },
    },
  })

  const publish = (value: typeof model) => {
    for (const receive of listeners) receive({ data: { type: 'state', value } })
  }

  expect(listeners).toHaveLength(1)
  publish({ ...model, pullRequestId: '17' })
  panes.nav.scrollTop = 40
  panes.main.scrollTop = 180
  panes.aside.scrollTop = 90
  publish({ ...model, pullRequestId: '17', avatars: { author: 'data:image/png;base64,aW1hZ2U=' } })
  expect(Object.values(panes).map((pane) => pane.scrollTop)).toEqual([40, 180, 90])

  publish({ ...model, pullRequestId: '18' })
  expect(Object.values(panes).map((pane) => pane.scrollTop)).toEqual([40, 180, 0])

  publish({ ...model, repositoryId: 'other' })
  expect(Object.values(panes).map((pane) => pane.scrollTop)).toEqual([40, 0, 0])
})

it('shows escaped custom repository labels with the original name and a rename context', () => {
  const html = renderDashboard({ ...model, pulls: [], labels: { repository: '<b>Mine</b>' } })

  expect(html).toContain('&lt;b&gt;Mine&lt;/b&gt;')
  expect(html).not.toContain('<b>Mine</b>')
  expect(html).toContain('title="&lt;b&gt;Mine&lt;/b&gt; (owner/repository)"')
  expect(html).toContain('&quot;webviewSection&quot;:&quot;repository&quot;')
  expect(html).toContain('data-action="rename"')
})

it('renders metadata independently of statistics and labels retained results accurately', () => {
  const state = new DashboardState()
  state.finishDetails(
    state.beginDetails('17'),
    PullRequestDetails.make({
      pullRequest: pull,
      description: 'Metadata remains readable',
      filesChanged: Option.some(3),
      linesChanged: Option.some({ additions: 42, deletions: 9 }),
    }),
    { comparison, files: 3, lines: { additions: 42, deletions: 9 }, reason: '' },
  )

  const render = () =>
    renderDashboard({
      ...model,
      pullRequestId: '17',
      details: state.details,
      statistics: state.statistics,
    })

  const current = state.statistics
  state.statistics = { _tag: 'Loading' }
  expect(render()).toContain('Metadata remains readable')
  expect(render()).toContain('Loading change statistics')
  expect(render()).not.toContain('+42')
  expect(render()).not.toContain('unavailable from this provider')
  state.statistics = { _tag: 'Unavailable', reason: 'Binary comparison cannot be counted.' }
  expect(render()).toContain('Binary comparison cannot be counted.')
  expect(render()).not.toContain('+0')

  if (current._tag !== 'Current') throw new Error('Expected current fixture statistics')
  state.statistics = { ...current, _tag: 'Refreshing' }
  expect(render()).toContain('+42')
  expect(render()).toContain('Refreshing change statistics')
  state.statistics = { ...current, _tag: 'Stale', reason: 'Refresh failed. <retry>' }
  expect(render()).toContain('+42')
  expect(render()).toContain('Stale change statistics')
  expect(render()).toContain('Refresh failed. &lt;retry&gt;')
  expect(render()).toContain('data-action="details"')
})

it('keeps the loaded PR search on repository reselection without fetching on keyboard focus movement', () => {
  const html = dashboardHtml('fixture-nonce')
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]
  const app = { innerHTML: '' }

  type ViewModel = Parameters<typeof renderDashboard>[0] & { readonly query?: string }

  type Message = { readonly action: string; readonly id?: string }

  type Control = {
    readonly dataset: { readonly action: string; readonly id: string }
    readonly disabled: boolean
  }

  type PointerEvent = { readonly target: { readonly closest: (selector: string) => Control } }

  const messages: Message[] = []
  const listeners = new Map<string, (event: PointerEvent) => void>()

  let publish: (value: ViewModel) => void = () => {
    throw new Error('Missing state receiver')
  }

  new Script(script ?? '').runInNewContext({
    acquireVsCodeApi: () => ({ postMessage: (message: Message) => messages.push(message) }),
    document: {
      getElementById: () => app,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (event: string, listener: (value: PointerEvent) => void) => {
        listeners.set(event, listener)
      },
    },
    window: {
      addEventListener: (
        event: string,
        receive: (value: {
          readonly data: { readonly type: string; readonly value: ViewModel }
        }) => void,
      ) => {
        if (event === 'message') publish = (value) => receive({ data: { type: 'state', value } })
      },
    },
  })
  const state = { ...model, pullRequestId: '17', query: 'onboarding' }
  publish(state)
  const target = { dataset: { action: 'repository', id: 'repository' }, disabled: false }
  listeners.get('focusin')?.({ target: { closest: () => target } })
  expect(messages).toEqual([{ action: 'ready' }])
  listeners.get('click')?.({ target: { closest: () => target } })
  publish(state)
  expect(messages).toEqual([{ action: 'ready' }, { action: 'repository', id: 'repository' }])
  expect(app.innerHTML).toContain('value="onboarding"')
  expect(app.innerHTML).toContain('Improve onboarding')
})

it('keeps pinned provider-reported metadata totals usable when comparison verification loads or fails', () => {
  const pinned = OpenPullRequest.make({
    ...pull,
    source: {
      _tag: 'Available',
      repository: pull.target.repository,
      ref: { name: 'refs/heads/topic', revision: Option.some('a'.repeat(40)) },
    },
    target: {
      repository: pull.target.repository,
      ref: { name: 'refs/heads/main', revision: Option.some('b'.repeat(40)) },
    },
  })

  const state = new DashboardState()
  state.finishMetadata(
    state.beginDetails(pinned.id),
    PullRequestDetails.make({
      pullRequest: pinned,
      description: 'Provider metadata',
      filesChanged: Option.some(4),
      linesChanged: Option.some({ additions: 23, deletions: 0 }),
    }),
  )

  const render = () =>
    renderDashboard({
      ...model,
      pulls: [pinned],
      pullRequestId: pinned.id,
      details: state.details,
      statistics: state.statistics,
    })

  expect(render()).toContain('+23')
  expect(render()).toContain('−0')
  expect(render()).toContain('Loading change statistics')
  expect(render()).toContain('Provider-reported counts from this PR metadata snapshot')
  state.statistics = { _tag: 'Unavailable', reason: 'Could not verify comparison statistics.' }
  expect(render()).toContain('+23')
  expect(render()).toContain('Could not verify comparison statistics.')

  const changed = {
    ...pinned,
    target: {
      ...pinned.target,
      ref: { name: 'refs/heads/main', revision: Option.some('c'.repeat(40)) },
    },
  }

  state.finishMetadata(
    state.beginDetails(pinned.id),
    PullRequestDetails.make({
      pullRequest: changed,
      description: 'New revisions',
      filesChanged: Option.none(),
      linesChanged: Option.none(),
    }),
  )
  expect(render()).not.toContain('+23')
})
