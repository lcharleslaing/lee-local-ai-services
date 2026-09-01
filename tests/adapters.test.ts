import { describe, expect, it } from 'vitest'
import { defineCustomAIService, defineLlamaCppService, definePlannedLlamaCppService, defineWhisperService, type GgufModelInfo, type LocalHardwareInfo } from '../src/index.js'

describe('service adapters', () => {
  it('builds a llama.cpp command without hiding backend options in apps', () => {
    const service = defineLlamaCppService({ id: 'deep', model: '/models/qwen.gguf', port: 8080, gpuLayers: 999, contextSize: 8192 })
    expect(service.provider).toBe('llama.cpp')
    expect(service.capabilities).toContain('chat')
    expect(service.command?.args).toEqual(['/models/qwen.gguf'].flatMap((model) => ['-m', model, '--host', '127.0.0.1', '--port', '8080', '-ngl', '999', '-c', '8192']))
  })

  it('uses Lee\'s established Whisper default port', () => {
    expect(defineWhisperService({ id: 'whisper', model: '/models/medium.bin' }).port).toBe(8178)
  })

  it('keeps custom types and providers open-ended', () => {
    const service = defineCustomAIService({ id: 'music', type: 'music-generation', provider: 'ace-step', port: 9000, command: { command: 'ace-server' } })
    expect(service.type).toBe('music-generation')
    expect(service.provider).toBe('ace-step')
  })

  it('builds an async planned llama.cpp service with the selected -ngl value', async () => {
    const GIB = 1024 ** 3
    const model: GgufModelInfo = { path: '/models/qwen.gguf', sizeBytes: 17.4 * GIB, format: 'gguf', layerCount: 48, metadata: {}, warnings: [] }
    const hardware: LocalHardwareInfo = { systemRamTotalBytes: 32 * GIB, systemRamAvailableBytes: 30 * GIB, gpus: [{ index: 0, name: 'GPU', backend: 'nvidia-cuda', totalVramBytes: 12 * GIB, availableVramBytes: 11.5 * GIB }], gpuCount: 1, discoveredAt: new Date(), warnings: [] }
    const service = await definePlannedLlamaCppService({ id: 'deep', model: model.path, contextSize: 8192, gpuOffload: { mode: 'balanced' }, planning: { modelInfo: model, hardware } })
    const nglIndex = service.command?.args?.indexOf('-ngl') ?? -1
    expect(nglIndex).toBeGreaterThan(-1)
    expect(Number(service.command?.args?.[nglIndex + 1])).toBe(service.llamaCpp?.plannedGpuLayers)
    expect(service.llamaCpp?.requestedMode).toBe('balanced')
  })
})
