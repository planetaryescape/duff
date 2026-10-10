import * as vscode from 'vscode'

class RepositoryChoice implements vscode.QuickPickItem {
  readonly label: string

  constructor(readonly folder: vscode.WorkspaceFolder) {
    this.label = folder.name
  }
}

export async function chooseDirectory() {
  const folders = vscode.workspace.workspaceFolders

  if (!folders?.length) {
    await vscode.window.showInformationMessage('Duff: Open a Git repository folder first.')

    return
  }

  const folder =
    folders.length === 1
      ? folders[0]
      : await vscode.window
          .showQuickPick(
            folders.map((folder) => new RepositoryChoice(folder)),
            { title: 'Duff: Choose Repository' },
          )
          .then((item) => item?.folder)

  return folder?.uri.fsPath
}
