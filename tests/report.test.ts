import { describe, expect, it, vi } from 'vitest'
import { copyReportToClipboard, createLocalAIReport, type LocalAIServiceStatus } from '../src/index.js'

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
})
