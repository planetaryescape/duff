import {
  GitHubAuthenticationError,
  ProviderRedirected,
  InvalidProviderResponse,
} from '@duff/core/git-hosting-provider'
import { expect, it } from 'vitest'

import { providerError } from './ProviderError'

it('explains when automatic repository relocation could not resolve the current address', () => {
  const message = providerError(new ProviderRedirected())

  expect(message).toContain('moved or been renamed')
  expect(message).toContain('add its current URL')
  expect(message).toContain('could not resolve its current address')
  expect(message).not.toContain('sign-in')
  expect(providerError(new InvalidProviderResponse())).toContain('invalid data')
})

it('keeps actionable credential-source diagnostics for operation notifications', () => {
  expect(
    providerError(new GitHubAuthenticationError({ source: 'github-cli', reason: 'rejected' })),
  ).toContain('GitHub CLI credential rejected')
})
