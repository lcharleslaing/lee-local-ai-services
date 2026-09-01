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

function yesNo(value: boolean | null): string { return value === null ? 'unknown' : value ? 'yes' : 'no' }
function safeEnvironment(env?: NodeJS.ProcessEnv): string[] { return Object.keys(env ?? {}).sort() }

export function createLocalAIReport(input: CreateLocalAIReportInput): string {
  const lines = [
    (input.title ?? 'LOCAL AI SERVICES REPORT').toUpperCase(),
    '='.repeat((input.title ?? 'LOCAL AI SERVICES REPORT').length),
    `Generated: ${ (input.generatedAt ?? new Date()).toISOString() }`,
    `Services:  ${input.statuses.length}`,
  ]
  for (const status of input.statuses) {
    lines.push('', `[${status.id}] ${status.name}`, `Provider:  ${status.provider}`, `Type:      ${status.type}`, `State:     ${status.state}`, `Running:   ${yesNo(status.running)}`, `Healthy:   ${yesNo(status.healthy)}`, `Port open: ${yesNo(status.portOpen)}`, `Address:   http://${status.host}:${status.port}`, `PID:       ${status.pid ?? 'none'}`, `Model:     ${status.model ?? 'none'}`)
    const definition = input.definitions?.find((item) => item.id === status.id)
    if (definition) {
      lines.push(`Command:   ${definition.command.command} ${(definition.command.args ?? []).join(' ')}`.trimEnd())
      const environmentKeys = safeEnvironment(definition.command.env)
      if (environmentKeys.length) lines.push(`Env keys:  ${environmentKeys.join(', ')} (values hidden)`)
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
