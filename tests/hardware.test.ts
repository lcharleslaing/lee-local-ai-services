import { describe, expect, it } from 'vitest'
import { discoverLocalHardware, parseNvidiaSmiCsv, parseProcMeminfo } from '../src/index.js'

describe('hardware discovery', () => {
  it('parses current NVIDIA VRAM values for multiple GPUs', () => {
    const gpus = parseNvidiaSmiCsv('0, NVIDIA RTX 4070, 12282, 11300, 580.82\n1, NVIDIA RTX 3060, 12288, 9000, 580.82\n')
    expect(gpus).toHaveLength(2)
    expect(gpus[0]).toMatchObject({ index: 0, name: 'NVIDIA RTX 4070', totalVramBytes: 12282 * 1024 ** 2, availableVramBytes: 11300 * 1024 ** 2 })
  })

  it('uses Linux MemAvailable rather than treating only free pages as usable RAM', () => {
    expect(parseProcMeminfo('MemTotal:       32768000 kB\nMemFree:         1000000 kB\nMemAvailable:   28000000 kB\n')).toEqual({
      totalBytes: 32768000 * 1024,
      availableBytes: 28000000 * 1024,
    })
  })

  it('degrades gracefully when nvidia-smi is unavailable', async () => {
    const hardware = await discoverLocalHardware({
      commandRunner: async () => { throw new Error('missing') },
      systemRamTotalBytes: 32 * 1024 ** 3,
      systemRamAvailableBytes: 28 * 1024 ** 3,
    })
    expect(hardware.gpus).toEqual([])
    expect(hardware.warnings.join(' ')).toContain('nvidia-smi')
  })
})
