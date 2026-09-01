import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { freemem, totalmem } from 'node:os'
import { readFile } from 'node:fs/promises'
import type { GpuHardwareInfo, LocalHardwareInfo } from './types.js'

const execFileAsync = promisify(execFile)
const MIB = 1024 ** 2

export interface HardwareCommandResult { stdout: string; stderr?: string }
export type HardwareCommandRunner = (command: string, args: string[]) => Promise<HardwareCommandResult>
export interface DiscoverHardwareOptions {
  nvidiaSmiPath?: string
  commandRunner?: HardwareCommandRunner
  systemRamTotalBytes?: number | null
  systemRamAvailableBytes?: number | null
  procMeminfoPath?: string
}

const defaultRunner: HardwareCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { encoding: 'utf8', timeout: 5000 })
  return { stdout: result.stdout, stderr: result.stderr }
}

export function parseNvidiaSmiCsv(output: string): GpuHardwareInfo[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const [indexText, name, totalText, freeText, driverVersion] = line.split(',').map((value) => value.trim())
    const index = Number(indexText)
    const totalMib = Number(totalText)
    const freeMib = Number(freeText)
    if (!Number.isFinite(index) || !name || !Number.isFinite(totalMib)) return []
    return [{
      index,
      name,
      backend: 'nvidia-cuda' as const,
      totalVramBytes: Math.round(totalMib * MIB),
      availableVramBytes: Number.isFinite(freeMib) ? Math.round(freeMib * MIB) : null,
      driverVersion: driverVersion || undefined,
    }]
  })
}

export function parseProcMeminfo(output: string): { totalBytes: number | null; availableBytes: number | null } {
  const values = new Map<string, number>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/i.exec(line.trim())
    if (match?.[1] && match[2]) values.set(match[1].toLowerCase(), Number(match[2]) * 1024)
  }
  return { totalBytes: values.get('memtotal') ?? null, availableBytes: values.get('memavailable') ?? null }
}

export async function discoverLocalHardware(options: DiscoverHardwareOptions = {}): Promise<LocalHardwareInfo> {
  const warnings: string[] = []
  let gpus: GpuHardwareInfo[] = []
  try {
    const result = await (options.commandRunner ?? defaultRunner)(options.nvidiaSmiPath ?? 'nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.free,driver_version',
      '--format=csv,noheader,nounits',
    ])
    gpus = parseNvidiaSmiCsv(result.stdout)
    if (!gpus.length) warnings.push('nvidia-smi returned no usable NVIDIA GPU metrics.')
  } catch {
    warnings.push('NVIDIA GPU metrics unavailable; nvidia-smi was not found or could not be queried.')
  }
  let linuxMemory: { totalBytes: number | null; availableBytes: number | null } = { totalBytes: null, availableBytes: null }
  if (options.systemRamTotalBytes === undefined || options.systemRamAvailableBytes === undefined) {
    try { linuxMemory = parseProcMeminfo(await readFile(options.procMeminfoPath ?? '/proc/meminfo', 'utf8')) } catch { warnings.push('Linux MemAvailable metrics unavailable; using operating-system memory fallbacks.') }
  }
  return {
    systemRamTotalBytes: options.systemRamTotalBytes === undefined ? (linuxMemory.totalBytes ?? totalmem()) : options.systemRamTotalBytes,
    systemRamAvailableBytes: options.systemRamAvailableBytes === undefined ? (linuxMemory.availableBytes ?? freemem()) : options.systemRamAvailableBytes,
    gpus,
    gpuCount: gpus.length,
    discoveredAt: new Date(),
    warnings,
  }
}
