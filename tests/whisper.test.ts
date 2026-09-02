import { chmod, mkdtemp, truncate, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLocalAIManager,
  createWhisperClient,
  defineResolvedWhisperService,
  discoverWhisperModels,
  probeWhisperService,
  resolveWhisperService,
} from '../src/index.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0 }
}

async function emptyDiscoveryOptions() {
  const root = await mkdtemp(join(tmpdir(), 'whisper-empty-'))
  return {
    executable: { executableNames: ['definitely-not-whisper-server'], additionalPaths: [], searchRoots: [] },
    models: { roots: [root], minimumSizeBytes: 1024 },
  }
}

async function sparseFile(path: string, size: number): Promise<void> { await writeFile(path, ''); await truncate(path, size) }

describe('Whisper discovery and resolution', () => {
  it('uses a running compatible Whisper service without an executable', async () => {
    const { port } = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/health') { response.end('{"status":"ok"}'); return }
      if (request.url === '/inference' && request.method === 'POST') { response.statusCode = 400; response.end('{"error":"no file"}'); return }
      response.statusCode = 404; response.end('{}')
    })
    const discovery = await emptyDiscoveryOptions()
    const resolved = await resolveWhisperService({ preferredPort: port, probeTimeoutMs: 100, ...discovery })
    expect(resolved).toMatchObject({ connectable: true, running: true, external: true, managed: false, startable: false, executable: null, port })
    expect(resolved.message).toContain('Existing Whisper service discovered')
  })

  it('finds an executable and real model when the service is stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-install-'))
    const executable = join(root, 'whisper-server')
    const model = join(root, 'ggml-base.en.bin')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)
    await sparseFile(model, 20 * 1024 ** 2)
    const resolved = await resolveWhisperService({
      preferredPort: 64991, probeTimeoutMs: 50,
      executable: { executableNames: ['missing-name'], additionalPaths: [executable], searchRoots: [] },
      models: { roots: [root] },
    })
    expect(resolved).toMatchObject({ connectable: false, running: false, startable: true, managed: true, external: false, executable, model })
  })

  it('reports unavailable when neither endpoint nor executable exists', async () => {
    const discovery = await emptyDiscoveryOptions()
    const resolved = await resolveWhisperService({ preferredPort: 64992, probeTimeoutMs: 50, ...discovery })
    expect(resolved).toMatchObject({ connectable: false, startable: false, running: false })
    expect(resolved.message).toContain('No running Whisper service')
  })

  it('ignores test fixtures and absurdly small fake models but recognizes ggml-base.en.bin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-models-'))
    await sparseFile(join(root, 'ggml-base.en-for-tests.bin'), 20 * 1024 ** 2)
    await sparseFile(join(root, 'ggml-small.bin'), 1024)
    await sparseFile(join(root, 'ggml-base.en.bin'), 20 * 1024 ** 2)
    const result = await discoverWhisperModels({ roots: [root] })
    expect(result.models.map((model) => model.filename)).toEqual(['ggml-base.en.bin'])
    expect(result.selectedModel?.modelName).toBe('base')
  })

  it('rejects an unrelated HTTP service on a candidate port', async () => {
    const { port } = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/health') { response.end('{"status":"ok"}'); return }
      response.statusCode = 404; response.end('{}')
    })
    await expect(probeWhisperService({ port })).resolves.toMatchObject({ running: true, healthy: true, compatible: false })
  })

  it('never stops or kills an external service and can transcribe through it', async () => {
    let inferencePosts = 0
    const { server, port } = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/health') { response.end('{"status":"ok"}'); return }
      if (request.url === '/inference' && request.method === 'POST') {
        if (request.headers['x-local-ai-services-probe'] === '1') { response.statusCode = 400; response.end('{"error":"no file"}'); return }
        inferencePosts += 1; response.end('{"text":"spoken words"}'); return
      }
      response.statusCode = 404; response.end('{}')
    })
    const discovery = await emptyDiscoveryOptions()
    const resolution = await resolveWhisperService({ preferredPort: port, probeTimeoutMs: 100, ...discovery })
    const service = defineResolvedWhisperService({ id: 'external-whisper', resolution })
    expect(service.command).toBeUndefined()
    const manager = createLocalAIManager({ services: [service] })
    expect((await manager.status('external-whisper')).connectable).toBe(true)
    const report = await manager.createReport()
    expect(report).toContain('Connectable: yes')
    expect(report).toContain('External:    yes')
    expect(report).toContain('Existing Whisper service discovered')
    await manager.stop('external-whisper')
    expect(server.listening).toBe(true)
    await expect(manager.transcribe({ service: 'external-whisper', file: new Uint8Array([1, 2, 3]), filename: 'voice.wav' })).resolves.toMatchObject({
      text: 'spoken words', provider: 'whisper.cpp', protocol: 'whisper.cpp', warnings: [],
    })
    expect(inferencePosts).toBe(1)
  })

  it('exposes a standalone Whisper client for unmanaged endpoints', async () => {
    const { port } = await listen((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(request.url === '/inference' ? '{"text":"hello"}' : '{}')
    })
    const client = createWhisperClient({ port })
    await expect(client.transcribe({ file: new Uint8Array([1]), filename: 'one.wav' })).resolves.toEqual({ text: 'hello' })
  })
})
