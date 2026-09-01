import { EventEmitter } from 'node:events'
import { createService, type ServiceManager, type ServiceState, type ServiceStatus } from '@leelaing/service-manager'
import { OpenAICompatibleClient } from './client.js'
import { copyReportToClipboard, createLocalAIReport } from './report.js'
import type { AICapability, ChatRequest, ChatResponse, ClipboardWriter, LocalAIManagerEvents, LocalAIManagerOptions, LocalAIReportOptions, LocalAIServiceDefinition, LocalAIServiceState, LocalAIServiceStatus } from './types.js'

const stateMap: Record<ServiceState, LocalAIServiceState> = { stopped: 'stopped', starting: 'starting', running: 'running', stopping: 'stopping', failed: 'error' }

export class LocalAIManager extends EventEmitter<LocalAIManagerEvents> {
  #definitions = new Map<string, LocalAIServiceDefinition>()
  #services = new Map<string, ServiceManager>()
  #fetch?: typeof globalThis.fetch

  constructor(options: LocalAIManagerOptions) {
    super()
    this.#fetch = options.fetch
    for (const definition of options.services) this.register(definition)
  }

  get definitions(): readonly LocalAIServiceDefinition[] { return [...this.#definitions.values()] }
  get ids(): readonly string[] { return [...this.#definitions.keys()] }

  register(definition: LocalAIServiceDefinition): this {
    if (this.#definitions.has(definition.id)) throw new Error(`Local AI service already registered: ${definition.id}`)
    const host = definition.host ?? '127.0.0.1'
    const health = definition.healthCheck === false ? undefined : {
      url: definition.healthCheck?.url ?? `http://${host}:${definition.port}${definition.healthCheck?.path ?? '/health'}`,
      timeoutMs: definition.healthCheck?.timeoutMs,
      acceptedStatusCodes: definition.healthCheck?.acceptedStatusCodes,
    }
    const service = createService({
      name: definition.name ?? definition.id,
      command: definition.command,
      port: { host, port: definition.port }, health,
      startupTimeoutMs: definition.startupTimeoutMs, shutdownTimeoutMs: definition.shutdownTimeoutMs,
      pollIntervalMs: definition.pollIntervalMs, logLimit: definition.logLimit,
    })
    service.on('state', (state) => this.emit('service:state', definition.id, stateMap[state]))
    service.on('stdout', (text) => this.emit('service:log', definition.id, { stream: 'stdout', text, timestamp: new Date() }))
    service.on('stderr', (text) => this.emit('service:log', definition.id, { stream: 'stderr', text, timestamp: new Date() }))
    service.on('error', (error) => this.emit('service:error', definition.id, error))
    this.#definitions.set(definition.id, definition)
    this.#services.set(definition.id, service)
    return this
  }

  unregister(id: string): boolean {
    const service = this.#services.get(id)
    if (service?.running) throw new Error(`Stop local AI service before unregistering: ${id}`)
    this.#services.delete(id)
    return this.#definitions.delete(id)
  }

  definition(id: string): LocalAIServiceDefinition { const value = this.#definitions.get(id); if (!value) throw new Error(`Unknown local AI service: ${id}`); return value }
  #service(id: string): ServiceManager { const value = this.#services.get(id); if (!value) throw new Error(`Unknown local AI service: ${id}`); return value }
  #normalize(id: string, status: ServiceStatus): LocalAIServiceStatus {
    const definition = this.definition(id)
    return { id, name: definition.name ?? id, type: definition.type, provider: definition.provider, state: stateMap[status.state], running: status.running, healthy: status.healthy, portOpen: status.portOpen, host: definition.host ?? '127.0.0.1', port: definition.port, pid: status.pid, model: definition.model, exitCode: status.exitCode, startedAt: status.startedAt, stoppedAt: status.stoppedAt }
  }

  async start(id: string): Promise<LocalAIServiceStatus> { const result = this.#normalize(id, await this.#service(id).start()); this.emit('service:start', result); if (result.healthy !== false) this.emit('service:ready', result); return result }
  async stop(id: string): Promise<LocalAIServiceStatus> { const result = this.#normalize(id, await this.#service(id).stop()); this.emit('service:stop', result); return result }
  async restart(id: string): Promise<LocalAIServiceStatus> { const result = this.#normalize(id, await this.#service(id).restart()); this.emit('service:start', result); if (result.healthy !== false) this.emit('service:ready', result); return result }
  async status(id: string): Promise<LocalAIServiceStatus> { return this.#normalize(id, await this.#service(id).status()) }
  async statusAll(): Promise<Record<string, LocalAIServiceStatus>> { const entries = await Promise.all(this.ids.map(async (id) => [id, await this.status(id)] as const)); return Object.fromEntries(entries) }
  findByCapability(capability: AICapability): LocalAIServiceDefinition[] { return this.definitions.filter((definition) => definition.capabilities?.includes(capability)) }

  setModel(id: string, model: string | undefined): void { const definition = this.definition(id); definition.model = model; this.emit('model:changed', id, model) }
  client(id: string): OpenAICompatibleClient { const definition = this.definition(id); return new OpenAICompatibleClient({ baseUrl: `http://${definition.host ?? '127.0.0.1'}:${definition.port}/v1`, fetch: this.#fetch }) }
  async chat(request: ChatRequest): Promise<ChatResponse> { const id = request.service ?? this.findByCapability('chat')[0]?.id; if (!id) throw new Error('No chat-capable local AI service is registered'); const { service: _service, ...clientRequest } = request; void _service; return this.client(id).chat({ ...clientRequest, model: request.model ?? this.definition(id).model }) }
  async rawRequest<T = unknown>(id: string, endpoint: string, init?: RequestInit): Promise<T> { return this.client(id).rawRequest<T>(endpoint, init) }

  async createReport(options: LocalAIReportOptions = {}): Promise<string> {
    const statuses = Object.values(await this.statusAll())
    const logs = options.includeLogs ? Object.fromEntries(this.ids.map((id) => [id, this.#service(id).logs])) : undefined
    return createLocalAIReport({ title: options.title, statuses, definitions: options.includeConfiguration ? [...this.definitions] : undefined, logs, logLines: options.logLines, models: options.models, installations: options.installations })
  }
  async copyReportToClipboard(options: LocalAIReportOptions = {}, writer?: ClipboardWriter): Promise<string> { const report = await this.createReport(options); return copyReportToClipboard(report, writer) }
}

export function createLocalAIManager(options: LocalAIManagerOptions): LocalAIManager { return new LocalAIManager(options) }
