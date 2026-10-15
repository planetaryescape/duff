export const repositoryEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...environment }

  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE',
    'GIT_PREFIX',
    'GIT_SHALLOW_FILE',
  ])
    delete env[key]

  return env
}
