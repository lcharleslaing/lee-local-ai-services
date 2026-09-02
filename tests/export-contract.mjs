import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const required = [
  'LocalAIManager', 'OpenAICompatibleClient', 'copyReportToClipboard', 'createLocalAIManager',
  'createLocalAIReport', 'createOpenAICompatibleClient', 'defineCustomAIService',
  'defineLlamaCppService', 'defineWhisperService', 'discoverLocalAIServices', 'discoverModels',
  'definePlannedLlamaCppService', 'discoverLocalHardware', 'estimateLlamaCppKvCacheBytes',
  'expandHome', 'findExecutable', 'inspectGgufModel', 'isCudaOutOfMemory',
  'nextGpuLayersAfterCudaOom', 'parseNvidiaSmiCsv', 'parseProcMeminfo', 'planLlamaCppLaunch',
  'WhisperClient', 'createWhisperClient', 'defineResolvedWhisperService',
  'discoverWhisperExecutable', 'discoverWhisperModels', 'isRealWhisperModelFilename',
  'probeWhisperService', 'resolveAndDefineWhisperService', 'resolveWhisperService',
  'MusicWhisperClient', 'MusicWhisperError', 'WhisperCppTranscriptionAdapter',
  'createMusicWhisperClient', 'createWhisperCppTranscriptionAdapter',
  'defineMusicWhisperService', 'normalizeTranscriptionResponse',
]
const esm = await import('../dist/index.js')
const cjs = createRequire(import.meta.url)('../dist/index.cjs')
for (const name of required) {
  assert.equal(typeof esm[name], 'function', `ESM export missing: ${name}`)
  assert.equal(typeof cjs[name], 'function', `CJS export missing: ${name}`)
}
console.log(`Export contract passed: ${required.length} ESM and CJS exports`)
