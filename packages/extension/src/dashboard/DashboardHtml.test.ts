import { Script } from 'node:vm'

import { expect, it } from 'vitest'

import { dashboardHtml } from './DashboardHtml'

it('ships executable dashboard JavaScript inside its nonce-bound document', () => {
  const html = dashboardHtml('fixture-nonce')
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]

  expect(script).toBeDefined()
  expect(() => new Script(script ?? '')).not.toThrow()
})

it('renders escaped authors in PR rows and labels unavailable authors', () => {
  const html = dashboardHtml('fixture-nonce')
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]
  const app = { innerHTML: '' }

  const repository = {
    id: 'repository',
    name: 'owner/repository',
    hosting: {
      _tag: 'Some',
      value: {
        provider: { displayName: 'GitHub' },
        repository: { authority: 'github.com' },
      },
    },
  }

  const pull = {
    id: '17',
    title: 'Improve onboarding',
    source: { _tag: 'Unavailable' },
    target: { ref: { name: 'refs/heads/main' } },
  }

  new Script(script ?? '').runInNewContext({
    acquireVsCodeApi: () => ({ postMessage: () => {} }),
    document: {
      getElementById: () => app,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: {
      addEventListener: (_event: string, receive: (event: { data: unknown }) => void) => {
        receive({
          data: {
            type: 'state',
            value: {
              mode: 'dashboard',
              repositories: [repository],
              repositoryId: repository.id,
              pulls: [
                { ...pull, author: 'original-author' },
                { ...pull, id: '18', author: '<img src=x onerror=alert(1)>' },
                { ...pull, id: '19' },
              ],
              filter: 'open',
            },
          },
        })
      },
    },
  })

  expect(app.innerHTML).toContain('Opened by original-author')
  expect(app.innerHTML).toContain('Opened by &lt;img src=x onerror=alert(1)&gt;')
  expect(app.innerHTML).not.toContain('<img')
  expect(app.innerHTML).toContain('Opened by Unknown author')
})
