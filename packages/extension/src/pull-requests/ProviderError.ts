import { type SessionProblem } from '@duff/core/review-session'
import { Option } from 'effect'

const credentialLabels = {
  'github-cli': 'GitHub CLI',
  editor: 'VS Code',
  GH_TOKEN: 'GH_TOKEN',
  GITHUB_TOKEN: 'GITHUB_TOKEN',
}

export function providerError(error: SessionProblem): string {
  if (error === 'InspectionFailed')
    return 'Discovery was interrupted. Refresh to recheck local context and pull requests.'

  if (error === 'UnexpectedFailure') return 'Unexpected operation failure. Refresh to retry.'

  switch (error._tag) {
    case 'GitHubAuthenticationError': {
      const source = credentialLabels[error.source]

      switch (error.reason) {
        case 'invalid-credential':
          return `${source} supplied a malformed credential. Fix that source; Duff will not switch accounts.`
        case 'unavailable':
          return `${source} failed or timed out. Check gh auth status --hostname github.com outside Duff, then refresh.`
        case 'rejected':
          return `${source} credential rejected by GitHub. Renew that credential, then refresh. No fallback attempted.`
        case 'inaccessible':
          return `Repository missing or inaccessible with ${source}. Check repository access and SSO authorization. No fallback attempted.`
      }
    }

    case 'AzureCliAuthenticationError':
      switch (error.reason) {
        case 'not-installed':
          return 'Azure CLI is not available on PATH. Install it outside Duff, then restart the editor.'
        case 'sign-in-required':
          return 'Azure CLI sign-in required. Run az login outside Duff, then refresh discovery.'
        case 'invalid-response':
          return 'Azure CLI returned invalid or expired credentials. Check the CLI outside Duff, then refresh.'
        case 'unavailable':
          return 'Azure CLI authentication failed or timed out. Check the CLI outside Duff, then refresh.'
      }

    case 'AuthenticationRequired':
      return 'Provider sign-in required. Git credentials are not API authentication.'
    case 'RepositoryUnavailable':
      return 'Repository missing or inaccessible to this API session.'
    case 'ProviderUnavailable':
      return 'Provider or authentication service unavailable. Refresh to retry.'
    case 'ProviderRedirected':
      return 'The repository may have moved or been renamed, but Duff could not resolve its current address. Check access or add its current URL.'
    case 'InvalidProviderResponse':
      return 'Provider returned invalid data. Refresh to retry.'
    case 'InvalidContinuation':
      return 'This page is stale. Refresh to restart discovery.'
    case 'RateLimited':
      return Option.isSome(error.retryAfterSeconds)
        ? `Rate limited. Retry after ${Math.ceil(error.retryAfterSeconds.value)} seconds.`
        : 'Rate limited. Refresh later.'
  }
}
