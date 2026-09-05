# Backend Overview

The backend is a Rust application built with Tauri 2. It is a desktop AI client: it manages configuration, connects to already-running local runtimes, and will eventually connect to external AI APIs. It does not host models, run inference servers, or expose an AI API.

## Startup and IPC

`src/main.rs` calls `aiinterface_lib::run()`. `src/lib.rs` creates the Tauri application, registers the opener plugin, initializes the in-memory log store, registers commands, and starts the event loop.

React communicates with Rust through Tauri IPC using `invoke(...)` from `@tauri-apps/api/core`. Command arguments and return values are serialized through Tauri's JSON boundary.

Blocking work is moved to `spawn_blocking` where appropriate. Native dialogs use asynchronous `rfd` APIs. Runtime probes and model-directory scans run on blocking workers and are parallelized by runtime.

## Implemented Functionality

### Settings

Settings are stored as JSON at the Tauri application-data directory in `settings.json`. The frontend loads settings once and saves changes with a 250 ms debounce. The backend enforces a 32 MiB JSON limit.

Settings remain intentionally JSON-shaped at this boundary for compatibility with the existing frontend.

### Conversations and folders

Conversation storage now has two levels:

```text
<app data directory>/conversations/index.json
<app data directory>/conversations/<conversation-id>.json
```

`index.json` contains lightweight conversation summaries and folder metadata. Individual conversation files contain full message content.

The frontend loads the index for the sidebar, then loads only the selected conversation record. Metadata changes save the index. A conversation record is written only when its message collection changes. Deleted records are removed individually.

The scoped commands are:

- `load_conversation_index`
- `load_conversation`
- `save_conversation_index`
- `save_conversation`
- `delete_conversation`
- `clear_conversations`

The older `load_conversations` and `save_conversations` commands remain registered for compatibility with older frontend builds. The save compatibility command writes the indexed format. Existing `conversations.json` files are migrated on the first index load without deleting the original file.

Conversation IDs are validated before being used as filenames to prevent path traversal.

### Storage reliability

`storage.rs` bounds JSON payloads at 32 MiB, creates parent directories, writes to a temporary file, flushes it with `sync_all`, and then replaces the destination. When replacement fails because the destination exists, the old file is moved to a backup while replacement is attempted; the backup is restored if replacement fails.

This avoids the previous unconditional delete-before-replace behavior. The write lock is held only for the filesystem replacement sequence, not during JSON serialization.

### Local runtime discovery

`local_runtimes.rs` is the single authoritative discovery implementation. Both `get_ai_sources` and the compatibility `get_local_runtimes` command use it.

It detects:

- Ollama through `PATH` and `http://127.0.0.1:11434/api/tags`
- LM Studio through `http://127.0.0.1:1234/v1/models` and common Windows install paths
- llama.cpp/GGUF through configured directory scanning up to four levels deep

Results are cached for 10 seconds using normalized model-directory paths as the cache key. The cache is bounded to four entries. Changing the configured directory list uses a different key; normal expiry handles changes inside an unchanged directory. React starts discovery after the settings/UI initialization path, so the usable interface is rendered before runtime probing begins.

GGUF scans report debug-only counts for entries, directories, models, and elapsed time. No model weights are loaded or executed.

### Credentials

Provider credentials are stored through the operating system credential manager using `keyring`. Raw API keys are not written to settings or conversation files.

## AI Client Layer

The AI client layer is implemented in `ai/client.rs`, `ai/ollama.rs`, `ai/openai.rs`, `ai/registry.rs`, and `ai/mod.rs`.

The common request model contains a request ID, provider ID, model ID, and application-level messages. Rust validates the request before selecting an adapter. Provider-specific wire formats remain inside the adapter; React does not construct Ollama payloads.

The common client contract exposes typed requests, normalized models, optional capabilities, streaming kinds, and cancellation. `ProviderRegistry` is the central lookup for registered clients; adding a compatible provider registers a definition/client without changing the conversation UI. Actual reasoning visibility still depends on receiving reasoning data from the selected model.

The current commands are:

- `send_message`: non-streaming request/response path.
- `stream_message`: background streaming request that emits `ai://stream` events.
- `cancel_message`: requests cancellation for an active stream.
- `discover_provider_models`: lazy model discovery for configured API providers.

Ollama is contacted through the existing local service at `http://127.0.0.1:11434`. The managed AI request state owns a reusable `ureq::Agent`, sends `/api/chat` payloads, parses Ollama JSON responses, and maps provider/runtime failures to stable backend error codes. It never starts Ollama, downloads models, loads weights, or exposes a server.

The first external adapter is reusable OpenAI-compatible chat completions in `ai/openai.rs`. It is registered for both stable provider IDs `openai` and `openrouter`, with provider-specific base URLs and keyring accounts. It validates HTTPS endpoints, retrieves API keys from the OS credential manager only inside Rust, supports `/models` discovery, typed chat requests, SSE streaming, cancellation checks, and sanitized authentication/model/rate-limit/network/provider failures. Provider metadata and typed model lists may be stored in settings, but credentials are not.

Streaming emits only incremental assistant chunks, a completion event, or an error event. The frontend keeps the active assistant response in memory and does not persist the conversation on every chunk. Cancellation state is bounded to active request IDs and is removed when a request finishes.

Ollama thinking-capable models may return a native `message.thinking` field when the request's `think` flag is enabled. That field is normalized into optional response reasoning and emitted as a separate `thinking` stream event. No reasoning text is generated or inferred by AI Interface. Models that do not provide the field continue through the normal answer path.

The frontend's `Show AI reasoning` setting defaults to off and is persisted with the other settings. When enabled, it shows only a bounded rolling window of provider-supplied thinking text. When disabled, thinking text is not displayed and the assistant message uses a compact animated indicator until answer content arrives. Reasoning is retained only as bounded assistant-message metadata when the completed conversation is persisted.

### System information

The backend collects OS, kernel, host, uptime, CPU, memory, disk, network-interface, and Windows NVIDIA GPU information. The operation runs in a blocking worker because it performs system enumeration and a CPU refresh interval.

Developer tools can be toggled only in development builds.

### Logging

The backend keeps at most 200 log entries in memory. Messages are limited to 16 KiB with UTF-8-safe truncation.

Debug console output from React is buffered for up to 50 ms or 20 messages and sent through the batched `append_logs` command. The single-entry `append_log` command remains available for compatibility. Logs are not persisted across application restarts.

### Errors

Backend commands use the serializable `BackendError` contract where practical. Errors contain a stable code and a frontend-safe detail string. Current categories include invalid input, settings, conversations, credentials, filesystem operations, runtime discovery, system information, and logging.

## Debug Instrumentation

Development builds emit lightweight timing information for:

- Runtime HTTP probes
- Runtime discovery
- GGUF scanning and file counts
- JSON reads
- JSON serialization and writes
- Selected existing system-information operations
- Runtime executable lookup, loopback preflight, HTTP probe, and total detection per runtime
- Model-directory normalization and GGUF metadata/stat calls

Release builds exclude these debug timing messages through conditional compilation. Instrumentation is diagnostic only and is not used as application state.

## Partially Implemented

- Conversation storage migration is automatic, but the legacy file is retained for compatibility and cleanup is not automatic.
- External OpenAI-compatible requests and model discovery are implemented for OpenAI and OpenRouter; a real API-key integration test remains environment-dependent.
- Ollama request and streaming support is implemented; LM Studio and llama.cpp are still detection-only and do not send chat requests.
- The frontend shows a stop action for streaming generation. Ollama streaming uses a short per-read timeout so the existing cancellation flag is observed promptly between response lines without shortening the overall request timeout.
- The frontend still retains loaded conversations in React state while the app is open; the backend storage boundary now avoids loading all message bodies at startup.
- Settings and conversation schemas are only partially typed. Conversation index records are typed in Rust, while full message payloads remain JSON-shaped.

## Scaffolding

The following abstractions exist but are not connected to real AI requests:

- `ProviderAdapter` in `ai/providers.rs`
- `LocalModelBackend` in `ai/local_models.rs`
- Additional incompatible provider adapters such as Anthropic- or Google-specific protocols
- Additional provider catalog metadata returned by `get_ai_sources`
- Local inference settings such as CPU threads, context size, and hardware preference

`get_ai_sources` remains runtime-focused and does not probe external APIs at startup. The `ProviderAdapter` and `LocalModelBackend` traits remain extension points; they do not claim to execute models. Ollama and OpenAI-compatible clients are implemented separately while sharing the common request/stream contract.

## Planned

Future AI work should add external API adapters and extend the same Rust client/orchestration layer to additional existing local runtime services:

```text
React
  -> Tauri command or streaming bridge
  -> Rust AI client layer
  -> external API or already-running local runtime
```

That layer should eventually support request cancellation, incremental response chunks, connection cleanup, and minimal copying across the IPC boundary. It must remain a client and must not host inference, start a model-serving platform, or expose a network API for other applications.

## Validation

The desktop clipboard path uses the official Tauri clipboard-manager plugin. React calls the plugin's native `writeText` API through a shared helper for Copy, Share fallback, and log export. Share first attempts the WebView's native share surface when available, then falls back to the native clipboard without uploading content anywhere. The clipboard capability is granted only to the main window.

Backend unit tests cover:

- JSON write/read round-tripping
- Conversation-ID path traversal rejection
- Runtime-directory normalization
- Common AI request validation
- Ollama request serialization and response parsing
- Active AI request cancellation and cleanup

The manual Ollama integration was verified against a locally running Ollama service using the installed `gemma4:12b` model. The service returned a successful non-streaming response. Development timing instrumentation remains available for measuring the Tauri command and stream path with representative prompts.

The main performance values are emitted only in development builds. Production performance should be measured with representative conversation sizes and model directories rather than inferred from debug timings alone.
