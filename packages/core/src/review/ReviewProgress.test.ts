import { expect, it } from '@effect/vitest'
import { Schema } from 'effect'

import { Review, Snapshot } from './BranchReview'
import { fileSnapshots, ReviewProgress, ViewedFiles } from './ReviewProgress'

const review = Review.make({
  root: '/repo',
  baseBranch: 'main',
  headBranch: 'feature',
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  files: [
    { status: 'M', path: 'src/changed.ts' },
    { status: 'A', path: 'src/added.ts' },
    { status: 'D', path: 'src/deleted.ts' },
    { status: 'R', path: 'src/renamed.ts', previousPath: 'old.ts' },
    { status: 'A', path: 'other-added.ts' },
    { status: 'D', path: 'other-deleted.ts' },
  ],
})

it('restores explicit marks only for the current comparison and supports undo', () => {
  const progress = new ReviewProgress(review)
  expect(progress.saved().paths).toEqual([])
  expect(progress.setViewed(review, 'src/renamed.ts', true)).toBe(true)
  progress.setViewed(review, 'src/renamed.ts', true)
  progress.setViewed(review, 'src/deleted.ts', true)
  expect(progress.saved().paths).toEqual(['src/renamed.ts', 'src/deleted.ts'])

  const saved = Schema.decodeUnknownSync(Schema.fromJsonString(ViewedFiles))(
    JSON.stringify(progress.saved()),
  )

  const restored = new ReviewProgress(Review.make({ ...review, baseBranch: 'alias' }), saved)
  expect(restored.isViewed('src/renamed.ts')).toBe(true)
  restored.setViewed(review, 'src/renamed.ts', false)
  expect(restored.saved().paths).toEqual(['src/deleted.ts'])
  expect(restored.setViewed(review, 'not-changed.ts', true)).toBe(false)

  for (const next of [
    Review.make({ ...review, root: '/another-repo' }),
    Review.make({ ...review, baseCommit: 'c'.repeat(40) }),
    Review.make({ ...review, headCommit: 'd'.repeat(40) }),
  ]) {
    const replacement = new ReviewProgress(next, saved)
    expect(replacement.saved().paths).toEqual([])
    expect(replacement.setViewed(review, 'src/renamed.ts', true)).toBe(false)
    expect(new ReviewProgress(review, replacement.saved()).saved().paths).toEqual([])
  }
})

it('marks folders recursively without touching sibling prefixes and rejects stale folder actions', () => {
  const nested = Review.make({
    ...review,
    files: [
      ...review.files,
      { status: 'M', path: 'src/nested/file.ts' },
      { status: 'M', path: 'src-other/file.ts' },
    ],
  })

  const progress = new ReviewProgress(nested)
  progress.setViewed(nested, 'other-added.ts', true)
  expect(progress.setFolderViewed(nested, 'src', true)).toBe(true)
  expect(new Set(progress.saved().paths)).toEqual(
    new Set([
      'other-added.ts',
      'src/changed.ts',
      'src/added.ts',
      'src/deleted.ts',
      'src/renamed.ts',
      'src/nested/file.ts',
    ]),
  )
  expect(
    progress.setFolderViewed(Review.make({ ...nested, headCommit: 'c'.repeat(40) }), 'src', false),
  ).toBe(false)
  expect(progress.isViewed('src/nested/file.ts')).toBe(true)
  expect(progress.setFolderViewed(nested, 'missing', true)).toBe(false)
  expect(progress.setFolderViewed(nested, 'src', false)).toBe(true)
  expect(progress.saved().paths).toEqual(['other-added.ts'])
})

it('targets both immutable diff sides, including empty and renamed sides, without marking on open', () => {
  const progress = new ReviewProgress(review)

  for (const file of review.files) {
    const original =
      file.status === 'A'
        ? Snapshot.make({ root: '/repo', commit: 'a'.repeat(40) })
        : Snapshot.make({
            root: '/repo',
            commit: 'a'.repeat(40),
            path: file.previousPath ?? file.path,
          })

    const modified =
      file.status === 'D'
        ? Snapshot.make({ root: '/repo', commit: 'b'.repeat(40) })
        : Snapshot.make({ root: '/repo', commit: 'b'.repeat(40), path: file.path })

    expect(fileSnapshots(review, file)).toEqual([original, modified])
    expect(progress.activeFile(original, modified)?.path).toBe(file.path)
    expect(progress.activeFile(modified, original)).toBeUndefined()
    expect(
      progress.activeFile(original, Snapshot.make({ ...modified, root: '/elsewhere' })),
    ).toBeUndefined()
    expect(
      progress.activeFile(Snapshot.make({ ...original, commit: 'c'.repeat(40) }), modified),
    ).toBeUndefined()
    expect(
      progress.activeFile(original, Snapshot.make({ ...modified, commit: 'd'.repeat(40) })),
    ).toBeUndefined()
  }

  expect(progress.saved().paths).toEqual([])
})

it.prop(
  'mark and unmark histories remain bounded to current changed paths',
  {
    operations: Schema.Array(
      Schema.Struct({
        index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        viewed: Schema.Boolean,
      }),
    ),
  },
  ({ operations }) => {
    let progress = new ReviewProgress(review)
    const expected = new Set<string>()

    for (const operation of operations) {
      const file = review.files[operation.index]

      if (!file) throw new Error('Invalid generated index')

      if (operation.viewed) expected.add(file.path)
      else expected.delete(file.path)
      progress.setViewed(review, file.path, operation.viewed)
      progress = new ReviewProgress(review, progress.saved())
      expect(new Set(progress.saved().paths)).toEqual(expected)
    }
  },
)
