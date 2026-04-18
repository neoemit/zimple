import { useSyncExternalStore } from 'react'

const getQueryMatch = (query: string): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }

  return window.matchMedia(query).matches
}

const subscribeToQuery = (query: string, onStoreChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }

  const mediaQuery = window.matchMedia(query)

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onStoreChange)
    return () => mediaQuery.removeEventListener('change', onStoreChange)
  }

  mediaQuery.addListener(onStoreChange)
  return () => mediaQuery.removeListener(onStoreChange)
}

export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (onStoreChange) => subscribeToQuery(query, onStoreChange),
    () => getQueryMatch(query),
    () => false,
  )
