# Aether

**A modern Windows desktop AI workspace for local and cloud-based AI models.**

Aether is a focused desktop AI client built with **React, TypeScript, Vite, Tauri 2, and Rust**. It connects to locally hosted models through Ollama and to supported OpenAI-compatible APIs, while keeping application settings and conversations on the user's computer.

> Aether is the user-facing product name. The internal Tauri application identifier is `aiinterface`.

## Features

- Chat with local Ollama models or supported cloud APIs
- Stream responses and preserve conversations locally
- Edit messages and regenerate responses
- Organize conversations into folders
- Discover available local runtimes and models
- Connect to OpenAI, OpenRouter, and custom OpenAI-compatible APIs
- Store provider credentials securely through the Windows credential manager
- Customize the appearance and behavior of the workspace
- Install signed application updates from GitHub Releases

## AI Providers

### Ollama

Aether can connect to an Ollama installation running locally at `http://127.0.0.1:11434`. This supports locally installed models, streaming responses, cancellation, and provider-supplied reasoning output.

Aether does not install Ollama, download models, or start the Ollama service. Ollama and the desired model must already be installed and running.

### OpenAI

Aether supports OpenAI's API through its OpenAI-compatible client. An OpenAI API key is required.

### OpenRouter

Aether supports OpenRouter through its OpenAI-compatible API. An OpenRouter API key is required.

### Custom OpenAI-Compatible APIs

Aether can connect to other endpoints that implement the OpenAI chat-completions and model-list APIs. Custom endpoints are configured in Settings.

## Privacy and Data

Aether is designed for local-first use:

- Conversations are stored locally as JSON files.
- Application settings are stored locally.
- Provider API keys are stored through the Windows operating system credential manager.
- Aether does not operate a remote conversation database or analytics backend.

When a cloud provider is selected, prompts and conversation context are sent to that provider according to its service and privacy policies. Local Ollama usage can remain on the computer.

Conversation and settings files are readable local files. They are not encrypted by Aether.

## Windows Support

The application currently targets **Windows x64**. The recommended distribution is the Tauri NSIS installer:

```text
Aether_1.1.0_x64-setup.exe
```

Released users do not need Node.js, pnpm, Rust, Cargo, Visual Studio, or a development environment. Aether is packaged with its native application runtime and assets.

There is currently no published macOS, Linux, ARM64, or mobile release workflow.

## Installation

After a release has been published, download the latest Windows installer from the [Aether GitHub Releases](https://github.com/96Watts/Aether/releases) page. Run the `Aether_<version>_x64-setup.exe` file and follow the installation prompts.

The repository does not currently have a published release, so the download links will become active after the first signed release is created.

After a release containing `install-release.ps1` has been published, Windows PowerShell users can install the latest release with:

```powershell
irm https://github.com/96Watts/Aether/releases/latest/download/install-release.ps1 | iex
```

The installer script downloads the official x64 installer from this repository and verifies its SHA-256 checksum before launching it.

## Updates and Releases

Aether uses Tauri's official updater infrastructure. Production updater configuration requires a public signing key and an HTTPS GitHub Releases endpoint. Private signing keys must remain in GitHub Actions secrets. The current application version is **1.1.0**.

The updater endpoint is:

```text
https://github.com/96Watts/Aether/releases/latest/download/latest.json
```

The application checks this endpoint asynchronously. When a signed release is available, Settings > About can download and install it, then relaunch Aether. The first release must be published before automatic updates can operate.

Prepare a semantic-version release with:

```powershell
pnpm release:prepare
```

This analyzes Git history, selects a PATCH, MINOR, or MAJOR bump, synchronizes the version into `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, and does not tag or publish automatically.

The release workflow is located at `.github/workflows/release.yml`.

Before the first release, configure these GitHub repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `TAURI_SIGNING_PUBLIC_KEY`

## Current Limitations

Current limitations include:

- Only Ollama and OpenAI-compatible APIs are supported. Other provider protocols are not supported yet.
- Attachments, model downloading, and runtime installation are not implemented.
- LM Studio and standalone GGUF/llama.cpp runtimes can be detected, but are not connected to chat inference.
- Full Markdown rendering, vision, tool calling, and some advanced model parameters are not implemented.
- Telemetry and analytics are not implemented.
- Automatic updates require a published signed release.
- The current release targets Windows x64 only.

The app's feedback controls are currently local UI state and are not submitted to a service.

## License

No license has been selected for Aether yet. The repository currently contains no `LICENSE`, `COPYING`, or equivalent license file. Until a license is added, do not assume that the source code may be reused, modified, or redistributed.

## Technology

- **React** and **TypeScript** for the user interface
- **Vite** for frontend development and bundling
- **Tauri 2** for the desktop shell and native integration
- **Rust** for persistence, runtime discovery, AI requests, credential storage, and system integration
- **Ollama** and OpenAI-compatible APIs for model access
