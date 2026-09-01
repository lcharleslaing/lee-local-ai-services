import { access, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, extname, basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { DiscoveredModel, ExecutableInstallation, LocalAIProvider, ModelType } from './types.js'

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return resolve(path)
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true } catch { return false }
}

export async function findExecutable(name: string, additionalPaths: string[] = []): Promise<string | null> {
  const candidates = [
    ...additionalPaths.map(expandHome),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, name)),
  ]
  for (const candidate of candidates) if (await executable(candidate)) return candidate
  return null
}

export interface ExecutableSearch {
  provider: LocalAIProvider
  executableNames: string[]
  paths?: string[]
}

export async function discoverLocalAIServices(searches: ExecutableSearch[] = defaultExecutableSearches): Promise<ExecutableInstallation[]> {
  const installations: ExecutableInstallation[] = []
  for (const search of searches) {
    if (search.provider === 'whisper.cpp') {
      const { discoverWhisperExecutable } = await import('./whisper.js')
      const discovery = await discoverWhisperExecutable({ executableNames: search.executableNames, additionalPaths: search.paths })
      installations.push({ provider: search.provider, executable: discovery.executable, available: discovery.available, discoverySource: discovery.discoverySource, searchedPaths: discovery.searchedPaths })
      continue
    }
    let found: string | null = null
    for (const name of search.executableNames) {
      found = await findExecutable(name, search.paths)
      if (found) break
    }
    installations.push({ provider: search.provider, executable: found ?? search.executableNames[0] ?? '', available: found !== null })
  }
  return installations
}

export const defaultExecutableSearches: ExecutableSearch[] = [
  { provider: 'llama.cpp', executableNames: ['llama-server', 'server'], paths: ['~/AI/llama.cpp/build/bin/llama-server'] },
  {
    provider: 'whisper.cpp',
    executableNames: ['whisper-server', 'whisper-whisper-server'],
    paths: [
      '~/AI/whisper.cpp/build/bin/whisper-server', '~/AI/whisper.cpp/build/bin/whisper-whisper-server',
      '~/whisper.cpp/build/bin/whisper-server', '~/whisper.cpp/build/bin/whisper-whisper-server',
      '~/.local/bin/whisper-server', '~/.local/bin/whisper-whisper-server',
      '/usr/local/bin/whisper-server', '/usr/local/bin/whisper-whisper-server',
      '/usr/bin/whisper-server', '/usr/bin/whisper-whisper-server',
    ],
  },
  { provider: 'ollama', executableNames: ['ollama'] },
]

const modelExtensions = new Set(['.gguf', '.ggml', '.bin', '.onnx', '.safetensors', '.pt', '.pth', '.ckpt'])
function classifyModel(path: string, extension: string): ModelType {
  const lower = path.toLowerCase()
  if (lower.includes('whisper') || /ggml-(tiny|base|small|medium|large)/.test(lower)) return 'whisper'
  if (extension === '.gguf' || extension === '.ggml') return 'llm'
  if (extension === '.safetensors' || extension === '.ckpt') return 'image'
  return 'unknown'
}

export interface DiscoverModelsOptions { roots: string[]; maxDepth?: number; types?: ModelType[] }

export async function discoverModels(options: DiscoverModelsOptions): Promise<DiscoveredModel[]> {
  const output: DiscoveredModel[] = []
  const maxDepth = options.maxDepth ?? 8
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { await walk(path, depth + 1); continue }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      if (!modelExtensions.has(extension)) continue
      const type = classifyModel(path, extension)
      if (options.types && !options.types.includes(type)) continue
      const details = await stat(path)
      output.push({ path, filename: basename(path), type, format: extension.slice(1), sizeBytes: details.size })
    }
  }
  for (const root of options.roots.map(expandHome)) await walk(root, 0)
  return output.sort((a, b) => a.path.localeCompare(b.path))
}
