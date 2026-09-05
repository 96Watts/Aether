# Aether

**A modern Windows desktop AI workspace for local and cloud-based models.**

Aether is a focused desktop AI client built with **React, TypeScript, Vite, Tauri 2, and Rust**. It connects to local Ollama models and supported OpenAI-compatible services while keeping application state and conversations on the user's computer.

> Aether is the user-facing name. The internal Tauri application identifier is `aiinterface`.

> **[Visit the Aether website →](https://96watts.github.io/Aethers/)**<br>
> Download Aether, view installation options, and learn more about the workspace.

## Features

- Use local Ollama models or cloud-based AI services
- Discover local runtimes and installed models
- Connect to OpenAI, OpenRouter, and custom OpenAI-compatible APIs
- Keep conversations and settings stored locally
- Store provider credentials securely through Windows Credential Manager
- Install signed updates from GitHub Releases

## AI Providers

### Ollama

Aether connects to an Ollama service running at `http://127.0.0.1:11434`. Local models support streaming, cancellation, and provider-supplied reasoning output.

Ollama and the desired models must be installed and running separately. Aether does not install Ollama or download models.

### OpenAI and OpenRouter

Aether supports OpenAI and OpenRouter through their OpenAI-compatible APIs. An API key is required for each service.

### Custom OpenAI-Compatible APIs

Other services can be configured when they implement the OpenAI model-list and chat-completions APIs. Provider protocols that use a different API format are not supported yet.

## Privacy and Data

Aether is designed for local-first use:

- Conversations and settings are stored locally as JSON files.
- Provider API keys are stored through the Windows Credential Manager.
- Aether does not operate a remote conversation database or analytics backend.

When a cloud provider is selected, prompts and conversation context are sent to that provider according to its policies. Local Ollama conversations can remain on the computer.

Local conversation and settings files are readable by users with access to the computer. Aether does not encrypt these files.

## Windows Support

The application currently targets **Windows x64**. The recommended distribution is the Tauri NSIS installer:

```text
Aether_1.1.0_x64-setup.exe
```

Released users do not need Node.js, pnpm, Rust, Cargo, Visual Studio, or a development environment. Aether is distributed with its native runtime and application assets.

There is currently no published macOS, Linux, ARM64, or mobile release workflow.

## Installation

After a release is published, download the latest installer from the [Aether GitHub Releases](https://github.com/96Watts/Aether/releases) page and run `Aether_<version>_x64-setup.exe`.

The repository does not currently have a published release. The download links and installer command will become active after the first signed release is created.

Once `install-release.ps1` is published, install the latest release from Windows PowerShell with:

```powershell
irm https://github.com/96Watts/Aether/releases/latest/download/install-release.ps1 | iex
```

The installer downloads the official x64 installer over HTTPS and verifies its SHA-256 checksum before launching it.

## Aether Website

The public website is maintained separately from the application source:

**[96watts.github.io/Aethers](https://96watts.github.io/Aethers/)**

It contains the Aether overview, Windows download link, PowerShell installation command, privacy information, and supported installation options.

## Updates and Releases

Aether uses Tauri's official signed updater. The application checks this endpoint asynchronously:

```text
https://github.com/96Watts/Aether/releases/latest/download/latest.json
```

When a signed update is available, Settings > About can install it and relaunch Aether. Automatic updates require a published release and configured signing secrets.

Current application version: **1.1.0**

Before the first release, configure these GitHub Actions repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `TAURI_SIGNING_PUBLIC_KEY`

Prepare a semantic-version release locally:

```powershell
pnpm release:prepare
```

This analyzes Git history, chooses a PATCH, MINOR, or MAJOR bump, synchronizes the version across the project, and does not tag or publish automatically.

After reviewing and committing the changes, publish a release tag:

```powershell
git tag v<version>
git push origin v<version>
```

For the current version, the first release command is:

```powershell
git tag v1.1.0
git push origin v1.1.0
```

The workflow at `.github/workflows/release.yml` builds the signed Windows NSIS installer and publishes the updater metadata and release assets to [GitHub Releases](https://github.com/96Watts/Aether/releases).

## Current Limitations

- Only Ollama and OpenAI-compatible APIs are supported. Other provider protocols are not supported yet.
- Attachments, model downloading, and runtime installation are not implemented.
- LM Studio and standalone GGUF/llama.cpp runtimes can be detected, but are not connected to chat inference.
- Full Markdown rendering, vision, tool calling, and some advanced model parameters are not implemented.
- Telemetry and analytics are not implemented.
- Automatic updates require a published signed release.
- The current release targets Windows x64 only.

Feedback controls currently remain local UI state and are not submitted to a service.

## License

Aether currently has **no selected license**. The repository contains no `LICENSE`, `COPYING`, or equivalent license file. Until a license is added, do not assume that the source code may be reused, modified, or redistributed.

## Technology

- **React** and **TypeScript** for the user interface
- **Vite** for frontend development and bundling
- **Tauri 2** for the desktop application shell
- **Rust** for persistence, runtime discovery, AI requests, credential storage, and system integration
- **Ollama** and OpenAI-compatible APIs for model access
