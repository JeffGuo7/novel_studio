import type { StudioApi, Result } from '@shared/types'

export const studio: StudioApi = window.studio

export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

export function formatTime(timestamp: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatWords(words: number): string {
  if (words >= 10000) return `${(words / 10000).toFixed(1)} 万字`
  return `${words} 字`
}
