import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MusicWhisperClient,
  MusicWhisperError,
  createLocalAIManager,
  defineMusicWhisperService,
  normalizeTranscriptionResponse,
  type TranscriptionAdapter,
} from '../src/index.js'

const roots: string[] = []
async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'music-whisper-'))
  roots.push(root)
  const inputPath = join(root, 'song.wav')
  const outputDirectory = join(root, 'output')
  await writeFile(inputPath, 'audio')
  await mkdir(outputDirectory)
  return { inputPath, outputDirectory }
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('MusicWhisperClient', () => {
  it('sends the path JSON contract to a configurable endpoint', async () => {
    const filePaths = await paths()
    let requestUrl = ''
    let requestBody = ''
    const client = new MusicWhisperClient({
      baseUrl: 'http://127.0.0.1:8091', endpoint: '/music/transcribe',
      fetch: async (input, init) => {
        requestUrl = String(input)
        requestBody = String(init?.body)
        return new Response('{"text":"hello"}', { status: 200 })
      },
    })
    const result = await client.transcribe({ ...filePaths, extra: { language: 'en', audio_path: 'blocked' } })
    expect(requestUrl).toBe('http://127.0.0.1:8091/music/transcribe')
    expect(JSON.parse(requestBody)).toEqual({ language: 'en', audio_path: filePaths.inputPath, output_dir: filePaths.outputDirectory })
    expect(result.text).toBe('hello')
  })

  it.each(['text', 'transcript', 'transcription'])('accepts the top-level %s field', async (field) => {
    const filePaths = await paths()
    const client = new MusicWhisperClient({ fetch: async () => new Response(JSON.stringify({ [field]: 'words' })) })
    expect((await client.transcribe(filePaths)).text).toBe('words')
  })

  it('joins common segment text in order and retains normalized timing', () => {
    const result = normalizeTranscriptionResponse({ segments: [
      { start: 0, end: 1, text: 'one' }, { start_time: 1, end_time: 2, transcript: 'two' },
    ] }, { provider: 'music-whisper', protocol: 'music-whisper' })
    expect(result.text).toBe('one two')
    expect(result.segments).toEqual([{ start: 0, end: 1, text: 'one' }, { start: 1, end: 2, text: 'two' }])
  })

  it('falls back to deterministic generated text output and warns on ambiguity', async () => {
    const filePaths = await paths()
    await writeFile(join(filePaths.outputDirectory, 'other.txt'), 'other')
    await writeFile(join(filePaths.outputDirectory, 'song.txt'), '[music] actual lyrics')
    const client = new MusicWhisperClient({ fetch: async () => new Response('{"text":"[blank audio]"}') })
    const result = await client.transcribe(filePaths)
    expect(result.text).toBe('actual lyrics')
    expect(result.outputFiles).toHaveLength(2)
    expect(result.warnings[0]).toContain('selected song.txt deterministically')
  })

  it('reports bounded non-2xx response details', async () => {
    const filePaths = await paths()
    const client = new MusicWhisperClient({ fetch: async () => new Response('x'.repeat(2_000), { status: 503 }) })
    const error = await client.transcribe(filePaths).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(MusicWhisperError)
    expect(error).toMatchObject({ code: 'http-error', status: 503 })
    expect((error as MusicWhisperError).body).toHaveLength(1_024)
  })

  it('distinguishes invalid JSON, timeout, caller abort, and missing output', async () => {
    const filePaths = await paths()
    await expect(new MusicWhisperClient({ fetch: async () => new Response('not-json') }).transcribe(filePaths)).rejects.toMatchObject({ code: 'invalid-json' })
    await expect(new MusicWhisperClient({ fetch: async () => new Response('{}') }).transcribe(filePaths)).rejects.toMatchObject({ code: 'invalid-response' })
    await expect(new MusicWhisperClient({ fetch: async () => new Response('{"text":"[silence]"}') }).transcribe(filePaths)).rejects.toMatchObject({ code: 'missing-output' })
    const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    await expect(new MusicWhisperClient({ fetch: hangingFetch, timeoutMs: 5 }).transcribe(filePaths)).rejects.toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    const aborted = new MusicWhisperClient({ fetch: hangingFetch }).transcribe({ ...filePaths, signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' })
  })
})

it('uses configured custom transcription adapters and never manages external service processes', async () => {
  let transcriptions = 0
  const adapter: TranscriptionAdapter = {
    provider: 'custom-music', protocol: 'custom',
    probe: async () => ({ running: true, healthy: true, compatible: true, status: 200 }),
    transcribe: async () => { transcriptions += 1; return { text: 'custom', segments: [], provider: 'custom-music', protocol: 'custom', raw: {}, warnings: [] } },
  }
  const service = defineMusicWhisperService({ id: 'music', adapter })
  const manager = createLocalAIManager({ services: [service] })
  expect(await manager.status('music')).toMatchObject({ external: true, managed: false, connectable: true })
  expect(await manager.transcribe({ service: 'music', inputPath: '/audio.wav', outputDirectory: '/output' })).toMatchObject({ text: 'custom' })
  await manager.stop('music')
  await manager.restart('music')
  expect(transcriptions).toBe(1)
})
