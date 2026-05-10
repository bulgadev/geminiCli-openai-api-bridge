# Thought Signature Fix — Gemini CLI Bridge + OpenCode

## What We're Doing

Fixing the `gemini-cli-mcp-openai-bridge` so AI coding agents (OpenCode) can use Gemini 2.5/3.x models that have **Thinking** capabilities. These models generate `thought_signature` alongside `functionCall` parts. The bridge must preserve and re-inject these signatures across conversation turns, otherwise the Gemini API rejects the request.

## The Bug (Two Errors Found)

### Error 1: `missing a thought_signature`

```
Unable to submit request because function call `read` in the 2. content block
is missing a `thought_signature`.
```

**What happened:** The bridge was stripping `thoughtSignature` from the Gemini response when converting to OpenAI format (OpenAI has no native thought field). On the next turn, when converting the assistant message back to Gemini format, the signature was absent, and Gemini rejected the request.

**Fix:** Added a module-level `Map<string, string>` cache keyed by function name. When the Gemini stream response has a `thoughtSignature` field, it's captured and cached. When converting OpenAI messages back to Gemini, the cache is looked up and the thought part (`{ thought: true, thoughtSignature: "..." }`) is injected before the `functionCall` part.

### Error 2: `thought` field expected BOOL but got string

```
Invalid value at 'request.contents[1].parts[0].thought' (TYPE_BOOL), "thought omitted"
```

**What happened:** The Vertex AI Gemini API expects `thought` to be a **boolean** (`true`), but the initial fix sent `"thought omitted"` (a string). This was a misunderstanding of the API schema — the `thought` field is `TYPE_BOOL`.

**Fix:** Changed `{ thought: 'thought omitted', ... }` to `{ thought: true, ... }`. The thought text placeholder is not needed; only the boolean flag and the `thoughtSignature` string are required.

### Error 3: Function response / function call count mismatch

```
Please ensure that the number of function response parts is equal to the
number of function call parts of the function call turn.
```

**NOT YET FIXED.** The Gemini API requires all `functionResponse` parts for a given `functionCall` turn to be in a **single** user message. But the bridge creates **separate** `{role: "user", parts: [{functionResponse: ...}]}` messages for each tool response, and Gemini validates strict 1:1 pairing of functionCall→functionResponse when thought signatures are present.

**Root cause:** In `gemini-client.ts`, the `openAIMessageToGemini` method handles `msg.role === 'tool'` by returning a single-part user message per tool response. If the model made N function calls, the history will contain N separate user-role messages with one `functionResponse` each, instead of one message with N `functionResponse` parts.

**Fix direction:** Batch consecutive tool responses into a single user message with multiple `functionResponse` parts. This requires modifying `openAIMessageToGemini` (or its caller in `sendMessageStream`) to merge adjacent `role: "tool"` messages into one content block.

## How to Run the Project

### Prerequisites

- Node >= 18
- `gemini-cli` installed and authenticated (`gemini` CLI command works)
- `@intelligentinternet/gemini-cli-mcp-openai-bridge` installed globally

### Development Workflow

The bridge-server source lives in `bridge-server/src/`. The compiled output runs from the global npm install at `/opt/homebrew/lib/node_modules/@intelligentinternet/gemini-cli-mcp-openai-bridge/`.

**To apply changes:**

```bash
# 1. Edit the source
vim bridge-server/src/gemini-client.ts

# 2. Copy to global install's src/
cp bridge-server/src/gemini-client.ts \
  /opt/homebrew/lib/node_modules/@intelligentinternet/gemini-cli-mcp-openai-bridge/src/

# 3. Rebuild
cd /opt/homebrew/lib/node_modules/@intelligentinternet/gemini-cli-mcp-openai-bridge/
# Temporarily rename the broken tsconfig
mv tsconfig.json tsconfig.json.bak
tsc --outDir dist --rootDir src --module nodenext --target es2022 \
  --moduleResolution nodenext --skipLibCheck --esModuleInterop src/gemini-client.ts
mv tsconfig.json.bak tsconfig.json

# Or just edit the dist JS directly (faster for debugging)
vim /opt/homebrew/lib/.../dist/gemini-client.js
```

**To start the bridge:**

```bash
GEMINI_MCP_PORT=9000 gemini-cli-bridge --mode edit --target-dir /Users/bulga --debug
```

The bridge serves at `http://127.0.0.1:9000/v1`.

### Why Not Build from the Project Folder

The bridge-server is designed to live inside the `gemini-cli` monorepo (as a git submodule at `gemini-cli/`). The `tsconfig.json` extends `../../tsconfig.json` (the monorepo root) and references `../core` and `../cli` packages. The submodule hasn't been initialized, so local builds from the project folder don't work. The global npm install provides a ready-to-run environment.

**To enable local builds:**

```bash
git submodule update --init --recursive
cd gemini-cli && npm install && cd ..
npm run port  # copies bridge-server into gemini-cli/packages/
npm run build # builds from within the monorepo
```

## Codebase Map

### Bridge Server (`bridge-server/src/`) — ~2,889 lines

```
bridge-server/src/
├── index.ts                  (377L) Entry point: CLI args, auth, Express setup
├── gemini-client.ts          (421L) ★ OUR MAIN FILE: OpenAI→Gemini translation,
│                                        schema sanitization, thought sig cache
├── mcp-test-client.ts        (198L) Standalone test client
├── types.ts                  (127L) OpenAI types, StreamChunk, SecurityPolicy
├── bridge/
│   ├── index.ts               (1L)  Barrel re-export
│   ├── bridge.ts             (589L) MCP server (GcliMcpBridge)
│   ├── openai.ts             (198L) POST /v1/chat/completions router
│   └── stream-transformer.ts (145L) SSE chunk → OpenAI delta formatter
├── config/
│   ├── config.ts             (214L) Server Config builder
│   ├── settings.ts           (251L) .gemini/settings.json loader
│   ├── extension.ts          (115L) Extension/MCP config loader
│   └── sandboxConfig.ts      (107L) Docker/podman sandbox resolver
└── utils/
    ├── error-mapper.ts        (63L)  OpenAI error format mapper
    ├── logger.ts              (34L)  Timestamped logger
    ├── package.ts             (38L)  package.json reader
    └── version.ts             (12L)  CLI version helper
```

### Key Files for This Fix

| File | Lines | Role |
|------|-------|------|
| `gemini-client.ts` | 421 | **The fix lives here.** `thoughtSignatureCache` + capture in stream + re-inject in `openAIMessageToGemini` |
| `bridge/openai.ts` | 198 | Routes `/v1/chat/completions`, calls `GeminiApiClient.sendMessageStream()` |
| `bridge/stream-transformer.ts` | 145 | Converts our `StreamChunk` objects into OpenAI SSE format |
| `types.ts` | 127 | `StreamChunk` type definition (text, tool_code, reasoning) |

### Flow of a Request

```
OpenCode ──POST /v1/chat/completions──→ openai.ts
                                            │
                                     GeminiApiClient.sendMessageStream()
                                            │
                                     openAIMessageToGemini() ← looks up cache
                                            │
                                     GeminiChat.sendMessageStream()
                                            │
                                     Gemini API (stream)
                                            │
                                     Stream capture ← caches thoughtSignature
                                            │
                                     createOpenAIStreamTransformer()
                                            │
                                     SSE response → OpenCode
```

## The 27k-Line Monolith (`@google/gemini-cli-core` v0.1.13)

Located at:
```
/opt/homebrew/lib/node_modules/@intelligentinternet/gemini-cli-mcp-openai-bridge/node_modules/@google/gemini-cli-core/
```

218 `.js` files, **27,413 lines** total.

### Critical Files for Thought-Signature Work

| File | Lines | Relevance |
|------|-------|-----------|
| `dist/src/core/geminiChat.js` | 510 | **★ THE KEY FILE** — `processStreamResponse()` yields thought chunks separately, `isThoughtContent()` checks `parts[0].thought === true`, `recordHistory()` strips thought content from history |
| `dist/src/core/turn.js` | 129 | `run()` detects `thoughtPart?.thought` and emits `Thought` events; this is where the CLI consumer receives thought data |
| `dist/src/core/client.js` | 486 | `GeminiClient.sendMessageStream()` — top-level orchestrator, enables `includeThoughts: true` for gemini-2.5 models |
| `dist/src/utils/messageInspectors.js` | 15 | `isFunctionResponse()` / `isFunctionCall()` — used by `geminiChat.js` for history decisions |
| `dist/src/utils/generateContentResponseUtilities.js` | 91 | Text extraction helpers |

### How `GeminiChat.processStreamResponse()` Works (Critical Detail)

```javascript
async *processStreamResponse(streamResponse, inputContent, startTime, prompt_id) {
    const outputContent = [];
    for await (const chunk of streamResponse) {
        if (isValidResponse(chunk)) {
            const content = chunk.candidates?.[0]?.content;
            if (content !== undefined) {
                if (this.isThoughtContent(content)) {
                    yield chunk;      // ← yields thought+functionCall to bridge
                    continue;         // ← skips outputContent.push
                }
                outputContent.push(content);
            }
        }
        yield chunk;                   // ← all non-thought chunks yield here
    }
    this.recordHistory(inputContent, outputContent);
}
```

Key insight: When a chunk has BOTH thought and functionCall parts, `isThoughtContent()` returns `true` (it only checks `parts[0].thought`). The chunk is yielded to the bridge but NOT added to `outputContent`. This means `recordHistory()` never sees the function call and doesn't add it to `GeminiChat.history`. This is fine for the bridge (which passes its own history), but explains why thoughts and function calls can arrive in the same or different chunks.

### The GenAI SDK Layer (`@google/genai` v1.9.0)

This is the lowest layer that talks to the Gemini/Vertex API. Located in:
```
.../node_modules/@google/genai/dist/index.mjs  ← 15,000+ line bundled file
```

The SDK's `partFromVertex()` / `partFromMldev()` functions extract 10 known fields from the raw API response into new Part objects. `thoughtSignature` (camelCase) IS extracted. Fields NOT in the known list are **silently stripped** — the SDK creates a brand new `toObject = {}` and only copies known fields.

### GenAI SDK Part Fields

| Field | Type | Preserved? |
|-------|------|------------|
| `text` | string | ✓ |
| `thought` | boolean | ✓ |
| `thoughtSignature` | string | ✓ |
| `functionCall` | object | ✓ |
| `functionResponse` | object | ✓ |
| `inlineData` | object | ✓ |
| `fileData` | object | ✓ |
| `codeExecutionResult` | object | ✓ |
| `executableCode` | object | ✓ |
| `videoMetadata` | object | ✓ |
| `thought_signature` (snake_case) | string | ✗ STRIPPED |
| Anything else | any | ✗ STRIPPED |
