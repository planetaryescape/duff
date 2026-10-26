import { describe, expect, it } from 'vitest'

import { discussionCommentLabel } from './DiscussionCommentPresentation'

describe('native provider comment publication labels', () => {
  it('keeps pending review content visibly distinct from published comments', () => {
    expect(discussionCommentLabel('pending', true)).toBe('Pending review, not published')
    expect(discussionCommentLabel('pending', false)).toBe(
      'Pending review, not published · Partial thread',
    )
    expect(discussionCommentLabel('published', true)).toBeUndefined()
    expect(discussionCommentLabel('published', false)).toBe('Partial thread')
  })
})
