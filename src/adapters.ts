import { normalizeLlamaCppFallback, planLlamaCppLaunch, type PlanLlamaCppLaunchOptions } from './llama-planner.js'
import type { GgufModelInfo, GpuOffloadOptions, LlamaCppFallbackOptions, LocalAIServiceDefinition } from './types.js'

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
  model: string
  executable?: string
  provider?: 'whisper.cpp' | 'faster-whisper' | (string & {})
  host?: string
  port?: number
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  healthPath?: string
}

export function defineWhisperService(options: WhisperServiceOptions): LocalAIServiceDefinition {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8178
  return {
    id: options.id,
    name: options.name,
    type: 'transcription',
    provider: options.provider ?? 'whisper.cpp',
    host,
    port,
    model: options.model,
    capabilities: ['transcription'],
    command: {
      command: options.executable ?? 'whisper-server',
      args: ['--model', options.model, '--host', host, '--port', String(port), ...(options.args ?? [])],
      cwd: options.cwd,
      env: options.env,
    },
    healthCheck: { path: options.healthPath ?? '/health' },
  }
}

export interface CustomAIServiceOptions extends Omit<LocalAIServiceDefinition, 'provider' | 'type'> {
  provider?: LocalAIServiceDefinition['provider']
  type?: LocalAIServiceDefinition['type']
}

export function defineCustomAIService(options: CustomAIServiceOptions): LocalAIServiceDefinition {
  return { ...options, provider: options.provider ?? 'custom', type: options.type ?? 'custom' }
}
