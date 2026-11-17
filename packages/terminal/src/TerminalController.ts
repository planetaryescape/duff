import { join } from 'node:path'

import type { FileChange } from '@duff/core/review'
import { Context, Effect, Layer } from 'effect'

import { moveSelection, navigationRows, revealFile, selectedRow } from './FileNavigation'
import { type EditorError, Neovim } from './Neovim'
import type { Action } from './ReviewApp'
import type { ReviewStore } from './ReviewStore'
import { type TerminalError, TerminalReview } from './TerminalReview'

export class TerminalController extends Context.Service<
  TerminalController,
  { readonly update: (action: Action) => Effect.Effect<void, TerminalError | EditorError> }
>()('duff/terminal/TerminalController') {}

export const makeTerminalControllerLayer = (store: ReviewStore) =>
  Layer.effect(
    TerminalController,
    Effect.gen(function* () {
      const review = yield* TerminalReview
      const editor = yield* Neovim
      let state = store.getSnapshot()
      const files = () => state.review?.review.files ?? []
      const rows = () => navigationRows(files(), state.fileView, state.collapsed)
      const row = () => selectedRow(rows(), state.selection)

      const matchingFile = (path: string) => {
        const root = state.review?.review.root

        return files().find(
          (file) =>
            path === join(root ?? '', file.path) ||
            path === `duff://deleted/${join(root ?? '', file.path)}`,
        )
      }

      const selectFile = (file: FileChange) => {
        state = {
          ...state,
          selection: `file:${file.path}`,
          collapsed: revealFile(state.collapsed, file.path),
        }
      }

      const openFile = Effect.fn('TerminalController.openFile')(function* (file: FileChange) {
        state = { ...state, review: yield* review.open(file), activePath: file.path }
        selectFile(file)
      })

      const selectedFile = () => {
        const current = row()

        if (current?.kind === 'file') return current.file

        if (current?.kind === 'directory')
          return files().find((file) => file.path.startsWith(`${current.path}/`))

        return undefined
      }

      const toggleDirectory = () => {
        const current = row()

        if (current?.kind !== 'directory') return
        const collapsed = new Set(state.collapsed)

        if (current.expanded) collapsed.add(current.path)
        else collapsed.delete(current.path)
        state = { ...state, collapsed, selection: current.key }
      }

      const focusFiles = () => {
        const file = files().find((file) => file.path === state.activePath)

        if (file) selectFile(file)
        state = { ...state, editorFocused: false }
      }

      const navigateHunk = Effect.fn('TerminalController.navigateHunk')(function* (
        direction: number,
      ) {
        if (!state.editorFocused) {
          const selected = selectedFile()

          if (selected && selected.path !== state.activePath) {
            yield* openFile(selected)

            if (direction < 0) yield* editor.hunk(direction, true)

            return
          }
        }

        const movement = yield* editor.hunk(direction)

        if (movement.moved) return
        const current = matchingFile(movement.path)

        if (!current) return

        if (!movement.reviewed) {
          yield* openFile(current)

          if (direction < 0) yield* editor.hunk(direction, true)

          return
        }

        const index = files().findIndex((file) => file.path === current.path)
        const next = files()[index + direction]

        if (!next) return
        yield* openFile(next)

        if (direction < 0) yield* editor.hunk(direction, true)
      })

      const update = Effect.fn('TerminalController.update')(
        function* (action: Action) {
          state = { ...state, error: undefined, busy: false }

          switch (action.type) {
            case 'focus':
              if (state.editorFocused) focusFiles()
              else state = { ...state, editorFocused: true }
              break
            case 'files':
              focusFiles()
              break
            case 'editor':
              state = { ...state, editorFocused: true }
              break
            case 'select':
              state = { ...state, selection: action.key }
              break
            case 'move':
              state = {
                ...state,
                selection: moveSelection(rows(), state.selection, action.direction),
              }
              break
            case 'edge':
              state = { ...state, selection: action.end ? rows().at(-1)?.key : rows()[0]?.key }
              break
            case 'toggleView': {
              const selected = selectedFile()
              state = { ...state, fileView: state.fileView === 'tree' ? 'list' : 'tree' }

              if (selected) selectFile(selected)
              break
            }

            case 'collapse': {
              const current = row()

              if (state.fileView !== 'tree' || !current) break

              if (current.kind === 'directory' && current.expanded) toggleDirectory()
              else {
                const parent = current.path.split('/').slice(0, -1).join('/')

                if (parent) state = { ...state, selection: `directory:${parent}` }
              }

              break
            }

            case 'expand': {
              const current = row()

              if (current?.kind === 'directory') {
                if (!current.expanded) toggleDirectory()
                else state = { ...state, selection: moveSelection(rows(), state.selection, 1) }
              } else if (current?.kind === 'file') {
                state = { ...state, editorFocused: true, busy: true }
                store.set(state)
                yield* openFile(current.file)
              }

              break
            }

            case 'open': {
              const current = row()

              if (current?.kind === 'directory') toggleDirectory()
              else if (current?.kind === 'file') {
                state = { ...state, editorFocused: true, busy: true }
                store.set(state)
                yield* openFile(current.file)
              }

              break
            }

            case 'viewed':
              if (!state.editorFocused) {
                const current = row()

                if (current?.kind !== 'file') break
                yield* openFile(current.file)
              }

              state = { ...state, review: yield* review.toggleViewed() }
              break
            case 'unviewed': {
              const index = files().findIndex((file) => file.path === row()?.path)
              const candidates = [...files().slice(index + 1), ...files().slice(0, index + 1)]
              const next = candidates.find((file) => !state.review?.viewed.has(file.path))

              if (next) selectFile(next)
              break
            }

            case 'active': {
              const file = matchingFile(action.path)
              state = { ...state, activePath: file?.path }

              if (file && state.editorFocused) selectFile(file)
              break
            }

            case 'refresh': {
              const path = state.activePath
              state = { ...state, review: yield* review.load() }
              const file = files().find((file) => file.path === path) ?? files()[0]

              if (file) yield* openFile(file)
              else state = { ...state, activePath: undefined, selection: undefined }
              break
            }

            case 'saved':
              state = { ...state, review: yield* review.saved(action.path, action.hash) }
              break
            case 'hunk':
              yield* navigateHunk(action.direction)
              break
            case 'quit':
              state = { ...state, editorFocused: true }
              store.set(state)
              yield* editor.quit()
              break
            case 'exited':
            case 'stop':
              break
          }
        },
        (effect) =>
          effect.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                state = { ...state, busy: false }
                store.set(state)
              }),
            ),
          ),
      )

      return TerminalController.of({ update })
    }),
  )
