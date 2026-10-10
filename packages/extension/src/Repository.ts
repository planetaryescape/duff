import * as vscode from 'vscode'

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
            folders.map((item) => ({ label: item.name, folder: item })),
            { title: 'Duff: Choose Repository' },
          )
          .then((item) => item?.folder)

  return folder?.uri.fsPath
}
