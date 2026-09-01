import { EventEmitter } from 'node:events'
import { checkHttpHealth, createService, isPortOpen, type ServiceManager, type ServiceState, type ServiceStatus } from '@leelaing/service-manager'
import { OpenAICompatibleClient } from './client.js'
import { copyReportToClipboard, createLocalAIReport } from './report.js'
import { isCudaOutOfMemory, nextGpuLayersAfterCudaOom } from './llama-planner.js'
import { probeWhisperService, WhisperClient, type WhisperTranscriptionRequest } from './whisper.js'
import type { AICapability, ChatRequest, ChatResponse, ClipboardWriter, LocalAIManagerEvents, LocalAIManagerOptions, LocalAIReportOptions, LocalAIServiceDefinition, LocalAIServiceState, LocalAIServiceStatus } from './types.js'

const stateMap: Record<ServiceState, LocalAIServiceState> = { stopped: 'stopped', starting: 'starting', running: 'running', stopping: 'stopping', failed: 'error' }

export class LocalAIManager extends EventEmitter<LocalAIManagerEvents> {
  #definitions = new Map<string, LocalAIServiceDefinition>()
  #services = new Map<string, ServiceManager | null>()
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
    const service = this.#buildService(definition)
    this.#definitions.set(definition.id, definition)
    this.#services.set(definition.id, service)
    return this
  }

  #buildService(definition: LocalAIServiceDefinition): ServiceManager | null {
    if (definition.managed === false || definition.external === true || !definition.command) return null
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
    return service
  }

  unregister(id: string): boolean {
    const service = this.#services.get(id)
    if (service?.running) throw new Error(`Stop local AI service before unregistering: ${id}`)
    this.#services.delete(id)
    return this.#definitions.delete(id)
  }

  definition(id: string): LocalAIServiceDefinition { const value = this.#definitions.get(id); if (!value) throw new Error(`Unknown local AI service: ${id}`); return value }
  #service(id: string): ServiceManager | null { if (!this.#services.has(id)) throw new Error(`Unknown local AI service: ${id}`); return this.#services.get(id) ?? null }
  #managedService(id: string): ServiceManager { const value = this.#service(id); if (!value) throw new Error(`Local AI service is connection-only and cannot be lifecycle-managed: ${id}`); return value }
  #normalize(id: string, status: ServiceStatus): LocalAIServiceStatus {
    const definition = this.definition(id)
    const managed = definition.managed ?? true
    const connectable = status.running && status.portOpen !== false && status.healthy !== false
    return { id, name: definition.name ?? id, type: definition.type, provider: definition.provider, state: stateMap[status.state], running: status.running, healthy: status.healthy, portOpen: status.portOpen, host: definition.host ?? '127.0.0.1', port: definition.port, pid: status.pid, model: definition.model, exitCode: status.exitCode, startedAt: status.startedAt, stoppedAt: status.stoppedAt, llamaCpp: definition.llamaCpp, whisper: definition.whisper, connectable, startable: definition.startable ?? managed, managed, external: definition.external ?? false, executable: definition.executable ?? definition.command?.command ?? null }
  }

  async #externalStatus(id: string): Promise<LocalAIServiceStatus> {
    const definition = this.definition(id)
    const host = definition.host ?? '127.0.0.1'
    let portOpen: boolean
    let healthy: boolean
    let connectable: boolean
    if (definition.provider === 'whisper.cpp') {
      const probe = await probeWhisperService({ host, port: definition.port, fetch: this.#fetch })
      portOpen = probe.running
      healthy = probe.healthy
      connectable = probe.compatible
    } else {
      portOpen = await isPortOpen({ host, port: definition.port })
      healthy = definition.healthCheck
        ? await checkHttpHealth({ url: definition.healthCheck.url ?? `http://${host}:${definition.port}${definition.healthCheck.path ?? '/health'}`, timeoutMs: definition.healthCheck.timeoutMs, acceptedStatusCodes: definition.healthCheck.acceptedStatusCodes })
        : portOpen
      connectable = portOpen && healthy
    }
    if (definition.whisper) definition.whisper.connectable = connectable
    return {
      id, name: definition.name ?? id, type: definition.type, provider: definition.provider,
      state: connectable ? 'running' : 'stopped', running: connectable, healthy, portOpen,
      host, port: definition.port, pid: null, model: definition.model, exitCode: null,
      startedAt: null, stoppedAt: null, llamaCpp: definition.llamaCpp, whisper: definition.whisper,
      connectable, startable: definition.startable ?? false, managed: false,
      external: definition.external ?? true, executable: definition.executable ?? null,
    }
  }

  async start(id: string): Promise<LocalAIServiceStatus> {
    const definition = this.definition(id)
    if (definition.managed === false || definition.external === true || !definition.command) {
      const result = await this.#externalStatus(id)
      if (!result.connectable) throw new Error(`External local AI service is not currently connectable: ${id}`)
      this.emit('service:ready', result)
      return result
    }
    const diagnostics = definition.llamaCpp
    const fallback = diagnostics?.fallback
    let retry = 0
    while (true) {
      const service = this.#managedService(id)
      const startedAt = new Date()
      try {
        const result = this.#normalize(id, await service.start())
        diagnostics?.launchAttempts.push({ attempt: diagnostics.launchAttempts.length + 1, gpuLayers: diagnostics.actualGpuLayers, startedAt, succeeded: true, cudaOutOfMemory: false, message: retry ? `Startup succeeded after ${retry} GPU-layer fallback ${retry === 1 ? 'retry' : 'retries'}.` : 'Startup succeeded.' })
        this.emit('service:start', result)
        if (result.healthy !== false) this.emit('service:ready', result)
        return result
      } catch (error) {
        const logText = service.logs.map((entry) => entry.text).join('\n')
        const oom = isCudaOutOfMemory(logText) || isCudaOutOfMemory(error instanceof Error ? error.message : String(error))
        diagnostics?.launchAttempts.push({ attempt: diagnostics.launchAttempts.length + 1, gpuLayers: diagnostics.actualGpuLayers, startedAt, succeeded: false, cudaOutOfMemory: oom, message: oom ? `CUDA out of memory at ${diagnostics.actualGpuLayers} GPU layers.` : (error instanceof Error ? error.message : String(error)) })
        if (!diagnostics || !fallback?.enabled || !oom || retry >= fallback.maxRetries) throw error
        const nextLayers = nextGpuLayersAfterCudaOom(diagnostics.actualGpuLayers, fallback)
        if (nextLayers >= diagnostics.actualGpuLayers) throw error
        retry += 1
        diagnostics.actualGpuLayers = nextLayers
        const args = definition.command.args ?? []
        const flagIndex = args.findIndex((argument) => argument === '-ngl' || argument === '--n-gpu-layers')
        if (flagIndex >= 0) args[flagIndex + 1] = String(nextLayers)
        else args.push('-ngl', String(nextLayers))
        this.#services.set(id, this.#buildService(definition))
      }
    }
  }
  async stop(id: string): Promise<LocalAIServiceStatus> {
    const definition = this.definition(id)
    if (definition.managed === false || definition.external === true || !definition.command) return this.#externalStatus(id)
    const result = this.#normalize(id, await this.#managedService(id).stop()); this.emit('service:stop', result); return result
  }
  async restart(id: string): Promise<LocalAIServiceStatus> { const definition = this.definition(id); if (definition.managed === false || definition.external === true || !definition.command) return this.#externalStatus(id); await this.stop(id); return this.start(id) }
  async status(id: string): Promise<LocalAIServiceStatus> { const service = this.#service(id); return service ? this.#normalize(id, await service.status()) : this.#externalStatus(id) }
  async statusAll(): Promise<Record<string, LocalAIServiceStatus>> { const entries = await Promise.all(this.ids.map(async (id) => [id, await this.status(id)] as const)); return Object.fromEntries(entries) }
  findByCapability(capability: AICapability): LocalAIServiceDefinition[] { return this.definitions.filter((definition) => definition.capabilities?.includes(capability)) }

  setModel(id: string, model: string | undefined): void { const definition = this.definition(id); definition.model = model; this.emit('model:changed', id, model) }
  client(id: string): OpenAICompatibleClient { const definition = this.definition(id); return new OpenAICompatibleClient({ baseUrl: `http://${definition.host ?? '127.0.0.1'}:${definition.port}/v1`, fetch: this.#fetch }) }
  async chat(request: ChatRequest): Promise<ChatResponse> { const id = request.service ?? this.findByCapability('chat')[0]?.id; if (!id) throw new Error('No chat-capable local AI service is registered'); const { service: _service, ...clientRequest } = request; void _service; return this.client(id).chat({ ...clientRequest, model: request.model ?? this.definition(id).model }) }
  async rawRequest<T = unknown>(id: string, endpoint: string, init?: RequestInit): Promise<T> { return this.client(id).rawRequest<T>(endpoint, init) }
  whisperClient(id: string): WhisperClient { const definition = this.definition(id); if (definition.provider !== 'whisper.cpp') throw new Error(`Local AI service is not whisper.cpp: ${id}`); return new WhisperClient({ host: definition.host, port: definition.port, fetch: this.#fetch }) }
  async transcribe(request: WhisperTranscriptionRequest & { service?: string }): Promise<unknown> { const id = request.service ?? this.findByCapability('transcription')[0]?.id; if (!id) throw new Error('No transcription-capable local AI service is registered'); const { service: _service, ...clientRequest } = request; void _service; return this.whisperClient(id).transcribe(clientRequest) }

  async createReport(options: LocalAIReportOptions = {}): Promise<string> {
    const statuses = Object.values(await this.statusAll())
    const logs = options.includeLogs ? Object.fromEntries(this.ids.map((id) => [id, this.#service(id)?.logs ?? []])) : undefined
    return createLocalAIReport({ title: options.title, statuses, definitions: options.includeConfiguration ? [...this.definitions] : undefined, logs, logLines: options.logLines, models: options.models, installations: options.installations })
  }
  async copyReportToClipboard(options: LocalAIReportOptions = {}, writer?: ClipboardWriter): Promise<string> { const report = await this.createReport(options); return copyReportToClipboard(report, writer) }
}

export function createLocalAIManager(options: LocalAIManagerOptions): LocalAIManager { return new LocalAIManager(options) }
