import { discoverLocalHardware, type DiscoverHardwareOptions } from './hardware.js'
import { inspectGgufModel } from './gguf.js'
import type { GgufModelInfo, GpuHardwareInfo, GpuOffloadMode, GpuOffloadOptions, LlamaCppFallbackOptions, LlamaCppLaunchPlan, LocalHardwareInfo } from './types.js'

const GIB = 1024 ** 3
const DEFAULT_CONTEXT_SIZE = 8192

export interface PlanLlamaCppLaunchOptions {
  model: string | GgufModelInfo
  hardware?: LocalHardwareInfo
  hardwareDiscovery?: DiscoverHardwareOptions
  contextSize?: number
  gpuOffload?: GpuOffloadOptions
}

function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)) }
function gib(value: number): string { return `${(value / GIB).toFixed(2)} GiB` }

function modeMinimumHeadroom(mode: GpuOffloadMode): number {
  if (mode === 'max-gpu') return 1 * GIB
  if (mode === 'cpu-heavy') return 3 * GIB
  return 2 * GIB
}

export function estimateLlamaCppKvCacheBytes(contextSize: number): number {
  return Math.max(512 * 1024 ** 2, Math.ceil((contextSize / 8192) * 1.25 * GIB))
}

function selectGpu(hardware: LocalHardwareInfo, requestedIndex?: number): GpuHardwareInfo | null {
  if (requestedIndex !== undefined) return hardware.gpus.find((gpu) => gpu.index === requestedIndex) ?? null
  return [...hardware.gpus].sort((a, b) => (b.availableVramBytes ?? b.totalVramBytes) - (a.availableVramBytes ?? a.totalVramBytes))[0] ?? null
}

export async function planLlamaCppLaunch(options: PlanLlamaCppLaunchOptions): Promise<LlamaCppLaunchPlan> {
  const hardware = options.hardware ?? await discoverLocalHardware(options.hardwareDiscovery)
  const model = typeof options.model === 'string' ? await inspectGgufModel(options.model) : options.model
  const offload = options.gpuOffload ?? {}
  const mode = offload.mode ?? (offload.gpuLayers !== undefined ? 'manual' : 'auto')
  const contextSize = Math.max(512, Math.floor(options.contextSize ?? DEFAULT_CONTEXT_SIZE))
  const gpu = selectGpu(hardware, offload.gpuIndex)
  const warnings = [...hardware.warnings, ...model.warnings]
  const totalLayers = model.layerCount ?? null
  const safetyMargin = clamp(offload.safetyMargin ?? 1.08, 1, 2)
  const estimatedWeightBytes = Math.ceil(model.sizeBytes * safetyMargin)
  const estimatedKvCacheBytes = offload.kvCacheBytes ?? estimateLlamaCppKvCacheBytes(contextSize)
  const runtimeOverheadBytes = offload.runtimeOverheadBytes ?? 768 * 1024 ** 2
  const minimumHeadroomBytes = offload.minimumVramHeadroomBytes ?? modeMinimumHeadroom(mode)
  const reservedHeadroomBytes = estimatedKvCacheBytes + runtimeOverheadBytes + minimumHeadroomBytes
  const gpuAvailable = gpu ? Math.min(gpu.availableVramBytes ?? gpu.totalVramBytes, gpu.totalVramBytes) : 0
  const availableGpuBudgetBytes = Math.max(0, gpuAvailable - reservedHeadroomBytes)
  const offloadableWeightBytes = Math.ceil(estimatedWeightBytes * 0.95)
  const fixedSystemWeightBytes = estimatedWeightBytes - offloadableWeightBytes
  let recommendedGpuLayers = 0

  if (mode === 'manual') {
    recommendedGpuLayers = Math.max(0, Math.floor(offload.gpuLayers ?? 0))
    if (offload.gpuLayers === undefined) warnings.push('Manual GPU offload mode was selected without an explicit gpuLayers value; using CPU-only mode.')
  } else if (!gpu) {
    warnings.push('No supported GPU metrics were discovered; using CPU-only offload to avoid an unsafe VRAM assumption.')
  } else if (!totalLayers) {
    if (offloadableWeightBytes <= availableGpuBudgetBytes) recommendedGpuLayers = 999
    else warnings.push('Partial GPU offload could not be calculated because the GGUF layer count is unavailable; using CPU-only mode.')
  } else {
    const bytesPerLayer = offloadableWeightBytes / totalLayers
    recommendedGpuLayers = clamp(Math.floor(availableGpuBudgetBytes / bytesPerLayer), 0, totalLayers)
    if (mode === 'cpu-heavy') recommendedGpuLayers = Math.min(recommendedGpuLayers, Math.max(1, Math.floor(totalLayers * 0.35)))
  }

  const effectiveLayerFraction = totalLayers
    ? clamp(recommendedGpuLayers / totalLayers, 0, 1)
    : recommendedGpuLayers >= 999 ? 1 : 0
  const gpuWeightBytes = Math.ceil(offloadableWeightBytes * effectiveLayerFraction)
  const estimatedGpuUseBytes = gpuWeightBytes + estimatedKvCacheBytes + runtimeOverheadBytes
  const cpuRuntimeOverheadBytes = 1 * GIB
  const estimatedSystemRamUseBytes = fixedSystemWeightBytes + (offloadableWeightBytes - gpuWeightBytes) + cpuRuntimeOverheadBytes
  const estimatedCombinedUseBytes = estimatedGpuUseBytes + estimatedSystemRamUseBytes
  const fullGpuOffload = effectiveLayerFraction >= 1
  const usesSystemRam = !fullGpuOffload || fixedSystemWeightBytes > 0
  const systemAvailable = hardware.systemRamAvailableBytes
  const systemBudget = systemAvailable ?? hardware.systemRamTotalBytes

  if (gpu && model.sizeBytes > gpu.totalVramBytes) warnings.push(`Model file (${gib(model.sizeBytes)}) is larger than GPU VRAM (${gib(gpu.totalVramBytes)}); partial GPU offload is recommended.`)
  if (contextSize >= 32768) warnings.push(`Large context size (${contextSize}) materially increases the reserved KV-cache memory.`)
  if (systemBudget !== null && estimatedSystemRamUseBytes > systemBudget) warnings.push(`Estimated system RAM use (${gib(estimatedSystemRamUseBytes)}) exceeds ${systemAvailable !== null ? 'currently available' : 'total detected'} system RAM (${gib(systemBudget)}).`)
  const manualGpuUnsafe = mode === 'manual' && gpu !== null && estimatedGpuUseBytes > gpuAvailable
  if (manualGpuUnsafe) warnings.push(`Manual gpuLayers=${recommendedGpuLayers} appears unsafe: estimated GPU use (${gib(estimatedGpuUseBytes)}) exceeds currently available VRAM (${gib(gpuAvailable)}).`)
  if (offload.gpuIndex !== undefined && !gpu) warnings.push(`Requested GPU index ${offload.gpuIndex} was not discovered.`)

  const runnable = (systemBudget === null || estimatedSystemRamUseBytes <= systemBudget) && !manualGpuUnsafe
  const reason = !gpu
    ? 'No supported GPU was safely measurable, so CPU-only execution was selected.'
    : mode === 'manual'
      ? `Manual mode preserves the requested ${recommendedGpuLayers} GPU layers.`
      : fullGpuOffload
        ? `The complete model is estimated to fit while preserving ${gib(reservedHeadroomBytes)} of VRAM reserves.`
        : `Selected ${recommendedGpuLayers}${totalLayers ? ` of ${totalLayers}` : ''} GPU layers from a ${gib(availableGpuBudgetBytes)} model-weight budget while reserving ${gib(reservedHeadroomBytes)} for context, CUDA/runtime buffers, and headroom.`

  return {
    mode, runnable, model, hardware, gpu, contextSize, totalLayers, recommendedGpuLayers,
    fullGpuOffload, usesSystemRam, estimatedGpuUseBytes, estimatedSystemRamUseBytes,
    estimatedKvCacheBytes, estimatedWeightBytes, weightSafetyMargin: safetyMargin,
    runtimeOverheadBytes, minimumVramHeadroomBytes: minimumHeadroomBytes,
    reservedHeadroomBytes, availableGpuBudgetBytes,
    estimatedCombinedUseBytes, warnings: [...new Set(warnings)], reason,
  }
}

export function normalizeLlamaCppFallback(options: LlamaCppFallbackOptions = {}): Required<LlamaCppFallbackOptions> {
  return {
    enabled: options.enabled ?? false,
    maxRetries: clamp(Math.floor(options.maxRetries ?? 2), 0, 2),
    reductionFactor: clamp(options.reductionFactor ?? 0.75, 0.25, 0.9),
    minimumGpuLayers: Math.max(0, Math.floor(options.minimumGpuLayers ?? 0)),
  }
}

export function nextGpuLayersAfterCudaOom(currentLayers: number, options: LlamaCppFallbackOptions = {}): number {
  const fallback = normalizeLlamaCppFallback(options)
  if (currentLayers <= fallback.minimumGpuLayers) return fallback.minimumGpuLayers
  return Math.max(fallback.minimumGpuLayers, Math.min(currentLayers - 1, Math.floor(currentLayers * fallback.reductionFactor)))
}

export function isCudaOutOfMemory(text: string): boolean {
  return /cudaMalloc failed|CUDA[^\n]*out of memory|failed to allocate CUDA|unable to allocate CUDA/i.test(text)
}
