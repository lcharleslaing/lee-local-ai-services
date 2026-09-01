import { access, readFile, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, basename, join } from 'node:path'
import { expandHome } from './discovery.js'
import type { WhisperDiscoverySource, WhisperEndpointProbe, WhisperExecutableDiscovery, WhisperModelDiscovery, WhisperModelInfo, WhisperServiceResolution } from './types.js'

const MIB = 1024 ** 2
const DEFAULT_WHISPER_PORT = 8178
const DEFAULT_MINIMUM_MODEL_BYTES = 16 * MIB
const DEFAULT_WHISPER_EXECUTABLE_NAMES = ['whisper-server', 'whisper-whisper-server']
const whisperModelPattern = /^ggml-(tiny|base|small|medium|large)(?:[-.][a-z0-9_.-]+)?\.bin$/i
const ignoredNamePattern = /(?:^|[-_.])(test|tests|testing|fixture|fixtures|fake|mock)(?:[-_.]|$)/i

async function isExecutable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true } catch { return false }
}

function unique(paths: string[]): string[] { return [...new Set(paths.map(expandHome))] }

export interface DiscoverWhisperExecutableOptions {
  executableNames?: string[]
  additionalPaths?: string[]
  searchRoots?: string[]
  maxDepth?: number
  maxDirectories?: number
}

export async function discoverWhisperExecutable(options: DiscoverWhisperExecutableOptions = {}): Promise<WhisperExecutableDiscovery> {
  const names = options.executableNames ?? DEFAULT_WHISPER_EXECUTABLE_NAMES
  const pathCandidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((directory) => names.map((name) => join(directory, name)))
  const knownCandidates = unique([
    ...(options.additionalPaths ?? []),
    ...['~/.local/bin', '/usr/local/bin', '/usr/bin', '~/AI/whisper.cpp/build/bin', '~/whisper.cpp/build/bin']
      .flatMap((directory) => names.map((name) => `${directory}/${name}`)),
  ])
  const searchedPaths: string[] = []
  for (const [source, candidates] of [['path', pathCandidates], ['known-path', knownCandidates]] as const) {
    for (const candidate of candidates) {
      searchedPaths.push(candidate)
      if (await isExecutable(candidate)) return { provider: 'whisper.cpp', executable: candidate, available: true, discoverySource: source as WhisperDiscoverySource, searchedPaths, warnings: [] }
    }
  }

  const roots = unique(options.searchRoots ?? ['~/AI', '~/Programming', '~/Services', '~/.local/share', '/opt'])
  const maxDepth = options.maxDepth ?? 6
  const maxDirectories = options.maxDirectories ?? 15_000
  const warnings: string[] = []
  let visitedDirectories = 0
  let found: string | null = null
  const ignoredDirectories = new Set(['.git', 'node_modules', 'models', 'target', '__pycache__', '.cache'])

  async function walk(directory: string, depth: number): Promise<void> {
    if (found || depth > maxDepth || visitedDirectories >= maxDirectories) return
    visitedDirectories += 1
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (found) return
      const path = join(directory, entry.name)
      if (entry.isFile() && names.includes(entry.name) && await isExecutable(path)) { found = path; return }
      if (entry.isDirectory() && !entry.name.startsWith('.') && !ignoredDirectories.has(entry.name)) await walk(path, depth + 1)
    }
  }

  for (const root of roots) {
    searchedPaths.push(`${root}/**/{${names.join(',')}}`)
    await walk(root, 0)
    if (found) break
  }
  if (visitedDirectories >= maxDirectories) warnings.push(`Whisper executable filesystem search stopped at the configured ${maxDirectories}-directory safety limit.`)
  return { provider: 'whisper.cpp', executable: found, available: found !== null, discoverySource: found ? 'filesystem-search' : 'not-found', searchedPaths, warnings }
}

export function isRealWhisperModelFilename(filename: string): boolean {
  return whisperModelPattern.test(filename) && !ignoredNamePattern.test(filename)
}

export interface DiscoverWhisperModelsOptions {
  roots?: string[]
  minimumSizeBytes?: number
  maxDepth?: number
  preferredModel?: string
}

function modelPreference(model: WhisperModelInfo): number {
  const lower = model.filename.toLowerCase()
  if (/^ggml-base\.en\.bin$/.test(lower)) return 0
  if (/^ggml-base/.test(lower)) return 1
  if (/^ggml-small/.test(lower)) return 2
  if (/^ggml-medium/.test(lower)) return 3
  if (/^ggml-tiny/.test(lower)) return 4
  return 5
}

export async function discoverWhisperModels(options: DiscoverWhisperModelsOptions = {}): Promise<WhisperModelDiscovery> {
  const searchedRoots = unique(options.roots ?? ['~/AI/Models/Whisper', '~/AI/Models', '~/AI/whisper.cpp/models', '~/whisper.cpp/models'])
  const minimumSizeBytes = options.minimumSizeBytes ?? DEFAULT_MINIMUM_MODEL_BYTES
  const maxDepth = options.maxDepth ?? 5
  const byPath = new Map<string, WhisperModelInfo>()
  const warnings: string[] = []

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth || ignoredNamePattern.test(basename(directory))) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) await walk(path, depth + 1); continue }
      if (!entry.isFile() || !isRealWhisperModelFilename(entry.name) || ignoredNamePattern.test(path)) continue
      const details = await stat(path)
      if (details.size < minimumSizeBytes) continue
      const match = whisperModelPattern.exec(entry.name)
      byPath.set(path, { path, filename: entry.name, modelName: match?.[1]?.toLowerCase() ?? 'unknown', sizeBytes: details.size })
    }
  }
  for (const root of searchedRoots) await walk(root, 0)
  const models = [...byPath.values()].sort((a, b) => modelPreference(a) - modelPreference(b) || a.path.localeCompare(b.path))
  const preferred = options.preferredModel
  const selectedModel = preferred
    ? models.find((model) => model.path === expandHome(preferred) || model.filename === preferred) ?? null
    : models[0] ?? null
  if (preferred && !selectedModel) warnings.push(`Preferred Whisper model was not discovered: ${preferred}`)
  return { models, selectedModel, searchedRoots, warnings }
}

export interface ProbeWhisperServiceOptions { host?: string; port?: number; fetch?: typeof globalThis.fetch; timeoutMs?: number }

async function probeUrl(fetcher: typeof globalThis.fetch, url: string, timeoutMs: number, init: RequestInit = {}): Promise<{ status: number | null; contentType: string; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, { method: 'GET', ...init, signal: controller.signal })
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: (await response.text()).slice(0, 512) }
  } catch { return { status: null, contentType: '', body: '' } } finally { clearTimeout(timer) }
}

export async function probeWhisperService(options: ProbeWhisperServiceOptions = {}): Promise<WhisperEndpointProbe> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DEFAULT_WHISPER_PORT
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 1200
  const baseUrl = `http://${host}:${port}`
  // whisper.cpp registers /inference as POST-only. An empty multipart request
  // fails fast with a client error while still proving that the route exists.
  const emptyInferenceRequest = new FormData()
  const [health, inference] = await Promise.all([
    probeUrl(fetcher, `${baseUrl}/health`, timeoutMs),
    probeUrl(fetcher, `${baseUrl}/inference`, timeoutMs, {
      method: 'POST', body: emptyInferenceRequest, headers: { 'x-local-ai-services-probe': '1' },
    }),
  ])
  const running = health.status !== null || inference.status !== null
  const healthCompatible = health.status !== null && health.status >= 200 && health.status < 300 && /(?:"status"\s*:\s*"ok"|\bok\b)/i.test(health.body)
  const inferenceCompatible = inference.status !== null && [200, 400, 415, 422].includes(inference.status) && !inference.contentType.toLowerCase().includes('text/html')
  const compatible = running && healthCompatible && inferenceCompatible
  return {
    host, port, running, healthy: healthCompatible, compatible,
    healthEndpoint: healthCompatible ? `${baseUrl}/health` : null,
    inferenceEndpoint: inferenceCompatible ? `${baseUrl}/inference` : null,
    responseStatuses: { health: health.status, inference: inference.status },
    warning: running && !compatible ? `HTTP service on ${host}:${port} did not expose a compatible Whisper /health and /inference pair.` : undefined,
  }
}

export interface ResolveWhisperServiceOptions {
  host?: string
  preferredPort?: number
  candidatePorts?: number[]
  fetch?: typeof globalThis.fetch
  probeTimeoutMs?: number
  executable?: DiscoverWhisperExecutableOptions
  models?: DiscoverWhisperModelsOptions
}

export async function resolveWhisperService(options: ResolveWhisperServiceOptions = {}): Promise<WhisperServiceResolution> {
  const host = options.host ?? '127.0.0.1'
  const ports = [...new Set([options.preferredPort ?? DEFAULT_WHISPER_PORT, ...(options.candidatePorts ?? [])])]
  const [executableDiscovery, modelDiscovery] = await Promise.all([
    discoverWhisperExecutable(options.executable),
    discoverWhisperModels(options.models),
  ])
  const probes: WhisperEndpointProbe[] = []
  let connected: WhisperEndpointProbe | null = null
  for (const port of ports) {
    const probe = await probeWhisperService({ host, port, fetch: options.fetch, timeoutMs: options.probeTimeoutMs })
    probes.push(probe)
    if (probe.compatible) { connected = probe; break }
  }
  const warnings = [...executableDiscovery.warnings, ...modelDiscovery.warnings, ...probes.flatMap((probe) => probe.warning ? [probe.warning] : [])]
  if (connected) {
    return {
      provider: 'whisper.cpp', host, port: connected.port, running: true, healthy: connected.healthy,
      connectable: true, startable: false, managed: false, external: true,
      executable: null, model: null, executableDiscovery, modelDiscovery, probes, warnings,
      message: `Existing Whisper service discovered on ${host}:${connected.port}.`,
    }
  }
  const executable = executableDiscovery.executable
  const model = modelDiscovery.selectedModel?.path ?? null
  const startable = executable !== null && model !== null
  if (startable) {
    return {
      provider: 'whisper.cpp', host, port: ports[0] ?? DEFAULT_WHISPER_PORT, running: false, healthy: false,
      connectable: false, startable: true, managed: true, external: false,
      executable, model, executableDiscovery, modelDiscovery, probes, warnings,
      message: 'Whisper executable and model were discovered; the service can be started locally.',
    }
  }
  if (!executable) warnings.push('No Whisper server executable was discovered.')
  if (!model) warnings.push('No real whisper.cpp model was discovered.')
  return {
    provider: 'whisper.cpp', host, port: ports[0] ?? DEFAULT_WHISPER_PORT, running: false, healthy: false,
    connectable: false, startable: false, managed: false, external: false,
    executable, model, executableDiscovery, modelDiscovery, probes, warnings,
    message: 'No running Whisper service or startable whisper.cpp installation was discovered.',
  }
}

export interface WhisperClientOptions { host?: string; port?: number; baseUrl?: string; fetch?: typeof globalThis.fetch }
export interface WhisperTranscriptionRequest {
  file: string | Blob | Uint8Array | ArrayBuffer
  filename?: string
  language?: string
  translate?: boolean
  responseFormat?: string
  temperature?: number
  extraFields?: Record<string, string | number | boolean>
  signal?: AbortSignal
}

export class WhisperClient {
  readonly baseUrl: string
  #fetch: typeof globalThis.fetch
  constructor(options: WhisperClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? `http://${options.host ?? '127.0.0.1'}:${options.port ?? DEFAULT_WHISPER_PORT}`).replace(/\/$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
  }
  async transcribe(request: WhisperTranscriptionRequest): Promise<unknown> {
    let blob: Blob
    let filename = request.filename ?? 'audio.wav'
    if (typeof request.file === 'string') {
      blob = new Blob([await readFile(request.file)])
      filename = request.filename ?? basename(request.file)
    } else if (request.file instanceof Blob) blob = request.file
    else if (request.file instanceof ArrayBuffer) blob = new Blob([request.file])
    else blob = new Blob([Uint8Array.from(request.file).buffer])
    const form = new FormData()
    form.append('file', blob, filename)
    if (request.language) form.append('language', request.language)
    if (request.translate !== undefined) form.append('translate', String(request.translate))
    if (request.responseFormat) form.append('response_format', request.responseFormat)
    if (request.temperature !== undefined) form.append('temperature', String(request.temperature))
    for (const [key, value] of Object.entries(request.extraFields ?? {})) form.append(key, String(value))
    const response = await this.#fetch(`${this.baseUrl}/inference`, { method: 'POST', body: form, signal: request.signal })
    if (!response.ok) throw new Error(`Whisper transcription failed: ${response.status} ${response.statusText}`)
    const contentType = response.headers.get('content-type') ?? ''
    return contentType.includes('application/json') ? response.json() : response.text()
  }
}

export function createWhisperClient(options: WhisperClientOptions = {}): WhisperClient { return new WhisperClient(options) }
