import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { Effect, Schema } from 'effect'

export class WorkspaceFileError extends Schema.TaggedError<WorkspaceFileError>()(
  'WorkspaceFileError',
  {
    message: Schema.String,
  },
) {}

export const workspaceContents = Effect.fn('WorkspaceFile.read')(function* (
  root: string,
  path: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const target = join(root, path)
      const stat = await lstat(target)
      const resolved = await realpath(target)
      const inside = relative(root, resolved)

      if (
        !stat.isFile() ||
        stat.size > 2 * 1024 * 1024 ||
        inside === '..' ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside)
      )
        throw new Error('unsupported')
      const content = await readFile(target)

      if (content.includes(0)) throw new Error('binary')

      return content
    },
    catch: () =>
      new WorkspaceFileError({
        message:
          'Only existing text files up to 2 MiB inside this repository can be edited. Symlinks and special files are not supported.',
      }),
  })
})
