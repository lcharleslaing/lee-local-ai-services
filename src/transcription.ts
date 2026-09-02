import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, parse } from 'node:path'
import { WhisperClient, type WhisperTranscriptionRequest } from './whisper.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_ERROR_BODY_LENGTH = 1_024
const NON_SPEECH_MARKER = /(?:\[(?:blank[_\s-]*audio|silence|music)\]|\((?:blank[_\s-]*audio|silence|music)\))/giu

export type TranscriptionProtocol = 'whisper.cpp' | 'music-whisper' | (string & {})

export interface NormalizedTranscriptionSegment {
  start?: number
  end?: number
  text: string
}

export interface NormalizedTranscriptionResult {
  text: string
  segments: NormalizedTranscriptionSegment[]
  provider: string
  protocol: TranscriptionProtocol
  raw: unknown
  outputFiles?: string[]
  warnings: string[]
}

export interface TranscriptionProbeResult {
  running: boolean
  healthy: boolean
  compatible: boolean
  status: number | null
  warning?: string
}

export type NormalizedTranscriptionRequest = WhisperTranscriptionRequest | MusicWhisperTranscriptionRequest

export interface TranscriptionAdapter {
  readonly provider: string
  readonly protocol: TranscriptionProtocol
  transcribe(request: NormalizedTranscriptionRequest): Promise<NormalizedTranscriptionResult>
  probe?(): Promise<TranscriptionProbeResult>
}

export type MusicWhisperErrorCode =
  | 'aborted'
  | 'timeout'
  | 'connection-refused'
  | 'http-error'
  | 'invalid-json'
  | 'invalid-response'
  | 'missing-output'
  | 'invalid-path'

export class MusicWhisperError extends Error {
  readonly code: MusicWhisperErrorCode
  readonly status?: number
  readonly body?: string

  constructor(message: string, code: MusicWhisperErrorCode, options: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MusicWhisperError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.body !== undefined) this.body = options.body
  }
}

export interface MusicWhisperClientOptions {
  baseUrl?: string
  endpoint?: string
  healthEndpoint?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface MusicWhisperTranscriptionRequest {
  inputPath: string
  outputDirectory: string
  endpoint?: string
  timeoutMs?: number
  signal?: AbortSignal
  extra?: Record<string, unknown>
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stripNonSpeechMarkers(value: string): string {
  return value.replace(NON_SPEECH_MARKER, ' ').replace(/\s+/gu, ' ').trim()
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function segmentValues(raw: unknown): unknown[] {
  const body = objectValue(raw)
  if (!body) return []
  if (Array.isArray(body.segments)) return body.segments
  const result = objectValue(body.result)
  if (Array.isArray(result?.segments)) return result.segments
  const transcription = objectValue(body.transcription)
  return Array.isArray(transcription?.segments) ? transcription.segments : []
}

function hasRecognizedTranscriptionShape(raw: unknown): boolean {
  const body = objectValue(raw)
  if (!body) return false
  if (['text', 'transcript', 'transcription', 'segments'].some((key) => key in body)) return true
  const result = objectValue(body.result)
  const transcription = objectValue(body.transcription)
  return Boolean(result && 'segments' in result) || Boolean(transcription && 'segments' in transcription)
}

function normalizeSegments(raw: unknown): NormalizedTranscriptionSegment[] {
  return segmentValues(raw).flatMap((value) => {
    const segment = objectValue(value)
    if (!segment) return []
    const text = stripNonSpeechMarkers(optionalText(segment.text ?? segment.transcript ?? segment.transcription))
    if (!text) return []
    const start = optionalNumber(segment.start ?? segment.start_time ?? segment.startTime)
    const end = optionalNumber(segment.end ?? segment.end_time ?? segment.endTime)
    return [{ text, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }]
  })
}

export function normalizeTranscriptionResponse(
  raw: unknown,
  options: { provider: string; protocol: TranscriptionProtocol; outputFiles?: string[]; warnings?: string[] } = {
    provider: 'unknown', protocol: 'custom',
  },
): NormalizedTranscriptionResult {
  const body = objectValue(raw)
  const segments = normalizeSegments(raw)
  const direct = optionalText(body?.text) || optionalText(body?.transcript) ||
    (typeof body?.transcription === 'string' ? optionalText(body.transcription) : '')
  const text = stripNonSpeechMarkers(direct || segments.map((segment) => segment.text).join(' '))
  return {
    text,
    segments,
    provider: options.provider,
    protocol: options.protocol,
    raw,
    ...(options.outputFiles?.length ? { outputFiles: options.outputFiles } : {}),
    warnings: [...(options.warnings ?? [])],
  }
}

function boundedBody(value: string): string {
  return value.slice(0, MAX_ERROR_BODY_LENGTH)
}

function safeExtraFields(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return {}
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(extra)) {
    if (['audio_path', 'output_dir', '__proto__', 'prototype', 'constructor'].includes(key)) continue
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value
    else if (Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) result[key] = value
  }
  return result
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) throw new MusicWhisperError(`${label} must be an absolute path.`, 'invalid-path')
}

function requestSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timeoutTriggered = false
  const timeout = setTimeout(() => { timeoutTriggered = true; controller.abort() }, timeoutMs)
  const abort = () => controller.abort()
  callerSignal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => { clearTimeout(timeout); callerSignal?.removeEventListener('abort', abort) },
  }
}

async function textOutputs(directory: string, inputPath: string): Promise<{ selected: string | null; files: string[]; warnings: string[] }> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.txt').map((entry) => join(directory, entry.name))
  const details = await Promise.all(files.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs })))
  const inputStem = parse(basename(inputPath)).name.toLowerCase()
  details.sort((a, b) => {
    const aExact = parse(basename(a.path)).name.toLowerCase() === inputStem ? 0 : 1
    const bExact = parse(basename(b.path)).name.toLowerCase() === inputStem ? 0 : 1
    return aExact - bExact || b.modified - a.modified || a.path.localeCompare(b.path)
  })
  return {
    selected: details[0]?.path ?? null,
    files: details.map((entry) => entry.path),
    warnings: details.length > 1 ? [`Multiple transcript output files were found; selected ${basename(details[0]!.path)} deterministically.`] : [],
  }
}

export class MusicWhisperClient implements TranscriptionAdapter {
  readonly provider = 'music-whisper'
  readonly protocol = 'music-whisper' as const
  readonly baseUrl: string
  readonly endpoint: string
  readonly healthEndpoint: string
  readonly timeoutMs: number
  #fetch: typeof globalThis.fetch

  constructor(options: MusicWhisperClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8091').replace(/\/$/u, '')
    this.endpoint = options.endpoint ?? '/transcribe'
    this.healthEndpoint = options.healthEndpoint ?? '/health'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async probe(): Promise<TranscriptionProbeResult> {
    const timing = requestSignal(undefined, this.timeoutMs)
    try {
      const response = await this.#fetch(`${this.baseUrl}${this.healthEndpoint}`, { method: 'GET', signal: timing.signal })
      const healthy = response.ok
      return { running: true, healthy, compatible: healthy, status: response.status, ...(!healthy ? { warning: `Music Whisper health returned HTTP ${response.status}.` } : {}) }
    } catch (error) {
      return { running: false, healthy: false, compatible: false, status: null, warning: error instanceof Error ? error.message : String(error) }
    } finally { timing.dispose() }
  }

  async transcribe(request: NormalizedTranscriptionRequest): Promise<NormalizedTranscriptionResult> {
    if (!('inputPath' in request)) throw new MusicWhisperError('Music Whisper requires inputPath and outputDirectory.', 'invalid-path')
    assertAbsolutePath(request.inputPath, 'inputPath')
    assertAbsolutePath(request.outputDirectory, 'outputDirectory')
    const timing = requestSignal(request.signal, request.timeoutMs ?? this.timeoutMs)
    let response: Response
    let bodyText: string
    try {
      response = await this.#fetch(`${this.baseUrl}${request.endpoint ?? this.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...safeExtraFields(request.extra), audio_path: request.inputPath, output_dir: request.outputDirectory }),
        signal: timing.signal,
      })
      bodyText = await response.text()
    } catch (error) {
      if (request.signal?.aborted) throw new MusicWhisperError('Music Whisper transcription was aborted.', 'aborted', { cause: error })
      if (timing.timedOut()) throw new MusicWhisperError('Music Whisper transcription timed out.', 'timeout', { cause: error })
      const message = error instanceof Error ? error.message : String(error)
      throw new MusicWhisperError(`Could not connect to Music Whisper: ${message}`, 'connection-refused', { cause: error })
    } finally { timing.dispose() }
    if (!response.ok) throw new MusicWhisperError(`Music Whisper returned HTTP ${response.status}.`, 'http-error', { status: response.status, body: boundedBody(bodyText) })
    let raw: unknown
    try { raw = bodyText ? JSON.parse(bodyText) : {} } catch (error) {
      throw new MusicWhisperError('Music Whisper returned invalid JSON.', 'invalid-json', { body: boundedBody(bodyText), cause: error })
    }
    let normalized = normalizeTranscriptionResponse(raw, { provider: this.provider, protocol: this.protocol })
    if (normalized.text) return normalized
    const outputs = await textOutputs(request.outputDirectory, request.inputPath).catch(() => ({ selected: null, files: [], warnings: [] }))
    if (!outputs.selected) {
      const recognized = hasRecognizedTranscriptionShape(raw)
      throw new MusicWhisperError(
        recognized ? 'Music Whisper returned no usable transcript or text output.' : 'Music Whisper returned an unsupported response shape.',
        recognized ? 'missing-output' : 'invalid-response',
      )
    }
    const text = stripNonSpeechMarkers(await readFile(outputs.selected, 'utf8'))
    if (!text) throw new MusicWhisperError('Music Whisper generated an empty or non-speech-only transcript.', 'missing-output')
    normalized = normalizeTranscriptionResponse({ text }, { provider: this.provider, protocol: this.protocol, outputFiles: outputs.files, warnings: outputs.warnings })
    return { ...normalized, raw }
  }
}

export interface WhisperCppAdapterOptions {
  client?: WhisperClient
  clientOptions?: ConstructorParameters<typeof WhisperClient>[0]
}

export class WhisperCppTranscriptionAdapter implements TranscriptionAdapter {
  readonly provider = 'whisper.cpp'
  readonly protocol = 'whisper.cpp' as const
  readonly client: WhisperClient
  constructor(options: WhisperCppAdapterOptions = {}) { this.client = options.client ?? new WhisperClient(options.clientOptions) }
  async transcribe(request: NormalizedTranscriptionRequest): Promise<NormalizedTranscriptionResult> {
    if (!('file' in request)) throw new Error('whisper.cpp requires a file transcription request.')
    const raw = await this.client.transcribe(request)
    return normalizeTranscriptionResponse(raw, { provider: this.provider, protocol: this.protocol })
  }
}

export function createMusicWhisperClient(options?: MusicWhisperClientOptions): MusicWhisperClient { return new MusicWhisperClient(options) }
export function createWhisperCppTranscriptionAdapter(options?: WhisperCppAdapterOptions): WhisperCppTranscriptionAdapter { return new WhisperCppTranscriptionAdapter(options) }
