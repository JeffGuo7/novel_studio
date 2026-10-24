import { diffWordsWithSpace } from 'diff'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 词级 diff：中文按字/词切分，比行级 diff 更适合改稿对比 */
export function renderWordDiff(before: string | null, after: string | null): string {
  const oldText = before ?? ''
  const newText = after ?? ''
  const parts = diffWordsWithSpace(oldText, newText)
  return parts
    .map((part) => {
      const text = escapeHtml(part.value)
      if (part.added) return `<ins class="diff-ins">${text}</ins>`
      if (part.removed) return `<del class="diff-del">${text}</del>`
      return text
    })
    .join('')
}

export function diffStat(before: string | null, after: string | null): { added: number; removed: number } {
  const parts = diffWordsWithSpace(before ?? '', after ?? '')
  let added = 0
  let removed = 0
  for (const part of parts) {
    if (part.added) added += part.value.length
    if (part.removed) removed += part.value.length
  }
  return { added, removed }
}
