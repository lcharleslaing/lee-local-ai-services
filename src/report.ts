import type { ClipboardWriter, DiscoveredModel, ExecutableInstallation, LocalAIServiceDefinition, LocalAIServiceStatus } from './types.js'

export interface CreateLocalAIReportInput {
  title?: string
  generatedAt?: Date
  statuses: LocalAIServiceStatus[]
  definitions?: LocalAIServiceDefinition[]
  logs?: Record<string, readonly { stream: string; text: string; timestamp: Date }[]>
  logLines?: number
  models?: DiscoveredModel[]
  installations?: ExecutableInstallation[]
}

function yesNo(value: boolean | null | undefined): string { return value === null || value === undefined ? 'unknown' : value ? 'yes' : 'no' }
function safeEnvironment(env?: NodeJS.ProcessEnv): string[] { return Object.keys(env ?? {}).sort() }
function formatBytes(value: number | null): string { return value === null ? 'unknown' : `${(value / 1024 ** 3).toFixed(2)} GiB (${value} bytes)` }

export function createLocalAIReport(input: CreateLocalAIReportInput): string {
  const lines = [
    (input.title ?? 'LOCAL AI SERVICES REPORT').toUpperCase(),
    '='.repeat((input.title ?? 'LOCAL AI SERVICES REPORT').length),
    `Generated: ${ (input.generatedAt ?? new Date()).toISOString() }`,
    `Services:  ${input.statuses.length}`,
  ]
  for (const status of input.statuses) {
    lines.push('', `[${status.id}] ${status.name}`, `Provider:    ${status.provider}`, `Type:        ${status.type}`, `State:       ${status.state}`, `Running:     ${yesNo(status.running)}`, `Healthy:     ${yesNo(status.healthy)}`, `Connectable: ${yesNo(status.connectable)}`, `Startable:   ${yesNo(status.startable)}`, `Managed:     ${yesNo(status.managed)}`, `External:    ${yesNo(status.external)}`, `Port open:   ${yesNo(status.portOpen)}`, `Address:     http://${status.host}:${status.port}`, `PID:         ${status.pid ?? 'none'}`, `Executable:  ${status.executable ?? 'none'}`, `Model:       ${status.model ?? 'none'}`)
    const definition = input.definitions?.find((item) => item.id === status.id)
    if (definition?.command) {
      lines.push(`Command:   ${definition.command.command} ${(definition.command.args ?? []).join(' ')}`.trimEnd())
      const environmentKeys = safeEnvironment(definition.command.env)
      if (environmentKeys.length) lines.push(`Env keys:  ${environmentKeys.join(', ')} (values hidden)`)
    }
    if (status.whisper) {
      lines.push('Whisper discovery:', `  ${status.whisper.message}`, `  Executable search paths: ${status.whisper.executableSearchPaths.length ? status.whisper.executableSearchPaths.join(', ') : 'none recorded'}`, `  Model search roots: ${status.whisper.modelSearchRoots.length ? status.whisper.modelSearchRoots.join(', ') : 'none recorded'}`)
      for (const warning of status.whisper.warnings) lines.push(`  Warning: ${warning}`)
    }
    if (status.llamaCpp) {
      const diagnostics = status.llamaCpp
      lines.push('Llama.cpp launch planning:', `  Requested mode:     ${diagnostics.requestedMode}`, `  Planned GPU layers: ${diagnostics.plannedGpuLayers}`, `  Actual GPU layers:  ${diagnostics.actualGpuLayers}`)
      const plan = diagnostics.launchPlan
      if (plan) {
        lines.push(
          `  Likely runnable:     ${plan.runnable ? 'yes' : 'no'}`,
          `  Model size:         ${formatBytes(plan.model.sizeBytes)}`,
          `  Model architecture: ${plan.model.architecture ?? 'unknown'}`,
          `  Model layers:       ${plan.totalLayers ?? 'unknown'}`,
          `  Context size:       ${plan.contextSize}`,
          `  Selected GPU:       ${plan.gpu ? `${plan.gpu.index}: ${plan.gpu.name}` : 'none'}`,
          `  GPU VRAM total:     ${formatBytes(plan.gpu?.totalVramBytes ?? null)}`,
          `  GPU VRAM available: ${formatBytes(plan.gpu?.availableVramBytes ?? null)}`,
          `  System RAM total:   ${formatBytes(plan.hardware.systemRamTotalBytes)}`,
          `  System RAM available: ${formatBytes(plan.hardware.systemRamAvailableBytes)}`,
          `  Estimated GPU use:  ${formatBytes(plan.estimatedGpuUseBytes)}`,
          `  Estimated RAM use:  ${formatBytes(plan.estimatedSystemRamUseBytes)}`,
          `  Weight estimate:     ${formatBytes(plan.estimatedWeightBytes)} (${plan.weightSafetyMargin.toFixed(2)}x GGUF size)`,
          `  Estimated KV cache:  ${formatBytes(plan.estimatedKvCacheBytes)}`,
          `  Runtime overhead:    ${formatBytes(plan.runtimeOverheadBytes)}`,
          `  Minimum headroom:    ${formatBytes(plan.minimumVramHeadroomBytes)}`,
          `  Reserved headroom:  ${formatBytes(plan.reservedHeadroomBytes)}`,
          `  Reason: ${plan.reason}`,
        )
        for (const warning of plan.warnings) lines.push(`  Warning: ${warning}`)
      }
      for (const attempt of diagnostics.launchAttempts) lines.push(`  Attempt ${attempt.attempt}: ${attempt.gpuLayers} GPU layers — ${attempt.message}`)
    }
    const logs = input.logs?.[status.id]
    if (logs?.length) {
      lines.push('Recent logs:')
      for (const entry of logs.slice(-(input.logLines ?? 20))) lines.push(`  ${entry.timestamp.toISOString()} ${entry.stream}: ${entry.text.trimEnd()}`)
    }
  }
  if (input.installations) {
    lines.push('', 'DISCOVERED EXECUTABLES', '----------------------')
    for (const item of input.installations) lines.push(`${item.provider}: ${item.available ? item.executable : 'not found'}`)
  }
  if (input.models) {
    lines.push('', 'DISCOVERED MODELS', '-----------------')
    if (!input.models.length) lines.push('none')
    for (const model of input.models) lines.push(`${model.type} | ${model.format} | ${model.sizeBytes} bytes | ${model.path}`)
  }
  return `${lines.join('\n')}\n`
}

export async function copyReportToClipboard(report: string, writer?: ClipboardWriter): Promise<string> {
  const clipboard = writer ?? globalThis.navigator?.clipboard
  if (!clipboard?.writeText) throw new Error('Clipboard access is unavailable. Pass a ClipboardWriter from the consuming app.')
  await clipboard.writeText(report)
  return report
}
