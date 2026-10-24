/** 领域错误：统一带 code，方便 IPC 层转成结构化错误 */
export class CoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'CoreError'
  }
}

export function toCoreError(err: unknown): CoreError {
  if (err instanceof CoreError) return err
  if (err instanceof Error) return new CoreError('INTERNAL', err.message)
  return new CoreError('INTERNAL', String(err))
}
