# @leelaing/local-ai-services

Framework-agnostic TypeScript tools for discovering, configuring, starting, stopping, inspecting, and communicating with local AI services. Process lifecycle management is delegated to [`@leelaing/service-manager`](https://www.npmjs.com/package/@leelaing/service-manager).

## Install

```bash
npm install @leelaing/local-ai-services
```

Requires Node.js 20 or newer.

## Configure and manage services

```ts
import {
  createLocalAIManager,
  definePlannedLlamaCppService,
  defineWhisperService,
} from '@leelaing/local-ai-services'

const deep = await definePlannedLlamaCppService({
  id: 'deep',
  port: 8080,
  model: '/home/lee/AI/Models/LLM/qwen.gguf',
  contextSize: 8192,
  gpuOffload: { mode: 'balanced' },
  fallback: { enabled: true, maxRetries: 2 },
})

const ai = createLocalAIManager({
  services: [
    deep,
    defineWhisperService({
      id: 'whisper',
      port: 8178,
      model: '/home/lee/AI/Models/Whisper/medium.bin',
    }),
  ],
})

await ai.start('deep')
console.log(await ai.statusAll())
await ai.restart('deep')
await ai.stop('deep')
```

Service types and provider names are intentionally extensible. Use `defineCustomAIService()` for any backend that does not yet have a built-in adapter.

## Resolve a usable local Whisper service

Applications do not need to know where whisper.cpp was cloned or which application installed it. Resolution first probes compatible running HTTP services, then performs bounded executable and model discovery only as needed.

```ts
import {
  createLocalAIManager,
  resolveAndDefineWhisperService,
} from '@leelaing/local-ai-services'

const { resolution, service } = await resolveAndDefineWhisperService({
  id: 'whisper',
  host: '127.0.0.1',
  preferredPort: 8178,
  candidatePorts: [8091],
})

const ai = createLocalAIManager({ services: [service] })

if (resolution.connectable) {
  const transcript = await ai.transcribe({
    service: 'whisper',
    file: '/path/recording.wav',
  })
  console.log(transcript)
} else if (resolution.startable) {
  await ai.start('whisper')
}
```

Resolution distinguishes these states explicitly:

- `connectable: true`: a compatible Whisper HTTP service is already running; no executable is required
- `startable: true`: a real Whisper server executable and model were discovered and can be lifecycle-managed
- both false: neither a compatible running service nor a startable installation was found

### External unmanaged Whisper

A discovered running service is represented without a command:

```ts
import { defineWhisperService } from '@leelaing/local-ai-services'

const external = defineWhisperService({
  id: 'external-whisper',
  host: '127.0.0.1',
  port: 8178,
  external: true,
  managed: false,
  connectable: true,
})
```

`LocalAIManager` can check and use this endpoint, but `stop()` and `restart()` never terminate or signal an external process that the manager did not launch.

### Whisper discovery details

```ts
import {
  discoverWhisperExecutable,
  discoverWhisperModels,
  probeWhisperService,
  resolveWhisperService,
} from '@leelaing/local-ai-services'

const executable = await discoverWhisperExecutable()
const models = await discoverWhisperModels()
const endpoint = await probeWhisperService({ port: 8178 })
const resolved = await resolveWhisperService({ preferredPort: 8178 })
```

Executable discovery checks `PATH`, known binary locations, and bounded searches beneath common AI, programming, service, and application roots. It reports every direct path or bounded root searched and stops at configured depth/directory limits.

Model discovery recognizes real `ggml-tiny*`, `ggml-base*`, `ggml-small*`, `ggml-medium*`, and `ggml-large*` `.bin` files. Obvious fixtures/test models and files below the minimum realistic size are ignored. Default roots include `~/AI/Models/Whisper`, `~/AI/Models`, `~/AI/whisper.cpp/models`, and `~/whisper.cpp/models`.

Endpoint probing requires whisper.cpp's healthy `/health` response and a compatible POST-only `/inference` route. An unrelated HTTP service is not accepted merely because its port is open. Executable discovery recognizes both `whisper-server` and the alternate `whisper-whisper-server` name.

## Hardware-aware llama.cpp planning

`definePlannedLlamaCppService()` reads current Linux system-memory availability, queries every NVIDIA GPU through `nvidia-smi`, safely inspects useful GGUF metadata, and calculates `-ngl` without assuming the entire model fits in VRAM.

Available modes:

- `auto`: choose a conservative safe split from current hardware and model data
- `balanced`: substantial GPU acceleration with comfortable VRAM headroom
- `max-gpu`: maximize GPU layers while retaining minimum runtime headroom
- `cpu-heavy`: favor system RAM and use fewer GPU layers
- `manual`: honor an explicit `gpuLayers` value

The existing synchronous API remains available for manual/backward-compatible configuration:

```ts
import { defineLlamaCppService } from '@leelaing/local-ai-services'

const manual = defineLlamaCppService({
  id: 'manual',
  model: '/models/model.gguf',
  gpuLayers: 24,
})
```

### Pre-flight planning

```ts
import { discoverLocalHardware, inspectGgufModel, planLlamaCppLaunch } from '@leelaing/local-ai-services'

const hardware = await discoverLocalHardware()
const model = await inspectGgufModel('/models/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf')

const plan = await planLlamaCppLaunch({
  model,
  hardware,
  contextSize: 8192,
  gpuOffload: {
    mode: 'balanced',
    minimumVramHeadroomBytes: 2 * 1024 ** 3,
  },
})

console.log({
  runnable: plan.runnable,
  gpuLayers: plan.recommendedGpuLayers,
  gpuUse: plan.estimatedGpuUseBytes,
  systemRamUse: plan.estimatedSystemRamUseBytes,
  warnings: plan.warnings,
  reason: plan.reason,
})
```

The calculation reserves memory for estimated KV cache, CUDA/runtime buffers, configurable minimum VRAM headroom, and GGUF-to-runtime weight overhead. It uses current `memory.free` from `nvidia-smi` and Linux `MemAvailable`, not only installed-memory totals.

### Bounded CUDA OOM fallback

Fallback is opt-in and never loops indefinitely:

```ts
const service = await definePlannedLlamaCppService({
  id: 'deep',
  model: '/models/qwen.gguf',
  gpuOffload: { mode: 'balanced' },
  fallback: {
    enabled: true,
    maxRetries: 2,       // clamped to a maximum of two
    reductionFactor: 0.75,
    minimumGpuLayers: 0,
  },
})
```

Only recognized CUDA allocation/OOM failures trigger a retry. Each attempt, selected layer count, failure, and eventual fallback success is retained in service status and diagnostic reports.

## Generate and copy a diagnostic report

Reports are plain text so they can be pasted directly into ChatGPT, an issue, email, or another application.

```ts
const report = await ai.createReport({
  includeConfiguration: true,
  includeLogs: true,
  logLines: 30,
})

await ai.copyReportToClipboard(
  { includeConfiguration: true, includeLogs: true },
  navigator.clipboard,
)
```

Environment variable names are shown in configuration reports, but their values are always hidden.

For planned llama.cpp services, reports also include the requested mode, planned and actual GPU layers, exact detected VRAM and system RAM values, model size and architecture, estimated GPU/RAM split, reserved headroom, warnings, and all bounded fallback attempts.

## Discover models and executables

```ts
import { discoverLocalAIServices, discoverModels } from '@leelaing/local-ai-services'

const installations = await discoverLocalAIServices()
const models = await discoverModels({
  roots: ['~/AI/Models', '~/AI/Models/LLM', '~/AI/Models/Whisper'],
})
```

## Chat with an OpenAI-compatible local server

```ts
const response = await ai.chat({
  service: 'deep',
  messages: [{ role: 'user', content: 'Hello' }],
})

console.log(response.choices[0]?.message.content)
```

Use `ai.rawRequest()` when a backend-specific endpoint or option is needed.

## Events

```ts
ai.on('service:state', (id, state) => console.log(id, state))
ai.on('service:ready', (status) => console.log(status.id, 'ready'))
ai.on('service:log', (id, entry) => console.log(id, entry.text))
ai.on('service:error', (id, error) => console.error(id, error))
ai.on('model:changed', (id, model) => console.log(id, model))
```

## Development

```bash
npm install
npm run check
npm publish --dry-run
```

`npm run check` performs TypeScript checking, ESLint, Vitest, a production dual ESM/CJS build, and a built-package export contract test.
