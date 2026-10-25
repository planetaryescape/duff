import { type DatabaseSync } from 'node:sqlite'

import {
  DashboardPreferences,
  defaultDashboardPreferences,
  reconcileDashboardPreferences,
} from '@duff/core/dashboard-preferences'
import { CatalogError } from '@duff/core/dashboard-repositories'
import { Option, Schema } from 'effect'

const codec = Schema.fromJsonString(Schema.toCodecJson(DashboardPreferences))

const rowSchema = Schema.Struct({ value: Schema.String })

const idsSchema = Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))

export function readDashboardPreferences(database: DatabaseSync): DashboardPreferences {
  const raw = database.prepare('SELECT value FROM dashboard_preferences WHERE id = 1').get()
  const row = raw === undefined ? Option.none() : Schema.decodeUnknownOption(rowSchema)(raw)

  if (raw !== undefined && Option.isNone(row)) throw new CatalogError({ reason: 'invalid' })

  const preferences = Option.isSome(row)
    ? Schema.decodeUnknownOption(codec)(row.value.value)
    : Option.some(defaultDashboardPreferences)

  const ids = Schema.decodeUnknownOption(idsSchema)(
    database.prepare('SELECT id FROM repositories ORDER BY id').all(),
  )

  if (Option.isNone(preferences) || Option.isNone(ids))
    throw new CatalogError({ reason: 'invalid' })

  return reconcileDashboardPreferences(
    preferences.value,
    ids.value.map((row) => row.id),
  )
}

export function writeDashboardPreferences(
  database: DatabaseSync,
  preferences: DashboardPreferences,
): DashboardPreferences {
  database
    .prepare(
      'INSERT INTO dashboard_preferences (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
    )
    .run(Schema.encodeSync(codec)(preferences))

  return preferences
}
