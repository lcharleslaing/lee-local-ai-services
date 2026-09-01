import type { ServiceLogEntry } from '@leelaing/service-manager'

export type ExtensibleString<T extends string> = T | (string & {})
export type LocalAIServiceType = ExtensibleString<'llm' | 'transcription' | 'image' | 'embedding' | 'audio' | 'custom'>
export type LocalAIProvider = ExtensibleString<'llama.cpp' | 'whisper.cpp' | 'faster-whisper' | 'ollama' | 'lm-studio' | 'comfyui' | 'openai-compatible' | 'custom'>
export type AICapability = ExtensibleString<'chat' | 'completion' | 'transcription' | 'embedding' | 'image-generation'>

export interface LocalAICommand {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface LocalAIHealthCheck {
  url?: string
  path?: string
  timeoutMs?: number
  acceptedStatusCodes?: number[]
}

export interface LocalAIServiceDefinition {
  id: string
  name?: string
  type: LocalAIServiceType
  provider: LocalAIProvider
  host?: string
  port: number
  command: LocalAICommand
  model?: string
  modelDirectory?: string
  capabilities?: AICapability[]
  healthCheck?: LocalAIHealthCheck | false
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  pollIntervalMs?: number
  logLimit?: number
  metadata?: Record<string, unknown>
}

export type LocalAIServiceState = 'unknown' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export interface LocalAIServiceStatus {
  id: string
  name: string
  type: LocalAIServiceType
  provider: LocalAIProvider
  state: LocalAIServiceState
  running: boolean
  healthy: boolean | null
  portOpen: boolean | null
  host: string
  port: number
  pid: number | null
  model?: string
  exitCode: number | null
  startedAt: Date | null
  stoppedAt: Date | null
}

export interface ExecutableInstallation {
  provider: LocalAIProvider
  executable: string
  available: boolean
}

export type ModelType = ExtensibleString<'llm' | 'whisper' | 'image' | 'embedding' | 'unknown'>
export interface DiscoveredModel {
  path: string
  filename: string
  type: ModelType
  format: string
  sizeBytes: number
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }
export interface ChatRequest {
  service?: string
  messages: ChatMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
  stream?: false
  extra?: Record<string, unknown>
  signal?: AbortSignal
}
export interface ChatChoice { index: number; message: ChatMessage; finishReason?: string | null }
export interface ChatResponse { id?: string; model?: string; choices: ChatChoice[]; usage?: Record<string, number>; raw: unknown }

export interface LocalAIManagerOptions {
  services: LocalAIServiceDefinition[]
  fetch?: typeof globalThis.fetch
}

export interface LocalAIReportOptions {
  title?: string
  includeConfiguration?: boolean
  includeLogs?: boolean
  logLines?: number
  models?: DiscoveredModel[]
  installations?: ExecutableInstallation[]
}

export interface ClipboardWriter { writeText(text: string): Promise<void> }

export interface LocalAIManagerEvents {
  'service:state': [id: string, state: LocalAIServiceState]
  'service:start': [status: LocalAIServiceStatus]
  'service:ready': [status: LocalAIServiceStatus]
  'service:stop': [status: LocalAIServiceStatus]
  'service:error': [id: string, error: Error]
  'service:log': [id: string, entry: ServiceLogEntry]
  'model:changed': [id: string, model: string | undefined]
}
