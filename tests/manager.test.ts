import { createServer } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createLocalAIManager, defineCustomAIService, normalizeLlamaCppFallback } from '../src/index.js'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

describe('LocalAIManager', () => {
  it('supports multiple registered services and capability lookup', () => {
    const manager = createLocalAIManager({ services: [
      defineCustomAIService({ id: 'deep', type: 'llm', provider: 'test', port: 65001, capabilities: ['chat'], healthCheck: false, command: { command: process.execPath, args: ['--version'] } }),
      defineCustomAIService({ id: 'fast', type: 'llm', provider: 'test', port: 65002, capabilities: ['chat'], healthCheck: false, command: { command: process.execPath, args: ['--version'] } }),
    ] })
    expect(manager.ids).toEqual(['deep', 'fast'])
    expect(manager.findByCapability('chat').map((item) => item.id)).toEqual(['deep', 'fast'])
  })

  it('rejects duplicate IDs and unknown services clearly', async () => {
    const definition = defineCustomAIService({ id: 'one', port: 65003, healthCheck: false, command: { command: process.execPath, args: ['--version'] } })
    const manager = createLocalAIManager({ services: [definition] })
    expect(() => manager.register(definition)).toThrow('already registered')
    await expect(manager.status('missing')).rejects.toThrow('Unknown local AI service')
  })

  it('retries a detected CUDA OOM with fewer GPU layers and records both attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-ai-oom-'))
    const script = join(root, 'mock-llama.mjs')
    const port = await freePort()
    await writeFile(script, `
      import http from 'node:http'
      const index = process.argv.indexOf('-ngl')
      const layers = Number(process.argv[index + 1])
      if (layers > 5) {
        console.error('ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory')
        process.exit(1)
      }
      const server = http.createServer((_request, response) => { response.statusCode = 200; response.end('ok') })
      server.listen(${port}, '127.0.0.1')
      process.on('SIGTERM', () => server.close(() => process.exit(0)))
    `)
    const manager = createLocalAIManager({ services: [{
      id: 'retry-llm', type: 'llm', provider: 'llama.cpp', host: '127.0.0.1', port,
      command: { command: process.execPath, args: [script, '-ngl', '10'] },
      healthCheck: { path: '/health' }, startupTimeoutMs: 3000, pollIntervalMs: 20,
      llamaCpp: {
        requestedMode: 'balanced', plannedGpuLayers: 10, actualGpuLayers: 10,
        fallback: normalizeLlamaCppFallback({ enabled: true, maxRetries: 1, reductionFactor: 0.5 }),
        launchAttempts: [],
      },
    }] })
    const status = await manager.start('retry-llm')
    expect(status.running).toBe(true)
    expect(status.llamaCpp?.actualGpuLayers).toBe(5)
    expect(status.llamaCpp?.launchAttempts).toMatchObject([
      { gpuLayers: 10, succeeded: false, cudaOutOfMemory: true },
      { gpuLayers: 5, succeeded: true, cudaOutOfMemory: false },
    ])
    await manager.stop('retry-llm')
  })
})
