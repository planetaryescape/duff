import { Run } from '@effected/commands'
import { Context, Effect, Layer, Schema } from 'effect'
import { ChildProcessSpawner } from 'effect/process'

import { gitCommand, makeGitProcessLayer } from '../git-context/GitProcess'
import { Commit, GitPath, ReviewError } from './BranchReview'

/** One regular, UTF-8 source object exported from an immutable Git tree. */
export interface RevisionSource {
  readonly path: string
  readonly text: string
}

/**
 * Bounded TS/JS-family and JSON/JSONC revision inputs, including unchanged sources/configs.
 * All tree paths/modes are checked; unrelated assets and vendored .yarn inputs consume
 * no source-byte budget and are never read. Symlinks, submodules, ambiguous paths and
 * invalid selected text fail closed.
 * This is not a complete dependency or other-language context.
 */
export class RevisionSources extends Context.Service<
  RevisionSources,
  {
    readonly read: (
      root: string,
      commit: string,
    ) => Effect.Effect<ReadonlyArray<RevisionSource>, ReviewError>
  }
>()('duff/RevisionSources') {}

const Entry = Schema.Struct({
  mode: Schema.Literals(['100644', '100755']),
  id: Commit,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  path: GitPath,
})

const failure = () =>
  new ReviewError({
    operation: 'revision sources',
    message: 'Revision source exceeds limits or contains unsupported objects or paths.',
  })

/** Git-only adapter using the same inherited-environment policy as review reads. */
export const makeRevisionSourcesLayer = (environment: NodeJS.ProcessEnv) =>
  Layer.effect(
    RevisionSources,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const git = Effect.fn('RevisionSources.git')(function* (
        root: string,
        args: ReadonlyArray<string>,
        maxOutputBytes: number,
        input?: string,
      ) {
        const result = yield* Run.collect(gitCommand(root, args, input), {
          timeout: '10 seconds',
          maxOutputBytes,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(failure),
        )

        if (!result.succeeded) return yield* failure()

        return result.stdout
      })

      const read = Effect.fn('RevisionSources.read')(
        function* (root: string, input: string) {
          const commit = yield* Schema.decodeUnknownEffect(Commit)(input).pipe(
            Effect.mapError(failure),
          )

          const tree = yield* git(root, ['ls-tree', '-rlz', '--full-tree', commit], 2097152)
          const entries = tree.split('\0').filter((entry) => entry.length > 0)

          if (entries.length > 4096) return yield* failure()

          let total = 0
          const files: RevisionSource[] = []
          const selected: Array<Schema.Schema.Type<typeof Entry>> = []
          const paths = new Map<string, { readonly path: string; readonly directory: boolean }>()

          for (const entry of entries) {
            const match = /^(\d{6}) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(entry)

            const decoded = yield* Schema.decodeUnknownEffect(Entry)({
              mode: match?.[1],
              id: match?.[2],
              size: Number(match?.[3]),
              path: match?.[4],
            }).pipe(Effect.mapError(failure))

            const parts = decoded.path.split('/')
            let prefix = ''

            // Distinct Git directories must not merge on a case-insensitive or normalizing FS.
            for (const [index, part] of parts.entries()) {
              prefix = prefix ? `${prefix}/${part}` : part
              const identity = prefix.normalize('NFC').toLowerCase()
              const directory = index < parts.length - 1
              const previous = paths.get(identity)

              if (
                previous &&
                (previous.path !== prefix || previous.directory !== directory || !directory)
              )
                return yield* failure()

              paths.set(identity, { path: prefix, directory })
            }

            // Materializers must never interpret Git names as platform traversal or package roots.
            if (
              decoded.path.includes('\\') ||
              decoded.path.includes(':') ||
              decoded.path
                .split('/')
                .some((part) =>
                  ['', '.', '..', '.git', 'node_modules'].includes(part.toLowerCase()),
                )
            )
              return yield* failure()

            if (!/\.(?:[cm]?[jt]s|[jt]sx|jsonc?)$/i.test(decoded.path)) continue

            if (decoded.path.split('/').some((part) => part.toLowerCase() === '.yarn')) continue

            total += decoded.size

            if (decoded.size > 1048576 || total > 16777216) return yield* failure()

            selected.push(decoded)
          }

          if (selected.length === 0) return files

          // One owned Git process per tree, not one spawn per source file. Parse byte lengths,
          // never delimiters in source text; tree metadata was bounded before any blob reads.
          const output = yield* git(
            root,
            ['cat-file', '--batch'],
            total + selected.length * 128,
            selected.map((file) => file.id).join('\n') + '\n',
          )

          if (output.includes('\ufffd')) return yield* failure()

          const bytes = Buffer.from(output, 'utf8')
          let offset = 0

          for (const file of selected) {
            const header = Buffer.from(`${file.id} blob ${file.size}\n`, 'ascii')

            if (!bytes.subarray(offset, offset + header.length).equals(header))
              return yield* failure()

            offset += header.length
            const end = offset + file.size

            if (bytes[end] !== 10) return yield* failure()

            const text = bytes.subarray(offset, end).toString('utf8')

            if (text.includes('\0') || text.includes('\ufffd')) return yield* failure()

            files.push({ path: file.path, text })
            offset = end + 1
          }

          if (offset !== bytes.length) return yield* failure()

          return files
        },
        Effect.timeout('30 seconds'),
        Effect.mapError(failure),
      )

      return RevisionSources.of({ read })
    }),
  ).pipe(Layer.provide(makeGitProcessLayer(environment)))
