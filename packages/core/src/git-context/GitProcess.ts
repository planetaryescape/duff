import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from '@effect/platform-node'
import { Git } from '@effected/git'
import { ConfigProvider, Effect, Layer, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { repositoryEnvironment } from './RepositoryEnvironment'

export const gitCommand = (root: string, args: ReadonlyArray<string>, input?: string) =>
  ChildProcess.make('git', ['--no-pager', ...args], {
    cwd: root,
    stdin: input === undefined ? 'ignore' : Stream.make(new TextEncoder().encode(input)),
  })

export const makeGitProcessLayer = (environment: NodeJS.ProcessEnv) => {
  const configure = (command: ChildProcess.Command): ChildProcess.Command => {
    if (ChildProcess.isStandardCommand(command))
      return ChildProcess.make(command.command, command.args, {
        ...command.options,
        env: {
          ...repositoryEnvironment({ ...environment, ...command.options.env }),
          LC_ALL: 'C',
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS_REQUIRE: 'never',
        },
        extendEnv: false,
        killSignal: 'SIGKILL',
      })

    return ChildProcess.pipeTo(configure(command.left), configure(command.right), command.options)
  }

  const spawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const node = yield* ChildProcessSpawner.ChildProcessSpawner

      return ChildProcessSpawner.make((command) => node.spawn(configure(command)))
    }),
  ).pipe(
    Layer.provide(
      NodeChildProcessSpawner.layer.pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      ),
    ),
  )

  return Git.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
    Layer.provideMerge(spawner),
  )
}
