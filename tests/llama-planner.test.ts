import { describe, expect, it } from 'vitest'
import { estimateLlamaCppKvCacheBytes, nextGpuLayersAfterCudaOom, planLlamaCppLaunch, type GgufModelInfo, type LocalHardwareInfo } from '../src/index.js'

const GIB = 1024 ** 3
function model(sizeGiB: number, layers = 48): GgufModelInfo {
  return { path: `/models/${sizeGiB}.gguf`, sizeBytes: sizeGiB * GIB, format: 'gguf', architecture: 'qwen3moe', layerCount: layers, metadata: {}, warnings: [] }
}
function hardware(vramGiB = 12, availableVramGiB = 11.5, ramGiB = 32, availableRamGiB = 30): LocalHardwareInfo {
  return {
    systemRamTotalBytes: ramGiB * GIB,
    systemRamAvailableBytes: availableRamGiB * GIB,
    gpus: [{ index: 0, name: 'Mock NVIDIA GPU', backend: 'nvidia-cuda', totalVramBytes: vramGiB * GIB, availableVramBytes: availableVramGiB * GIB }],
    gpuCount: 1, discoveredAt: new Date('2026-09-01T00:00:00Z'), warnings: [],
  }
}

describe('llama.cpp launch planning', () => {
  it('nearly or fully offloads a 4 GiB model to a 12 GiB GPU', async () => {
    const plan = await planLlamaCppLaunch({ model: model(4), hardware: hardware(), contextSize: 8192, gpuOffload: { mode: 'balanced' } })
    expect(plan.recommendedGpuLayers).toBe(48)
    expect(plan.fullGpuOffload).toBe(true)
    expect(plan.runnable).toBe(true)
  })

  it('partially offloads a 17.4 GiB model across 12 GiB VRAM and 32 GiB RAM', async () => {
    const plan = await planLlamaCppLaunch({ model: model(17.4), hardware: hardware(), contextSize: 8192, gpuOffload: { mode: 'balanced' } })
    expect(plan.recommendedGpuLayers).toBeGreaterThan(0)
    expect(plan.recommendedGpuLayers).toBeLessThan(48)
    expect(plan.usesSystemRam).toBe(true)
    expect(plan.runnable).toBe(true)
    expect(plan.warnings.join(' ')).toContain('partial GPU offload')
  })

  it('warns that a 45 GiB model is likely unsafe with currently available combined memory', async () => {
    const plan = await planLlamaCppLaunch({ model: model(45), hardware: hardware(), contextSize: 8192, gpuOffload: { mode: 'balanced' } })
    expect(plan.runnable).toBe(false)
    expect(plan.warnings.join(' ')).toContain('exceeds currently available system RAM')
  })

  it('honors manual gpuLayers and warns when the request appears unsafe', async () => {
    const plan = await planLlamaCppLaunch({ model: model(17.4), hardware: hardware(), gpuOffload: { mode: 'manual', gpuLayers: 999 } })
    expect(plan.recommendedGpuLayers).toBe(999)
    expect(plan.warnings.join(' ')).toContain('appears unsafe')
  })

  it('uses CPU-only mode when GPU metrics are unavailable', async () => {
    const withoutGpu = { ...hardware(), gpus: [], gpuCount: 0, warnings: ['nvidia-smi unavailable'] }
    const plan = await planLlamaCppLaunch({ model: model(4), hardware: withoutGpu, gpuOffload: { mode: 'auto' } })
    expect(plan.recommendedGpuLayers).toBe(0)
    expect(plan.warnings.join(' ')).toContain('CPU-only')
  })

  it('reserves more memory for a large context and recommends no more layers', async () => {
    const small = await planLlamaCppLaunch({ model: model(17.4), hardware: hardware(), contextSize: 4096, gpuOffload: { mode: 'balanced' } })
    const large = await planLlamaCppLaunch({ model: model(17.4), hardware: hardware(), contextSize: 65536, gpuOffload: { mode: 'balanced' } })
    expect(estimateLlamaCppKvCacheBytes(65536)).toBeGreaterThan(estimateLlamaCppKvCacheBytes(4096))
    expect(large.reservedHeadroomBytes).toBeGreaterThan(small.reservedHeadroomBytes)
    expect(large.recommendedGpuLayers).toBeLessThanOrEqual(small.recommendedGpuLayers)
  })

  it('reduces GPU layers predictably after CUDA OOM', () => {
    expect(nextGpuLayersAfterCudaOom(56, { enabled: true, reductionFactor: 0.75 })).toBe(42)
  })
})
