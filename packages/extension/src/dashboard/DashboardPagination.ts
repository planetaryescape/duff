import { RepositoryNavigationSnapshot } from '@duff/core/dashboard-data'
import { type RepositoryPullRequestPage } from '@duff/core/repository-directory'
import { Option } from 'effect'

import { type DashboardState } from './DashboardState'

type PageChange =
  | { readonly _tag: 'First'; readonly revision: number }
  | { readonly _tag: 'More'; readonly revision: number }

export class DashboardPagination {
  #snapshot: RepositoryNavigationSnapshot | undefined

  get cursor() {
    return this.#snapshot?.cursor ?? Option.none()
  }

  snapshot(state: DashboardState): RepositoryNavigationSnapshot | undefined {
    return this.#snapshot
      ? RepositoryNavigationSnapshot.make({
          cursor: this.#snapshot.cursor,
          pages: this.#snapshot.pages,
          listRevision: this.#snapshot.listRevision,
          pulls: state.pulls,
          filter: state.filter,
          query: state.query,
          pullRequestId: state.pullRequestId,
        })
      : undefined
  }

  clear(): void {
    this.#snapshot = undefined
  }

  restore(state: DashboardState, snapshot: RepositoryNavigationSnapshot): void {
    this.#snapshot = snapshot
    state.pulls = snapshot.pulls
    state.filter = snapshot.filter
    state.query = snapshot.query
    state.pullRequestId = snapshot.pullRequestId
    state.more = this.canLoadMore(snapshot)
  }

  apply(state: DashboardState, page: RepositoryPullRequestPage, change: PageChange): boolean {
    const previous = this.snapshot(state)

    if (previous && change.revision < previous.listRevision) return false

    if (
      change._tag === 'More' &&
      (!previous || previous.listRevision !== change.revision || !this.canLoadMore(previous))
    )
      return false
    const retain = previous && (change._tag === 'More' || previous.listRevision === change.revision)
    const items = new Map((retain ? previous.pulls : []).map((pull) => [pull.id, pull]))

    for (const pull of page.items) items.set(pull.id, pull)
    const pulls = [...items.values()].slice(0, 250)
    const selectedId = state.pullRequestId

    const snapshot = RepositoryNavigationSnapshot.make({
      filter: state.filter,
      pulls,
      pullRequestId: pulls.some((pull) => pull.id === selectedId)
        ? selectedId
        : (pulls[0]?.id ?? ''),
      query: state.query,
      pages:
        change._tag === 'More'
          ? Math.min(5, (previous?.pages ?? 0) + 1)
          : retain
            ? previous.pages
            : 1,
      cursor: change._tag === 'First' && retain ? previous.cursor : page.next,
      listRevision: change._tag === 'First' ? change.revision : (previous?.listRevision ?? 0),
    })

    this.restore(state, snapshot)

    return true
  }

  private canLoadMore(snapshot: RepositoryNavigationSnapshot): boolean {
    return snapshot.pages < 5 && snapshot.pulls.length < 250 && Option.isSome(snapshot.cursor)
  }
}
