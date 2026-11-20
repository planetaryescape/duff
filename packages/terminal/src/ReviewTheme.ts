import type { FileChange } from '@duff/core/review'
import { createContext, useContext } from 'react'

export type ReviewMode = 'light' | 'dark'

export interface ReviewPalette {
  readonly background: string
  readonly panel: string
  readonly text: string
  readonly accent: string
  readonly muted: string
  readonly border: string
  readonly focusedBorder: string
  readonly selected: string
  readonly status: Readonly<Record<FileChange['status'], string>>
}

export const reviewPalettes: Readonly<Record<ReviewMode, ReviewPalette>> = {
  dark: {
    background: '#14181e',
    panel: '#202832',
    text: '#e6eaf0',
    accent: '#a9c5e2',
    muted: '#a0aab8',
    border: '#526273',
    focusedBorder: '#7799bb',
    selected: '#263242',
    status: {
      A: '#7ec699',
      M: '#e5c07b',
      D: '#ef9b91',
      R: '#78c6e0',
      C: '#78c6e0',
      T: '#c49ae0',
    },
  },
  light: {
    background: '#eff1f5',
    panel: '#e3e8f1',
    text: '#282f3d',
    accent: '#284d78',
    muted: '#505c6c',
    border: '#7b8798',
    focusedBorder: '#3c6590',
    selected: '#dae3f1',
    status: {
      A: '#236244',
      M: '#744e13',
      D: '#9e2f2c',
      R: '#1b5b72',
      C: '#1b5b72',
      T: '#71438e',
    },
  },
}

export const ReviewPaletteContext = createContext(reviewPalettes.dark)

export function useReviewPalette(): ReviewPalette {
  return useContext(ReviewPaletteContext)
}
