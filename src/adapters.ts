import { normalizeLlamaCppFallback, planLlamaCppLaunch, type PlanLlamaCppLaunchOptions } from './llama-planner.js'
import { resolveWhisperService, type ResolveWhisperServiceOptions } from './whisper.js'
import { MusicWhisperClient, WhisperCppTranscriptionAdapter, type MusicWhisperClientOptions, type TranscriptionAdapter } from './transcription.js'
import type { GgufModelInfo, GpuOffloadOptions, LlamaCppFallbackOptions, LocalAIServiceDefinition, WhisperServiceResolution } from './types.js'

export interface LlamaCppServiceOptions {
  id: string
  name?: string
  model: string
  executable?: string
  host?: string
  port?: number
  gpuLayers?: number
  contextSize?: number
  threads?: number
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  healthPath?: string
  gpuOffload?: GpuOffloadOptions
  fallback?: LlamaCppFallbackOptions
}

export function defineLlamaCppService(options: LlamaCppServiceOptions): LocalAIServiceDefinition {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8080
  const args = ['-m', options.model, '--host', host, '--port', String(port)]
  const requestedMode = options.gpuOffload?.mode ?? 'manual'
  if (options.gpuOffload && requestedMode !== 'manual') throw new Error('Automatic GPU offload requires definePlannedLlamaCppService() because hardware and GGUF discovery are asynchronous.')
  const gpuLayers = options.gpuOffload?.gpuLayers ?? options.gpuLayers
  if (gpuLayers !== undefined) args.push('-ngl', String(gpuLayers))
  if (options.contextSize !== undefined) args.push('-c', String(options.contextSize))
  if (options.threads !== undefined) args.push('-t', String(options.threads))
  args.push(...(options.args ?? []))
  return {
    id: options.id,
    name: options.name,
    type: 'llm',
    provider: 'llama.cpp',
    host,
    port,
    model: options.model,
    capabilities: ['chat', 'completion', 'embedding'],
    command: { command: options.executable ?? 'llama-server', args, cwd: options.cwd, env: options.env },
    healthCheck: { path: options.healthPath ?? '/health' },
    llamaCpp: gpuLayers === undefined ? undefined : {
      requestedMode,
      plannedGpuLayers: gpuLayers,
      actualGpuLayers: gpuLayers,
      fallback: normalizeLlamaCppFallback(options.fallback),
      launchAttempts: [],
    },
  }
}

export interface PlannedLlamaCppServiceOptions extends Omit<LlamaCppServiceOptions, 'gpuLayers'> {
  gpuOffload?: GpuOffloadOptions
  planning?: Omit<PlanLlamaCppLaunchOptions, 'model' | 'contextSize' | 'gpuOffload'> & { modelInfo?: GgufModelInfo }
}

export async function definePlannedLlamaCppService(options: PlannedLlamaCppServiceOptions): Promise<LocalAIServiceDefinition> {
  const plan = await planLlamaCppLaunch({
    model: options.planning?.modelInfo ?? options.model,
    contextSize: options.contextSize,
    gpuOffload: options.gpuOffload ?? { mode: 'auto' },
    hardware: options.planning?.hardware,
    hardwareDiscovery: options.planning?.hardwareDiscovery,
  })
  const { planning: _planning, gpuOffload: _gpuOffload, ...baseOptions } = options
  void _planning
  void _gpuOffload
  const definition = defineLlamaCppService({
    ...baseOptions,
    gpuOffload: { mode: 'manual', gpuLayers: plan.recommendedGpuLayers },
  })
  definition.llamaCpp = {
    requestedMode: plan.mode,
    plannedGpuLayers: plan.recommendedGpuLayers,
    actualGpuLayers: plan.recommendedGpuLayers,
    launchPlan: plan,
    fallback: normalizeLlamaCppFallback(options.fallback),
    launchAttempts: [],
  }
  return definition
}

export interface WhisperServiceOptions {
  id: string
  name?: string
  model?: string
  executable?: string
  provider?: 'whisper.cpp' | 'faster-whisper' | (string & {})
  host?: string
  port?: number
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  healthPath?: string
  managed?: boolean
  external?: boolean
  connectable?: boolean
  startable?: boolean
  resolution?: WhisperServiceResolution
  transcriptionAdapter?: TranscriptionAdapter
}

export function defineWhisperService(options: WhisperServiceOptions): LocalAIServiceDefinition {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8178
  const external = options.external ?? false
  const managed = options.managed ?? !external
  const executable = options.executable ?? (managed ? 'whisper-server' : null)
  const startable = options.startable ?? (managed && executable !== null && options.model !== undefined)
  const command = managed && startable && executable && options.model ? {
    command: executable,
    args: ['--model', options.model, '--host', host, '--port', String(port), ...(options.args ?? [])],
    cwd: options.cwd,
    env: options.env,
  } : undefined
  const resolution = options.resolution
  return {
    id: options.id,
    name: options.name,
    type: 'transcription',
    provider: options.provider ?? 'whisper.cpp',
    host,
    port,
    model: options.model,
    capabilities: ['transcription'],
    command,
    healthCheck: { path: options.healthPath ?? '/health' },
    managed,
    external,
    connectable: options.connectable ?? false,
    startable,
    executable,
    transcriptionAdapter: options.transcriptionAdapter ?? new WhisperCppTranscriptionAdapter({ clientOptions: { host, port } }),
    whisper: {
      connectable: options.connectable ?? false,
      startable,
      managed,
      external,
      executable,
      model: options.model ?? null,
      executableSearchPaths: resolution?.executableDiscovery.searchedPaths ?? [],
      modelSearchRoots: resolution?.modelDiscovery.searchedRoots ?? [],
      warnings: resolution?.warnings ?? [],
      message: resolution?.message ?? (external ? `External Whisper service configured on ${host}:${port}.` : 'Whisper service configured.'),
    },
  }
}

export interface MusicWhisperServiceOptions extends MusicWhisperClientOptions {
  id: string
  name?: string
  host?: string
  port?: number
  external?: boolean
  connectable?: boolean
  adapter?: TranscriptionAdapter
}

export function defineMusicWhisperService(options: MusicWhisperServiceOptions): LocalAIServiceDefinition {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8091
  const baseUrl = options.baseUrl ?? `http://${host}:${port}`
  const adapter = options.adapter ?? new MusicWhisperClient({
    baseUrl,
    endpoint: options.endpoint,
    healthEndpoint: options.healthEndpoint,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  })
  return {
    id: options.id,
    name: options.name,
    type: 'transcription',
    provider: 'music-whisper',
    host,
    port,
    capabilities: ['transcription'],
    healthCheck: { path: options.healthEndpoint ?? '/health', timeoutMs: options.timeoutMs },
    managed: false,
    external: options.external ?? true,
    connectable: options.connectable ?? false,
    startable: false,
    executable: null,
    transcriptionAdapter: adapter,
  }
}

export interface DefineResolvedWhisperServiceOptions {
  id: string
  resolution: WhisperServiceResolution
  name?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export function defineResolvedWhisperService(options: DefineResolvedWhisperServiceOptions): LocalAIServiceDefinition {
  const { resolution } = options
  return defineWhisperService({
    id: options.id,
    name: options.name,
    host: resolution.host,
    port: resolution.port,
    executable: resolution.executable ?? undefined,
    model: resolution.model ?? undefined,
    managed: resolution.managed,
    external: resolution.external,
    connectable: resolution.connectable,
    startable: resolution.startable,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    resolution,
  })
}

export interface ResolveAndDefineWhisperServiceOptions extends ResolveWhisperServiceOptions {
  id: string
  name?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export async function resolveAndDefineWhisperService(options: ResolveAndDefineWhisperServiceOptions): Promise<{ resolution: WhisperServiceResolution; service: LocalAIServiceDefinition }> {
  const { id, name, args, cwd, env, ...resolveOptions } = options
  const resolution = await resolveWhisperService(resolveOptions)
  return { resolution, service: defineResolvedWhisperService({ id, name, args, cwd, env, resolution }) }
}

export interface CustomAIServiceOptions extends Omit<LocalAIServiceDefinition, 'provider' | 'type'> {
  provider?: LocalAIServiceDefinition['provider']
  type?: LocalAIServiceDefinition['type']
}

export function defineCustomAIService(options: CustomAIServiceOptions): LocalAIServiceDefinition {
  return { ...options, provider: options.provider ?? 'custom', type: options.type ?? 'custom' }
}
