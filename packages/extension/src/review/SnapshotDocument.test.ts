import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { discussionFixture } from './DiscussionFixture'
import {
  commentableDocument,
  decodeSnapshotDocument,
  encodeSnapshotDocument,
  snapshotDocument,
} from './SnapshotDocument'

describe('immutable discussion document identity', () => {
  it('separates PRs and sides even when the content is identical', () => {
    const review = discussionFixture()
    const other = discussionFixture('23')

    for (const change of review.review.files) {
      const base = snapshotDocument(review, change, 'base')
      const head = snapshotDocument(review, change, 'head')
      expect(encodeSnapshotDocument(base)).not.toBe(encodeSnapshotDocument(head))
      expect(encodeSnapshotDocument(base)).not.toBe(
        encodeSnapshotDocument(snapshotDocument(other, change, 'base')),
      )
      expect(encodeSnapshotDocument(base)).toBe(
        encodeSnapshotDocument(snapshotDocument(review, change, 'base')),
      )
      const parsed = decodeSnapshotDocument(encodeSnapshotDocument(base))
      expect(Option.isSome(parsed) && commentableDocument(parsed.value, review)).toBe(true)
      expect(Option.isSome(parsed) && commentableDocument(parsed.value, other)).toBe(false)
    }
  })
  it('retains legacy content without granting comment authority', () => {
    const review = discussionFixture()

    const legacy = decodeSnapshotDocument(
      JSON.stringify({
        root: review.review.root,
        commit: review.review.headCommit,
        path: 'src/main.ts',
      }),
    )

    expect(Option.isSome(legacy) && legacy.value._tag).toBe('Legacy')
    expect(Option.isSome(legacy) && commentableDocument(legacy.value, review)).toBe(false)
  })
  it('rejects contradictory comparison, version, commit and path authority', () => {
    const review = discussionFixture()
    const change = review.review.files[0]

    if (!change) throw new Error('Fixture has no change')
    const document = snapshotDocument(review, change, 'head')

    if (document._tag !== 'PrReview') throw new Error('Expected qualification')
    expect(Option.isNone(decodeSnapshotDocument(JSON.stringify({ ...document, version: 2 })))).toBe(
      true,
    )
    expect(
      Option.isNone(
        decodeSnapshotDocument(
          JSON.stringify({
            ...document,
            discussion: { ...document.discussion, pullRequestId: 'wrong' },
          }),
        ),
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        decodeSnapshotDocument(
          JSON.stringify({
            ...document,
            snapshot: { ...document.snapshot, commit: 'c'.repeat(40) },
          }),
        ),
      ),
    ).toBe(true)
    const forgedPath = { ...document, snapshot: { ...document.snapshot, path: 'other.ts' } }
    const decoded = decodeSnapshotDocument(JSON.stringify(forgedPath))
    expect(Option.isSome(decoded) && commentableDocument(decoded.value, review)).toBe(false)
    expect(Option.isNone(decodeSnapshotDocument('{'))).toBe(true)
    expect(
      Option.isNone(
        decodeSnapshotDocument(
          JSON.stringify({
            ...document,
            version: 2,
            root: document.snapshot.root,
            commit: document.snapshot.commit,
            path: document.snapshot.path,
          }),
        ),
      ),
    ).toBe(true)
  })
})
