import { describe, expect, it } from 'vitest'
import { defineCustomAIService, defineLlamaCppService, defineWhisperService } from '../src/index.js'

describe('service adapters', () => {
  it('builds a llama.cpp command without hiding backend options in apps', () => {
    const service = defineLlamaCppService({ id: 'deep', model: '/models/qwen.gguf', port: 8080, gpuLayers: 999, contextSize: 8192 })
    expect(service.provider).toBe('llama.cpp')
    expect(service.capabilities).toContain('chat')
    expect(service.command.args).toEqual(['/models/qwen.gguf'].flatMap((model) => ['-m', model, '--host', '127.0.0.1', '--port', '8080', '-ngl', '999', '-c', '8192']))
  })

  it('uses Lee\'s established Whisper default port', () => {
    expect(defineWhisperService({ id: 'whisper', model: '/models/medium.bin' }).port).toBe(8178)
  })

  it('keeps custom types and providers open-ended', () => {
    const service = defineCustomAIService({ id: 'music', type: 'music-generation', provider: 'ace-step', port: 9000, command: { command: 'ace-server' } })
    expect(service.type).toBe('music-generation')
    expect(service.provider).toBe('ace-step')
  })
})
