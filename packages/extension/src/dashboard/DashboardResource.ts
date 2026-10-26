import { Data } from 'effect'

export type DashboardResource<A> =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Current'; readonly value: A }
  | { readonly _tag: 'Refreshing'; readonly value: A }
  | { readonly _tag: 'Stale'; readonly value: A; readonly reason: string }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

export function retainedValue<A>(resource: DashboardResource<A>): A | undefined {
  switch (resource._tag) {
    case 'Current':
    case 'Refreshing':
    case 'Stale':
      return resource.value
    case 'Idle':
    case 'Loading':
    case 'Unavailable':
      return undefined
  }
}

export function refreshing<A>(resource: DashboardResource<A>): DashboardResource<A> {
  const value = retainedValue(resource)
  const Resource = Data.taggedEnum<DashboardResource<A>>()

  return value === undefined ? Resource.Loading() : Resource.Refreshing({ value })
}

export function failed<A>(resource: DashboardResource<A>, reason: string): DashboardResource<A> {
  const value = retainedValue(resource)
  const Resource = Data.taggedEnum<DashboardResource<A>>()

  return value === undefined ? Resource.Unavailable({ reason }) : Resource.Stale({ value, reason })
}
