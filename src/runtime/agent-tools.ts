import type { ApiToolDef } from './llm.ts'

export interface RuntimeToolResult {
  text: string
  isError: boolean
  yield?: boolean
}

export interface RuntimeToolset {
  definitions(): Promise<ApiToolDef[]>
  call(name: string, argumentsText: string, signal: AbortSignal, callId: string): Promise<RuntimeToolResult>
  close?(): Promise<void>
}
