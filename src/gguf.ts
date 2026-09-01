import { open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { GgufModelInfo } from './types.js'

const MAX_METADATA_SCAN_BYTES = 32 * 1024 * 1024
const MAX_STRING_BYTES = 2 * 1024 * 1024

class GgufReader {
  offset = 0
  constructor(readonly handle: FileHandle, readonly limit: number) {}
  async bytes(length: number): Promise<Buffer> {
    if (length < 0 || this.offset + length > this.limit) throw new Error('GGUF metadata scan limit reached')
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await this.handle.read(buffer, 0, length, this.offset)
    if (bytesRead !== length) throw new Error('Unexpected end of GGUF file')
    this.offset += length
    return buffer
  }
  async u8(): Promise<number> { return (await this.bytes(1)).readUInt8() }
  async i8(): Promise<number> { return (await this.bytes(1)).readInt8() }
  async u16(): Promise<number> { return (await this.bytes(2)).readUInt16LE() }
  async i16(): Promise<number> { return (await this.bytes(2)).readInt16LE() }
  async u32(): Promise<number> { return (await this.bytes(4)).readUInt32LE() }
  async i32(): Promise<number> { return (await this.bytes(4)).readInt32LE() }
  async u64(): Promise<number> { const value = (await this.bytes(8)).readBigUInt64LE(); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF integer exceeds safe range'); return Number(value) }
  async i64(): Promise<number> { return Number((await this.bytes(8)).readBigInt64LE()) }
  async f32(): Promise<number> { return (await this.bytes(4)).readFloatLE() }
  async f64(): Promise<number> { return (await this.bytes(8)).readDoubleLE() }
  async string(): Promise<string> { const length = await this.u64(); if (length > MAX_STRING_BYTES) throw new Error('GGUF string exceeds safe metadata limit'); return (await this.bytes(length)).toString('utf8') }
}

async function readValue(reader: GgufReader, type: number, keep: boolean): Promise<unknown> {
  switch (type) {
    case 0: return reader.u8()
    case 1: return reader.i8()
    case 2: return reader.u16()
    case 3: return reader.i16()
    case 4: return reader.u32()
    case 5: return reader.i32()
    case 6: return reader.f32()
    case 7: return (await reader.u8()) !== 0
    case 8: return reader.string()
    case 9: {
      const itemType = await reader.u32()
      const length = await reader.u64()
      const retained: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const value = await readValue(reader, itemType, false)
        if (keep && index < 32) retained.push(value)
      }
      return keep ? retained : undefined
    }
    case 10: return reader.u64()
    case 11: return reader.i64()
    case 12: return reader.f64()
    default: throw new Error(`Unsupported GGUF metadata value type: ${type}`)
  }
}

export async function inspectGgufModel(path: string): Promise<GgufModelInfo> {
  const details = await stat(path)
  const result: GgufModelInfo = { path, sizeBytes: details.size, format: 'gguf', metadata: {}, warnings: [] }
  const handle = await open(path, 'r')
  try {
    const reader = new GgufReader(handle, Math.min(details.size, MAX_METADATA_SCAN_BYTES))
    if ((await reader.bytes(4)).toString('ascii') !== 'GGUF') throw new Error('File does not have a GGUF header')
    result.ggufVersion = await reader.u32()
    result.tensorCount = await reader.u64()
    result.metadataCount = await reader.u64()
    for (let index = 0; index < result.metadataCount; index += 1) {
      const key = await reader.string()
      const type = await reader.u32()
      if (key.startsWith('tokenizer.')) {
        result.warnings.push('Stopped GGUF metadata scanning before large tokenizer data; model planning metadata was preserved.')
        break
      }
      const interesting = key === 'general.architecture' || key === 'general.name' || key.endsWith('.block_count') || key.endsWith('.context_length')
      const value = await readValue(reader, type, interesting)
      if (interesting && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) result.metadata[key] = value
      const architecture = result.metadata['general.architecture']
      if (typeof architecture === 'string' && result.metadata[`${architecture}.block_count`] !== undefined && result.metadata[`${architecture}.context_length`] !== undefined) break
    }
  } catch (error) {
    result.warnings.push(`GGUF metadata was only partially available: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await handle.close()
  }
  result.architecture = typeof result.metadata['general.architecture'] === 'string' ? result.metadata['general.architecture'] : undefined
  result.name = typeof result.metadata['general.name'] === 'string' ? result.metadata['general.name'] : undefined
  const architecture = result.architecture
  const layerValue = architecture ? result.metadata[`${architecture}.block_count`] : Object.entries(result.metadata).find(([key]) => key.endsWith('.block_count'))?.[1]
  const contextValue = architecture ? result.metadata[`${architecture}.context_length`] : Object.entries(result.metadata).find(([key]) => key.endsWith('.context_length'))?.[1]
  result.layerCount = typeof layerValue === 'number' && layerValue > 0 ? Math.floor(layerValue) : undefined
  result.contextLength = typeof contextValue === 'number' && contextValue > 0 ? Math.floor(contextValue) : undefined
  if (!result.layerCount) result.warnings.push('GGUF layer count could not be determined safely.')
  return result
}
