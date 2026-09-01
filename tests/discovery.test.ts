import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { discoverLocalAIServices, discoverModels, findExecutable } from '../src/index.js'

describe('discovery', () => {
  it('finds executable override paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-ai-executable-'))
    const file = join(root, 'llama-server')
    await writeFile(file, '#!/bin/sh\n')
    await chmod(file, 0o755)
    expect(await findExecutable('missing-llama', [file])).toBe(file)
    const found = await discoverLocalAIServices([{ provider: 'my-llm', executableNames: ['missing-llama'], paths: [file] }])
    expect(found[0]).toMatchObject({ provider: 'my-llm', available: true, executable: file })
  })

  it('recursively classifies common local model files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-ai-models-'))
    await mkdir(join(root, 'LLM'))
    await mkdir(join(root, 'Whisper'))
    await writeFile(join(root, 'LLM', 'qwen.gguf'), '123')
    await writeFile(join(root, 'Whisper', 'ggml-medium.bin'), '12345')
    await writeFile(join(root, 'ignore.txt'), 'x')
    const models = await discoverModels({ roots: [root] })
    expect(models.map((model) => [model.filename, model.type, model.sizeBytes])).toEqual([
      ['qwen.gguf', 'llm', 3],
      ['ggml-medium.bin', 'whisper', 5],
    ])
  })
})
