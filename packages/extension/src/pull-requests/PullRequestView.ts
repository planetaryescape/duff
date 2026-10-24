import { type OpenPullRequest } from '@duff/core/git-hosting-provider'
import { PullRequestSelection } from '@duff/core/pull-requests'
import { type GroupRow, type ReviewState, type SessionProblem } from '@duff/core/review-session'
import { Match, Option } from 'effect'
import * as vscode from 'vscode'

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

function item(label: string, description?: string, command?: vscode.Command): vscode.TreeItem {
  const row = new vscode.TreeItem(label)
  row.description = description
  row.command = command
  row.tooltip = description ? `${label}: ${description}` : label
  row.accessibilityInformation = { label: description ? `${label}: ${description}` : label }

  return row
}

export class PullRequestItem extends vscode.TreeItem {
  readonly selection: PullRequestSelection
  constructor(
    readonly root: string,
    row: GroupRow,
    readonly pullRequest: OpenPullRequest,
  ) {
    super(`#${pullRequest.id} ${pullRequest.title}`)
    this.selection = PullRequestSelection.make({
      provider: row.group.provider.id,
      repository: row.group.repository,
      id: pullRequest.id,
      label: `#${pullRequest.id} ${pullRequest.title} · ${pullRequest.source._tag === 'Available' ? pullRequest.source.ref.name.replace('refs/heads/', '') : 'Unavailable'} → ${pullRequest.target.ref.name.replace('refs/heads/', '')}`,
    })
    this.description = pullRequest.draft ? 'Draft' : 'Open'
    this.iconPath = new vscode.ThemeIcon(
      pullRequest.draft ? 'git-pull-request-draft' : 'git-pull-request',
    )
    this.contextValue = 'pullRequest'
    this.command = {
      command: 'duff.reviewPullRequest',
      title: 'Review Pull Request Locally',
      arguments: [this],
    }
    this.tooltip = `${pullRequest.source._tag === 'Available' ? `${pullRequest.source.repository.displayName}: ${pullRequest.source.ref.name}` : 'Source unavailable'}\n→ ${pullRequest.target.ref.name}\nPrepare an immutable local review. Missing revisions require fetch consent. Never switches branches.`
  }
}

export function canConnectProvider(row: GroupRow, busy: boolean): boolean {
  if (busy || row.activity !== 'Idle') return false

  return Match.value(row.content).pipe(
    Match.when(
      { error: { _tag: 'GitHubAuthenticationError', source: (source) => source !== 'editor' } },
      () => false,
    ),
    Match.tag('Failed', () => true),
    Match.when(
      { data: { authentication: { _tag: Match.is('Unauthenticated', 'Unknown') } } },
      () => true,
    ),
    Match.orElse(() => false),
  )
}

function groupChildren(row: GroupRow, busy: boolean, root: string): vscode.TreeItem[] {
  const content = row.content
  const authentication = 'data' in content ? content.data.authentication : undefined

  const source = Match.value(content).pipe(
    Match.when({ error: { _tag: 'GitHubAuthenticationError' } }, ({ error }) => error.source),
    Match.when(
      { data: { authentication: { _tag: 'Authenticated' } } },
      ({ data }) => data.authentication.source,
    ),
    Match.orElse(() => undefined),
  )

  const children = [
    item('Remotes', row.group.remoteNames.join(', ')),
    item('Host', row.group.repository.authority),
    item(
      'Authentication source',
      source
        ? credentialLabels[source]
        : row.group.provider.authenticationSource === 'azure-cli'
          ? 'Azure CLI'
          : authentication?._tag === 'Unauthenticated'
            ? 'Anonymous'
            : 'GH_TOKEN → GITHUB_TOKEN → GitHub CLI → VS Code',
    ),
  ]

  if ('data' in content) {
    const data = content.data
    children.push(
      item(
        'API authentication',
        data.authentication._tag === 'Authenticated'
          ? Option.match(data.authentication.account, {
              onSome: (account) => account.displayName,
              onNone: () => 'Account identity not verified',
            })
          : data.authentication._tag,
      ),
    )

    for (const pr of data.items) {
      children.push(new PullRequestItem(root, row, pr))
    }

    if (content._tag === 'Refreshing') children.push(item('Refreshing…', 'Previous results'))

    if (content._tag === 'Stale') children.push(item('Stale results', providerError(content.error)))

    if (row.activity === 'LoadingMore') children.push(item('Loading next page…'))
    else if (row.activity === 'Cooldown') children.push(item('Waiting for rate-limit cooldown…'))
    else if (!busy && row.activity === 'Idle' && data.hasMore)
      children.push(
        item('Load More', 'Incomplete result', {
          command: 'duff.loadMoreProviders',
          title: 'Load More',
          arguments: [row.group.id],
        }),
      )
    else if (content._tag === 'Ready' && !data.hasMore)
      children.push(item(data.items.length ? 'All pages loaded.' : 'No open pull requests found.'))
  } else if (content._tag === 'Loading') children.push(item('Loading pull requests…'))
  else children.push(item(providerError(content.error)))

  if (row.activity === 'Connecting') children.push(item('Connecting provider…'))
  else if (canConnectProvider(row, busy)) {
    children.push(
      item(
        row.group.provider.authenticationSource === 'github'
          ? 'Use VS Code account…'
          : 'Connect Provider…',
        undefined,
        {
          command: 'duff.connectProvider',
          title: 'Connect Provider',
          arguments: [row.group.id],
        },
      ),
    )
  }

  if (content._tag === 'Failed' || content._tag === 'Stale')
    children.push(
      item('Refresh Discovery', undefined, {
        command: 'duff.refreshProviders',
        title: 'Refresh Discovery',
      }),
    )

  return children
}

export class PullRequestView
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changes.event
  private roots: vscode.TreeItem[] = []
  private readonly children = new Map<vscode.TreeItem, vscode.TreeItem[]>()

  setState(state: ReviewState) {
    this.children.clear()
    this.roots =
      state._tag === 'Idle'
        ? []
        : state.rows.map((row) => {
            const root = item(
              row.group.repository.displayName,
              `${row.group.provider.displayName} · ${row.group.provider.authenticationSource === 'azure-cli' ? 'Azure CLI · ' : ''}${row.content._tag}`,
            )

            root.id = row.group.key
            root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded
            this.children.set(
              root,
              groupChildren(
                row,
                state.inspection !== 'Ready' ||
                  row.content._tag === 'Loading' ||
                  row.content._tag === 'Refreshing' ||
                  state.rows.some((row) => row.activity === 'Connecting'),
                Option.getOrElse(
                  Option.map(state.snapshot, (snapshot) => snapshot.root),
                  () => state.directory,
                ),
              ),
            )

            return root
          })

    if (state._tag === 'Active')
      for (const notice of state.notices) {
        this.roots.push(
          item(
            notice.remote.name,
            notice._tag === 'Unsupported'
              ? 'Unsupported remote. No provider request made.'
              : `Ambiguous: ${notice.candidates.map((candidate) => candidate.displayName).join(', ')}`,
          ),
        )
      }

    this.changes.fire()
  }

  getTreeItem(element: vscode.TreeItem) {
    return element
  }
  getChildren(element?: vscode.TreeItem) {
    return element ? (this.children.get(element) ?? []) : this.roots
  }
  dispose() {
    this.changes.dispose()
  }
}
