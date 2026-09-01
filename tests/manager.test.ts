import { describe, expect, it } from 'vitest'
import { createLocalAIManager, defineCustomAIService } from '../src/index.js'

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
})
