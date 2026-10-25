import { Script } from 'node:vm'

import { WatchedRepository } from '@duff/core/dashboard-repositories'
import { OpenPullRequest, PullRequestDetails } from '@duff/core/git-hosting-provider'
import { Option } from 'effect'
import { expect, it } from 'vitest'

import { dashboardHtml } from './DashboardHtml'
import { DashboardState } from './DashboardState'

it('ships executable dashboard JavaScript inside its nonce-bound document', () => {
  const html = dashboardHtml('fixture-nonce')
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]

  expect(script).toBeDefined()
  expect(() => new Script(script ?? '')).not.toThrow()
})

function renderDashboard(
  value: Pick<DashboardState, 'mode' | 'repositories' | 'repositoryId' | 'pulls' | 'filter'> &
    Partial<Pick<DashboardState, 'details' | 'avatars' | 'pullRequestId' | 'labels'>>,
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

it('shows descriptions, independent change counts and inert avatars for any forge', () => {
  const details = PullRequestDetails.make({
    pullRequest: pull,
    description: '<script>alert(1)</script>\nReview details\n\n**NOTE**: Keep `AppDelegate`.',
    filesChanged: Option.some(7),
    linesChanged: Option.some({ additions: 53, deletions: 0 }),
  })

  const state = new DashboardState()
  const version = state.beginDetails('17')
  state.finishDetails(version, details)

  const html = renderDashboard({
    ...model,
    pullRequestId: '17',
    pulls: [{ ...pull, author: 'Original Author', authorAvatarKey: 'author' }],
    avatars: { author: 'data:image/png;base64,aW1hZ2U=' },
    details: state.details,
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
      _tag: 'Loaded',
      descriptionHtml: '<p>No description provided.</p>\n',
      value: {
        ...details,
        description: '',
        filesChanged: Option.some(0),
        linesChanged: Option.none(),
      },
    },
    pulls: [{ ...pull, authorAvatarKey: 'author' }],
    avatars: { author: 'https://untrusted.test/track' },
  })

  expect(unavailable).toContain('<dd>0</dd>')
  expect(unavailable).toContain('Line totals unavailable')
  expect(unavailable).toContain('No description provided.')
  expect(unavailable).not.toContain('untrusted.test')

  const states: ReadonlyArray<DashboardState['details']> = [{ _tag: 'Loading' }, { _tag: 'Failed' }]

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
