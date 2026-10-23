/** Map a snapshot line to identical workspace text; refuse ambiguous or changed lines. */
export function workspaceLine(
  snapshot: string,
  workspace: string,
  line: number,
): number | undefined {
  const source = snapshot.split(/\r?\n/)
  const text = source[line]

  if (text === undefined) return undefined

  if (snapshot === workspace) return line
  const lines = workspace.split(/\r?\n/)
  const matches = lines.flatMap((candidate, index) => (candidate === text ? [index] : []))

  return matches.length === 1 ? matches[0] : undefined
}
