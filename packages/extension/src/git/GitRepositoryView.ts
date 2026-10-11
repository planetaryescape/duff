import { type ConfigValue, type GitRepositorySnapshot } from '@duff/core/git-repository'
import * as vscode from 'vscode'

function row(label: string, value: string, detail?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label)
  item.description = value
  item.tooltip = `${label}: ${value}${detail ? `\n${detail}` : ''}`

  return item
}

function configRow(label: string, value: ConfigValue | undefined): vscode.TreeItem {
  return row(label, value?.value || 'Unset', value ? `${value.scope} · ${value.origin}` : undefined)
}

export class GitRepositoryView
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changes.event
  private rows: vscode.TreeItem[] = []
  private readonly children = new Map<vscode.TreeItem, vscode.TreeItem[]>()

  setSnapshot(snapshot: GitRepositorySnapshot) {
    this.children.clear()

    const remotes = snapshot.remotes.map((remote) => {
      const item = row(`Remote: ${remote.name}`, remote.transport, remote.destination)
      item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded
      const policy = remote.credentials

      const rows = [
        row('Fetch destination', remote.destination, 'Userinfo, query and fragment are hidden.'),
      ]

      if (policy._tag === 'Http') {
        rows.push(configRow('Credential username', policy.username))
        rows.push(configRow('useHttpPath', policy.useHttpPath))
        rows.push(
          row(
            'Helper context',
            policy.useHttpPath.value === 'true' ? 'Host and repository path' : 'Host only',
          ),
        )
        rows.push(
          row(
            'Configured helper chain',
            String(policy.helpers.length),
            'Matching declarations in Git configuration order, after resets. Helpers are not executed and authentication is not verified.',
          ),
        )
        rows.push(
          ...policy.helpers.map((helper, index) =>
            row(
              `Helper ${index + 1}`,
              helper.strategy,
              `${helper.scope} · ${helper.origin} · ${helper.target}`,
            ),
          ),
        )
      } else if (policy._tag === 'Unresolved')
        rows.push(row('Credential selection', 'Unresolved', policy.reason))
      else
        rows.push(
          row(
            'Credential helpers',
            'Not applicable',
            'HTTP credential helpers do not establish the SSH key or account.',
          ),
        )
      this.children.set(item, rows)

      return item
    })

    const declarations = row(
      'Helper declarations',
      String(snapshot.helpers.length),
      'All declarations, including unmatched entries and resets. Not a selected credential or verified login.',
    )

    declarations.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
    this.children.set(
      declarations,
      snapshot.helpers.map((helper, index) =>
        row(
          `Declaration ${index + 1}: ${helper.target}`,
          helper.strategy,
          `${helper.scope} · ${helper.origin}`,
        ),
      ),
    )
    this.rows = [
      row('Repository', snapshot.root),
      configRow('user.name', snapshot.name),
      configRow('user.email', snapshot.email),
      row('Commit author', snapshot.author ?? 'Unresolved'),
      row('Commit committer', snapshot.committer ?? 'Unresolved'),
      row(
        'Provider account',
        'Not verified',
        'Commit identity and credential configuration do not establish a provider login.',
      ),
      ...remotes,
      ...(snapshot.remotes.length ? [] : [row('Remotes', 'None configured')]),
      row(
        'SSH command',
        snapshot.sshCommandConfigured ? 'Custom command configured (hidden)' : 'Default SSH',
        'The selected key and authenticated account are unknown.',
      ),
      declarations,
    ]
    this.changes.fire()
  }

  clear() {
    this.rows = []
    this.children.clear()
    this.changes.fire()
  }

  getTreeItem(item: vscode.TreeItem) {
    return item
  }
  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    return item ? (this.children.get(item) ?? []) : this.rows
  }
  dispose() {
    this.changes.dispose()
  }
}
