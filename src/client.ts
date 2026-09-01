import type { ChatRequest, ChatResponse } from './types.js'

export interface OpenAICompatibleClientOptions { baseUrl: string; apiKey?: string; fetch?: typeof globalThis.fetch; headers?: Record<string, string> }

export class OpenAICompatibleClient {
  readonly baseUrl: string
  #fetch: typeof globalThis.fetch
  #headers: Record<string, string>

  constructor(options: OpenAICompatibleClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#headers = { 'content-type': 'application/json', ...options.headers }
    if (options.apiKey) this.#headers.authorization = `Bearer ${options.apiKey}`
  }

  async chat(request: Omit<ChatRequest, 'service'>): Promise<ChatResponse> {
    const response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.#headers, signal: request.signal,
      body: JSON.stringify({ messages: request.messages, model: request.model, temperature: request.temperature, max_tokens: request.maxTokens, stream: false, ...request.extra }),
    })
    if (!response.ok) throw new Error(`Local AI request failed: ${response.status} ${response.statusText}`)
    const raw = await response.json() as any
    return {
      id: raw.id, model: raw.model, raw,
      choices: (raw.choices ?? []).map((choice: any, index: number) => ({ index: choice.index ?? index, message: choice.message, finishReason: choice.finish_reason ?? null })),
      usage: raw.usage,
    }
  }

  async rawRequest<T = unknown>(endpoint: string, init?: RequestInit): Promise<T> {
    const response = await this.#fetch(`${this.baseUrl}/${endpoint.replace(/^\//, '')}`, { ...init, headers: { ...this.#headers, ...init?.headers } })
    if (!response.ok) throw new Error(`Local AI request failed: ${response.status} ${response.statusText}`)
    return response.json() as Promise<T>
  }
}

export function createOpenAICompatibleClient(options: OpenAICompatibleClientOptions): OpenAICompatibleClient { return new OpenAICompatibleClient(options) }
