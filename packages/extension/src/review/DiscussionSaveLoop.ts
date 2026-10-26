import { Effect, Schema, Semaphore } from 'effect'

export interface DraftDocument {
  readonly isDirty: boolean
  readonly version: number
  readonly getText: () => string
  readonly save: () => PromiseLike<boolean>
}

export class DraftSaveFailed extends Schema.TaggedError<DraftSaveFailed>()('DraftSaveFailed', {}) {}

export class DiscussionSaveLoop {
  private readonly lane = Semaphore.makeUnsafe(1)

  flush(document: DraftDocument, acknowledged: () => string) {
    const pass = Effect.fn('DiscussionDraft.flushPass')(function* (): Effect.fn.Return<
      void,
      DraftSaveFailed
    > {
      if (!document.isDirty) return

      const saved = yield* Effect.tryPromise({
        try: async () => await document.save(),
        catch: () => new DraftSaveFailed(),
      })

      if (!saved || (!document.isDirty && acknowledged() !== document.getText()))
        return yield* new DraftSaveFailed()

      if (document.isDirty) yield* pass()
    })

    return pass().pipe(this.lane.withPermits(1))
  }
}
