import { Context, type Effect, Schema } from 'effect'

import { ProviderIdentity, RepositoryIdentity } from '../pull-requests/GitHostingProvider'

export const HostedRepository = Schema.Struct({
  provider: ProviderIdentity,
  repository: RepositoryIdentity,
  cloneUrl: Schema.NonEmptyString,
})

export interface HostedRepository extends Schema.Schema.Type<typeof HostedRepository> {}

export const WatchedRepository = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  hosting: Schema.Option(HostedRepository),
  localPaths: Schema.Array(Schema.NonEmptyString),
})

export interface WatchedRepository extends Schema.Schema.Type<typeof WatchedRepository> {}

export class CatalogError extends Schema.TaggedError<CatalogError>()('CatalogError', {
  reason: Schema.Literals(['unavailable', 'invalid', 'busy', 'write-failed']),
}) {}

export class RepositoryCatalog extends Context.Service<
  RepositoryCatalog,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<WatchedRepository>, CatalogError>
    readonly add: (
      repositories: ReadonlyArray<WatchedRepository>,
    ) => Effect.Effect<void, CatalogError>
    readonly remove: (id: string) => Effect.Effect<void, CatalogError>
    readonly relocate: (
      id: string,
      hosting: HostedRepository,
    ) => Effect.Effect<WatchedRepository, CatalogError>
  }
>()('duff/RepositoryCatalog') {}

export function hostedRepositoryId(repository: HostedRepository): string {
  return JSON.stringify([
    repository.provider.id,
    repository.repository.authority.toLowerCase(),
    repository.repository.key,
  ])
}
