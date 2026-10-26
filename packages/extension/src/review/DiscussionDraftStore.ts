import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import {
  discussionKey,
  sameDiscussion,
  discussionPolicy,
  type DiscussionKey,
  type DraftId,
  type AttemptId,
} from '@duff/core/discussion'
import {
  Attempt,
  AttemptEnvelope,
  AttemptIntent,
  Draft,
  DraftEnvelope,
  DraftRecoveryPage,
  DiscussionDraftStore,
  DraftStorageError,
  transitionAttempt,
} from '@duff/core/discussion-drafts'
import { Effect, Layer, Option, Schema } from 'effect'

const fail = (reason: DraftStorageError['reason']) => new DraftStorageError({ reason })

const draftCodec = Schema.fromJsonString(Schema.toCodecJson(DraftEnvelope))

const attemptCodec = Schema.fromJsonString(Schema.toCodecJson(AttemptEnvelope))

const sameAttempt = Schema.toEquivalence(Attempt)

const DraftRow = Schema.Struct({
  id: Schema.String,
  discussion_key: Schema.String,
  revision: Schema.Int,
  payload_json: Schema.String,
})

const AttemptRow = Schema.Struct({
  id: Schema.String,
  discussion_key: Schema.String,
  target_key: Schema.String,
  phase: Schema.String,
  reserved: Schema.Literals([0, 1]),
  payload_json: Schema.String,
})

const Version = Schema.Struct({ user_version: Schema.Int })

const SqliteError = Schema.Struct({ errcode: Schema.Int })

const Cursor = Schema.fromJsonString(
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literals(['Attempt', 'Draft']),
    id: Schema.NonEmptyString,
  }),
)

const PageRow = Schema.Struct({
  kind: Schema.Literals(['Attempt', 'Draft']),
  id: Schema.NonEmptyString,
})

function privateFile(directory: string, file: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const root = lstatSync(directory)

  if (!root.isDirectory() || (process.getuid !== undefined && root.uid !== process.getuid()))
    throw fail('unavailable')
  chmodSync(directory, 0o700)
  const handle = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)

  try {
    const stat = fstatSync(handle)

    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw fail('unavailable')
    fchmodSync(handle, 0o600)
  } finally {
    closeSync(handle)
  }
}

function decodeDraft(row: Record<string, SQLOutputValue>): Draft {
  const data = Schema.decodeUnknownOption(DraftRow)(row)

  if (Option.isNone(data)) throw fail('invalid')
  const decoded = Schema.decodeUnknownOption(draftCodec)(data.value.payload_json)

  if (Option.isNone(decoded)) throw fail('invalid')
  const draft = decoded.value.value

  if (
    data.value.id !== draft.id ||
    data.value.discussion_key !== discussionKey(draft.key) ||
    data.value.revision !== draft.version ||
    !sameDiscussion(draft.key, draft.origin.key) ||
    (draft.target._tag === 'Reply' && !sameDiscussion(draft.key, draft.target.thread.discussion))
  )
    throw fail('invalid')

  return draft
}

function decodeAttempt(row: Record<string, SQLOutputValue>): Attempt {
  const data = Schema.decodeUnknownOption(AttemptRow)(row)

  if (Option.isNone(data)) throw fail('invalid')
  const decoded = Schema.decodeUnknownOption(attemptCodec)(data.value.payload_json)

  if (Option.isNone(decoded)) throw fail('invalid')

  const attempt = decoded.value.value

  if (
    data.value.id !== attempt.intent.id ||
    data.value.discussion_key !== discussionKey(attempt.intent.key) ||
    data.value.target_key !== targetKey(attempt.intent) ||
    data.value.phase !== attempt._tag
  )
    throw fail('invalid')

  if (
    attempt.intent.input._tag === 'Draft' &&
    !sameDiscussion(attempt.intent.key, attempt.intent.input.draft.key)
  )
    throw fail('invalid')

  if (
    attempt.intent.input._tag === 'Resolution' &&
    (!sameDiscussion(attempt.intent.key, attempt.intent.input.command.thread.discussion) ||
      attempt.intent.input.command.attempt !== attempt.intent.id)
  )
    throw fail('invalid')

  return attempt
}

function targetKey(intent: AttemptIntent): string {
  const input = intent.input

  if (input._tag === 'Resolution')
    return JSON.stringify([discussionKey(intent.key), 'thread', input.command.thread.id])

  if (input.draft.target._tag === 'Reply')
    return JSON.stringify([discussionKey(intent.key), 'thread', input.draft.target.thread.id])
  const anchor = input.draft.target.anchor

  return JSON.stringify([
    discussionKey(intent.key),
    'new',
    [
      anchor.comparison.sourceRepository.authority,
      anchor.comparison.sourceRepository.key,
      anchor.comparison.sourceRevision,
      anchor.comparison.targetRevision,
      anchor.comparison.baseRevision,
      anchor.comparison.mode,
    ],
    anchor.change.path,
    anchor.side,
    anchor.range,
  ])
}

export const makeDiscussionDraftStoreLayer = (
  directory: string,
): Layer.Layer<DiscussionDraftStore> =>
  Layer.sync(DiscussionDraftStore, () => {
    const file = join(directory, 'discussion.sqlite')

    const transaction = <A>(operation: (db: DatabaseSync) => A) =>
      Effect.try({
        try: () => {
          privateFile(directory, file)
          const db = new DatabaseSync(file)

          try {
            db.exec('PRAGMA busy_timeout = 1500; PRAGMA synchronous = FULL; BEGIN IMMEDIATE')

            try {
              const version = Schema.decodeUnknownOption(Version)(
                db.prepare('PRAGMA user_version').get(),
              )

              if (
                Option.isNone(version) ||
                version.value.user_version < 0 ||
                version.value.user_version > 1
              )
                throw fail('invalid')

              if (version.value.user_version === 0) {
                if (
                  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length !==
                  0
                )
                  throw fail('invalid')
                db.exec(`CREATE TABLE drafts (id TEXT PRIMARY KEY, discussion_key TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL) STRICT;
              CREATE INDEX draft_discussion ON drafts(discussion_key, id);
              CREATE TABLE attempts (id TEXT PRIMARY KEY, discussion_key TEXT NOT NULL, target_key TEXT NOT NULL, phase TEXT NOT NULL, reserved INTEGER NOT NULL, payload_json TEXT NOT NULL) STRICT;
              CREATE INDEX attempt_discussion ON attempts(discussion_key, id);
              CREATE INDEX attempt_recovery ON attempts(reserved, id);
              CREATE UNIQUE INDEX attempt_reservation ON attempts(target_key) WHERE reserved = 1;
              PRAGMA user_version = 1`)
              }

              const result = operation(db)
              db.exec('COMMIT')

              return result
            } catch (error) {
              db.exec('ROLLBACK')
              throw error
            }
          } finally {
            db.close()
          }
        },
        catch: (error) => {
          if (error instanceof DraftStorageError) return error
          const decoded = Schema.decodeUnknownOption(SqliteError)(error)

          if (Option.isSome(decoded)) {
            const code = decoded.value.errcode & 0xff

            if (code === 5 || code === 6) return fail('busy')

            if (code === 19) return fail('conflict')

            if (code === 11 || code === 26 || code === 1) return fail('invalid')
          }

          return fail('write-failed')
        },
      })

    const getDraft = (db: DatabaseSync, id: DraftId) => {
      const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id)

      return row === undefined ? Option.none<Draft>() : Option.some(decodeDraft(row))
    }

    const getAttempt = (db: DatabaseSync, id: AttemptId) => {
      const row = db.prepare('SELECT * FROM attempts WHERE id = ?').get(id)

      return row === undefined ? Option.none<Attempt>() : Option.some(decodeAttempt(row))
    }

    const requireDraft = (db: DatabaseSync, id: DraftId, version: number) => {
      const value = getDraft(db, id)

      if (Option.isNone(value) || value.value.version !== version) throw fail('conflict')

      return value.value
    }

    const requireAttempt = (db: DatabaseSync, id: AttemptId) => {
      const value = getAttempt(db, id)

      if (Option.isNone(value)) throw fail('conflict')

      return value.value
    }

    const writeAttempt = (db: DatabaseSync, attempt: Attempt, reserved: boolean) =>
      db
        .prepare(
          'UPDATE attempts SET phase = ?, reserved = CASE WHEN reserved = 1 THEN ? ELSE 0 END, payload_json = ? WHERE id = ?',
        )
        .run(
          attempt._tag,
          reserved ? 1 : 0,
          Schema.encodeSync(attemptCodec)({ version: 1, value: attempt }),
          attempt.intent.id,
        )

    const page = (
      db: DatabaseSync,
      key: Option.Option<DiscussionKey>,
      cursor: Option.Option<string>,
    ) => {
      const identity = Option.isSome(key) ? discussionKey(key.value) : 'all'
      let afterKind = ''
      let afterId = ''

      if (Option.isSome(cursor)) {
        const decoded = Schema.decodeUnknownOption(Cursor)(cursor.value)

        if (Option.isNone(decoded) || decoded.value.key !== identity) throw fail('invalid')
        afterKind = decoded.value.kind
        afterId = decoded.value.id
      }

      const rows = db
        .prepare(`SELECT * FROM (
        SELECT 'Draft' AS kind, id, discussion_key, revision, payload_json, NULL AS target_key, NULL AS phase, NULL AS reserved FROM drafts
        UNION ALL SELECT 'Attempt' AS kind, id, discussion_key, NULL AS revision, payload_json, target_key, phase, reserved FROM attempts WHERE reserved = 1
      ) WHERE (? IS NULL OR discussion_key = ?) AND (kind > ? OR (kind = ? AND id > ?)) ORDER BY kind, id LIMIT ?`)
        .all(
          Option.isSome(key) ? identity : null,
          Option.isSome(key) ? identity : null,
          afterKind,
          afterKind,
          afterId,
          discussionPolicy.draftPageSize + 1,
        )

      const drafts: Draft[] = []
      const attempts: Attempt[] = []
      let next: Option.Option<string> = Option.none()

      for (const row of rows.slice(0, discussionPolicy.draftPageSize)) {
        const decoded = Schema.decodeUnknownOption(PageRow)(row)

        if (Option.isNone(decoded)) throw fail('invalid')

        if (decoded.value.kind === 'Draft') drafts.push(decodeDraft(row))
        else attempts.push(decodeAttempt(row))

        if (rows.length > discussionPolicy.draftPageSize)
          next = Option.some(
            Schema.encodeSync(Cursor)({
              key: identity,
              kind: decoded.value.kind,
              id: decoded.value.id,
            }),
          )
      }

      const decoded = Schema.decodeUnknownOption(DraftRecoveryPage)({ drafts, attempts, next })

      if (Option.isNone(decoded)) throw fail('invalid')

      return decoded.value
    }

    return DiscussionDraftStore.of({
      listAll: Effect.fn('DiscussionDraftStore.listAll')((cursor) =>
        transaction((db) => page(db, Option.none(), cursor)),
      ),
      list: Effect.fn('DiscussionDraftStore.list')((key, cursor) =>
        transaction((db) => page(db, Option.some(key), cursor)),
      ),
      get: Effect.fn('DiscussionDraftStore.get')((id: DraftId) =>
        transaction((db) => getDraft(db, id)),
      ),
      create: Effect.fn('DiscussionDraftStore.create')((input: Draft) =>
        transaction((db) => {
          const draft = Schema.decodeUnknownOption(Draft)(input)

          if (Option.isNone(draft) || draft.value.version !== 1) throw fail('invalid')
          const text = Schema.encodeSync(draftCodec)({ version: 1, value: draft.value })
          decodeDraft({
            id: input.id,
            discussion_key: discussionKey(input.key),
            revision: input.version,
            payload_json: text,
          })
          db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?)').run(
            input.id,
            discussionKey(input.key),
            input.version,
            text,
          )

          return draft.value
        }),
      ),
      save: Effect.fn('DiscussionDraftStore.save')((input) =>
        transaction((db) => {
          const previous = requireDraft(db, input.id, input.expectedVersion)

          const decoded = Schema.decodeUnknownOption(Draft)({
            id: previous.id,
            key: previous.key,
            origin: previous.origin,
            target: previous.target,
            version: previous.version + 1,
            body: input.body,
          })

          if (Option.isNone(decoded)) throw fail('limit')
          const draft = decoded.value
          db.prepare(
            'UPDATE drafts SET revision = ?, payload_json = ? WHERE id = ? AND revision = ?',
          ).run(
            draft.version,
            Schema.encodeSync(draftCodec)({ version: 1, value: draft }),
            draft.id,
            previous.version,
          )

          return draft
        }),
      ),
      discard: Effect.fn('DiscussionDraftStore.discard')((input) =>
        transaction((db) => {
          const draft = requireDraft(db, input.id, input.expectedVersion)

          const attempt = db
            .prepare(
              "SELECT * FROM attempts WHERE discussion_key = ? AND reserved = 1 AND json_extract(payload_json, '$.value.intent.input.draft.id') = ? LIMIT 1",
            )
            .get(discussionKey(draft.key), draft.id)

          if (attempt !== undefined) {
            decodeAttempt(attempt)
            throw fail('conflict')
          }

          db.prepare('DELETE FROM drafts WHERE id = ? AND revision = ?').run(
            input.id,
            input.expectedVersion,
          )
        }),
      ),
      prepare: Effect.fn('DiscussionDraftStore.prepare')((intent) =>
        transaction((db) => {
          if (intent.input._tag === 'Draft') {
            const draft = requireDraft(db, intent.input.draft.id, intent.input.draft.version)

            if (
              Schema.encodeSync(draftCodec)({ version: 1, value: draft }) !==
                Schema.encodeSync(draftCodec)({ version: 1, value: intent.input.draft }) ||
              !sameDiscussion(draft.key, intent.key)
            )
              throw fail('conflict')
          } else if (!sameDiscussion(intent.key, intent.input.command.thread.discussion))
            throw fail('invalid')
          const attempt = Attempt.make({ _tag: 'Prepared', intent })
          db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, 1, ?)').run(
            intent.id,
            discussionKey(intent.key),
            targetKey(intent),
            attempt._tag,
            Schema.encodeSync(attemptCodec)({ version: 1, value: attempt }),
          )

          return attempt
        }),
      ),
      dispatch: Effect.fn('DiscussionDraftStore.dispatch')(function* (id) {
        const previous = yield* transaction((db) => requireAttempt(db, id))

        const next = yield* transitionAttempt(previous, {
          _tag: 'Dispatching',
          intent: previous.intent,
        })

        return yield* transaction((db) => {
          const row = db
            .prepare("SELECT * FROM attempts WHERE id = ? AND phase = 'Prepared' AND reserved = 1")
            .get(id)

          if (row === undefined || !sameAttempt(decodeAttempt(row), previous))
            throw fail('conflict')
          writeAttempt(db, next, true)

          return next
        })
      }),
      finish: Effect.fn('DiscussionDraftStore.finish')(function* (input) {
        const decoded = yield* Schema.decodeUnknownEffect(Attempt)(input).pipe(
          Effect.mapError(() => fail('invalid')),
        )

        if (
          decoded._tag !== 'Confirmed' &&
          decoded._tag !== 'Rejected' &&
          decoded._tag !== 'Uncertain'
        )
          return yield* fail('conflict')
        const previous = yield* transaction((db) => requireAttempt(db, decoded.intent.id))
        const attempt = yield* transitionAttempt(previous, decoded)
        yield* transaction((db) => {
          const old = requireAttempt(db, attempt.intent.id)

          if (!sameAttempt(old, previous)) throw fail('conflict')
          const submitted = attempt.intent.input

          const retained =
            (attempt._tag === 'Confirmed' || attempt._tag === 'Rejected') &&
            submitted._tag === 'Draft'
              ? Attempt.make({
                  ...attempt,
                  intent: AttemptIntent.make({
                    id: attempt.intent.id,
                    key: attempt.intent.key,
                    input: {
                      _tag: 'Draft',
                      draft: Draft.make({
                        id: submitted.draft.id,
                        key: submitted.draft.key,
                        origin: submitted.draft.origin,
                        target: submitted.draft.target,
                        version: submitted.draft.version,
                        body: '',
                      }),
                    },
                  }),
                })
              : attempt

          writeAttempt(db, retained, attempt._tag === 'Uncertain')

          if (attempt._tag === 'Confirmed' && attempt.intent.input._tag === 'Draft') {
            const draft = attempt.intent.input.draft
            db.prepare('DELETE FROM drafts WHERE id = ? AND revision = ?').run(
              draft.id,
              draft.version,
            )
          }
        })
      }),
      getAttempt: Effect.fn('DiscussionDraftStore.getAttempt')((id) =>
        transaction((db) => getAttempt(db, id)),
      ),
      acknowledgeUncertain: Effect.fn('DiscussionDraftStore.acknowledgeUncertain')((id) =>
        transaction((db) => {
          const old = requireAttempt(db, id)

          if (old._tag !== 'Uncertain' && old._tag !== 'Dispatching' && old._tag !== 'Prepared')
            throw fail('conflict')

          if (old._tag === 'Prepared') {
            writeAttempt(
              db,
              Attempt.make({ _tag: 'Rejected', intent: old.intent, reason: 'conflict' }),
              false,
            )

            return
          }

          db.prepare('UPDATE attempts SET reserved = 0 WHERE id = ?').run(id)
        }),
      ),
    })
  })
