import { Script } from 'node:vm'

import { expect, it } from 'vitest'

import { dashboardHtml } from './DashboardHtml'

it('ships executable dashboard JavaScript inside its nonce-bound document', () => {
  const html = dashboardHtml('fixture-nonce')
  const script = html.match(/<script nonce="fixture-nonce">([\s\S]*?)<\/script>/)?.[1]

  expect(script).toBeDefined()
  expect(() => new Script(script ?? '')).not.toThrow()
})
