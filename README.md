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
  defineLlamaCppService,
  defineWhisperService,
} from '@leelaing/local-ai-services'

const ai = createLocalAIManager({
  services: [
    defineLlamaCppService({
      id: 'deep',
      port: 8080,
      model: '/home/lee/AI/Models/LLM/qwen.gguf',
      gpuLayers: 999,
      contextSize: 8192,
    }),
    defineLlamaCppService({
      id: 'fast',
      port: 8081,
      model: '/home/lee/AI/Models/LLM/fast.gguf',
    }),
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
