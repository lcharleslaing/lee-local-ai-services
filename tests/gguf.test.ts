import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { inspectGgufModel } from '../src/index.js'

function u32(value: number): Buffer { const result = Buffer.alloc(4); result.writeUInt32LE(value); return result }
function u64(value: number): Buffer { const result = Buffer.alloc(8); result.writeBigUInt64LE(BigInt(value)); return result }
function string(value: string): Buffer { const bytes = Buffer.from(value); return Buffer.concat([u64(bytes.length), bytes]) }
function stringEntry(key: string, value: string): Buffer { return Buffer.concat([string(key), u32(8), string(value)]) }
function numberEntry(key: string, value: number): Buffer { return Buffer.concat([string(key), u32(4), u32(value)]) }

describe('GGUF inspection', () => {
  it('reads architecture, layer count, context, and file size safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gguf-inspection-'))
    const path = join(root, 'qwen.gguf')
    const file = Buffer.concat([
      Buffer.from('GGUF'), u32(3), u64(0), u64(4),
      stringEntry('general.architecture', 'qwen3moe'),
      stringEntry('general.name', 'Qwen Coder'),
      numberEntry('qwen3moe.block_count', 48),
      numberEntry('qwen3moe.context_length', 32768),
    ])
    await writeFile(path, file)
    await expect(inspectGgufModel(path)).resolves.toMatchObject({
      path, sizeBytes: file.length, ggufVersion: 3, architecture: 'qwen3moe', name: 'Qwen Coder', layerCount: 48, contextLength: 32768,
    })
  })
})
