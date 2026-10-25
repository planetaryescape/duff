import { Effect, Option, Schema, Semaphore } from 'effect'

const Preference = Schema.Struct({
  version: Schema.Literal(1),
  visibility: Schema.Literals(['shown', 'hidden']),
})

export type DiscussionVisibility = Schema.Schema.Type<typeof Preference>['visibility']

export interface VisibilityMemento {
  readonly get: (key: string) => Schema.Json | undefined
  readonly update: (key: string, value: Schema.Json) => PromiseLike<void>
}

export class DiscussionVisibilityPreference {
  private value: DiscussionVisibility
  private readonly writes = Semaphore.makeUnsafe(1)
  constructor(private readonly storage: VisibilityMemento) {
    const parsed = Schema.decodeUnknownOption(Preference)(storage.get('discussionVisibility.v1'))
    this.value = Option.isSome(parsed) ? parsed.value.visibility : 'shown'
  }
  current(): DiscussionVisibility {
    return this.value
  }
  toggle() {
    return Effect.tryPromise({
      try: async () => {
        const visibility = this.value === 'shown' ? 'hidden' : 'shown'
        await this.storage.update('discussionVisibility.v1', { version: 1, visibility })
        this.value = visibility

        return visibility
      },
      catch: () => new VisibilitySaveFailed(),
    }).pipe(this.writes.withPermits(1))
  }
}

export class VisibilitySaveFailed extends Schema.TaggedError<VisibilitySaveFailed>()(
  'VisibilitySaveFailed',
  {},
) {}
