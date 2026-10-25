import { Option } from 'effect'
import * as vscode from 'vscode'

import { decodeSnapshotDocument } from './SnapshotDocument'
import { workspaceLine } from './SnapshotPosition'

class WorkspacePosition {
  constructor(
    readonly uri: vscode.Uri,
    readonly position: vscode.Position,
  ) {}
}

/** Read-only language navigation uses the current workspace project, never edits a snapshot. */
export function registerSnapshotNavigation(context: vscode.ExtensionContext) {
  const selector = [
    { scheme: 'duff-snapshot', language: 'typescript' },
    { scheme: 'duff-snapshot', language: 'typescriptreact' },
    { scheme: 'duff-snapshot', language: 'javascript' },
    { scheme: 'duff-snapshot', language: 'javascriptreact' },
  ]

  const target = async (
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ) => {
    const snapshot = Option.map(
      decodeSnapshotDocument(document.uri.query),
      (value) => value.snapshot,
    )

    if (
      Option.isNone(snapshot) ||
      snapshot.value.path === undefined ||
      token.isCancellationRequested
    )
      return
    const uri = vscode.Uri.joinPath(vscode.Uri.file(snapshot.value.root), snapshot.value.path)
    let workspace: vscode.TextDocument

    try {
      workspace = await vscode.workspace.openTextDocument(uri)
    } catch {
      return
    }

    if (token.isCancellationRequested) return

    const match = workspaceLine(document.getText(), workspace.getText(), position.line)

    if (match === undefined) return

    return new WorkspacePosition(uri, new vscode.Position(match, position.character))
  }

  const locations = async (
    command: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ) => {
    const mapped = await target(document, position, token)

    if (!mapped) return []

    const result = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >(command, mapped.uri, mapped.position)

    if (token.isCancellationRequested) return []

    return (
      result?.map((location) =>
        'targetUri' in location
          ? new vscode.Location(
              location.targetUri,
              location.targetSelectionRange ?? location.targetRange,
            )
          : location,
      ) ?? []
    )
  }

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: (document, position, token) =>
        locations('vscode.executeDefinitionProvider', document, position, token),
    }),
    vscode.languages.registerTypeDefinitionProvider(selector, {
      provideTypeDefinition: (document, position, token) =>
        locations('vscode.executeTypeDefinitionProvider', document, position, token),
    }),
    vscode.languages.registerImplementationProvider(selector, {
      provideImplementation: (document, position, token) =>
        locations('vscode.executeImplementationProvider', document, position, token),
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences: async (document, position, options, token) => {
        const mapped = await target(document, position, token)

        if (!mapped) return []

        const result = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          mapped.uri,
          mapped.position,
        )

        if (token.isCancellationRequested) return []

        if (options.includeDeclaration) return result ?? []

        const definitions = await locations(
          'vscode.executeDefinitionProvider',
          document,
          position,
          token,
        )

        return (
          result?.filter(
            (reference) =>
              !definitions.some(
                (definition) =>
                  definition.uri.toString() === reference.uri.toString() &&
                  definition.range.contains(reference.range),
              ),
          ) ?? []
        )
      },
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover: async (document, position, token) => {
        const mapped = await target(document, position, token)

        if (!mapped) return

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          mapped.uri,
          mapped.position,
        )

        if (token.isCancellationRequested || !hovers?.length) return

        return new vscode.Hover(
          [
            new vscode.MarkdownString('**Current workspace TypeScript project**'),
            ...hovers.flatMap((hover) => hover.contents),
          ],
          document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position),
        )
      },
    }),
  )
}
