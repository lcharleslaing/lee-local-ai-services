import { describe, expect, it, vi } from 'vitest'
import { createOpenAICompatibleClient } from '../src/index.js'

describe('OpenAI-compatible client', () => {
  it('normalizes chat completions', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'one', model: 'local', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }] }), { status: 200 }))
    const client = createOpenAICompatibleClient({ baseUrl: 'http://127.0.0.1:8080/v1/', fetch: fetch as typeof globalThis.fetch })
    const result = await client.chat({ messages: [{ role: 'user', content: 'Hi' }], model: 'local' })
    expect(result.choices[0]?.message.content).toBe('Hello')
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/chat/completions', expect.objectContaining({ method: 'POST' }))
  })

  it('reports backend HTTP errors', async () => {
    const client = createOpenAICompatibleClient({ baseUrl: 'http://localhost:8080/v1', fetch: (async () => new Response('', { status: 500, statusText: 'Broken' })) as typeof globalThis.fetch })
    await expect(client.chat({ messages: [] })).rejects.toThrow('500 Broken')
  })
})
