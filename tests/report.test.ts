import { describe, expect, it, vi } from 'vitest'
import { copyReportToClipboard, createLocalAIReport, planLlamaCppLaunch, type GgufModelInfo, type LocalAIServiceStatus } from '../src/index.js'

const status: LocalAIServiceStatus = {
  id: 'deep', name: 'Deep LLM', type: 'llm', provider: 'llama.cpp', state: 'running', running: true,
  healthy: true, portOpen: true, host: '127.0.0.1', port: 8080, pid: 123, model: '/models/qwen.gguf',
  exitCode: null, startedAt: new Date('2026-09-01T12:00:00Z'), stoppedAt: null,
}

describe('reports', () => {
  it('creates a plain-text report suitable for pasting into another app', () => {
    const report = createLocalAIReport({ generatedAt: new Date('2026-09-01T13:00:00Z'), statuses: [status], definitions: [{ id: 'deep', type: 'llm', provider: 'llama.cpp', port: 8080, model: '/models/qwen.gguf', command: { command: 'llama-server', args: ['-m', '/models/qwen.gguf'], env: { API_SECRET: 'never-copy-this' } } }] })
    expect(report).toContain('LOCAL AI SERVICES REPORT')
    expect(report).toContain('[deep] Deep LLM')
    expect(report).toContain('Command:   llama-server -m /models/qwen.gguf')
    expect(report).toContain('API_SECRET (values hidden)')
    expect(report).not.toContain('never-copy-this')
  })

  it('writes and returns the exact report through an injected clipboard', async () => {
    const writeText = vi.fn(async () => undefined)
    await expect(copyReportToClipboard('report text', { writeText })).resolves.toBe('report text')
    expect(writeText).toHaveBeenCalledWith('report text')
  })

  it('includes live-memory planning assumptions and launch attempts', async () => {
    const GIB = 1024 ** 3
    const model: GgufModelInfo = { path: '/models/qwen.gguf', sizeBytes: 17.4 * GIB, format: 'gguf', architecture: 'qwen3moe', layerCount: 48, metadata: {}, warnings: [] }
    const plan = await planLlamaCppLaunch({
      model,
      hardware: { systemRamTotalBytes: 32 * GIB, systemRamAvailableBytes: 29 * GIB, gpus: [{ index: 0, name: 'RTX Test', backend: 'nvidia-cuda', totalVramBytes: 12 * GIB, availableVramBytes: 11 * GIB }], gpuCount: 1, discoveredAt: new Date(), warnings: [] },
      gpuOffload: { mode: 'balanced' },
    })
    const report = createLocalAIReport({ statuses: [{ ...status, llamaCpp: { requestedMode: 'balanced', plannedGpuLayers: plan.recommendedGpuLayers, actualGpuLayers: plan.recommendedGpuLayers, launchPlan: plan, launchAttempts: [{ attempt: 1, gpuLayers: plan.recommendedGpuLayers, startedAt: new Date(), succeeded: true, cudaOutOfMemory: false, message: 'Startup succeeded.' }] } }] })
    expect(report).toContain('GPU VRAM available: 11.00 GiB')
    expect(report).toContain('System RAM available: 29.00 GiB')
    expect(report).toContain('Weight estimate:')
    expect(report).toContain('Attempt 1:')
  })
})
