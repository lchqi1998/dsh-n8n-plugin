<div align="center">

# dsh-n8n-plugin

<p align="center"><strong>n8n workflow operations, built into DeepSeek Harness.</strong><br>Register each n8n instance once — then drive it from the Settings page or straight from the agent.</p>

<p align="center">
  <a href="https://github.com/lchqi1998/dsh-n8n-plugin"><img alt="GitHub stars" src="https://img.shields.io/github/stars/lchqi1998/dsh-n8n-plugin?style=flat&logo=github&color=FFD700&label=stars"></a>
  <a href="https://github.com/lchqi1998/dsh-n8n-plugin/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors-anon/lchqi1998/dsh-n8n-plugin?style=flat&logo=github&color=0969DA&label=contributors"></a>
  <a href="https://www.npmjs.com/package/dsh-n8n-plugin"><img alt="npm package" src="https://img.shields.io/npm/v/dsh-n8n-plugin?style=flat&logo=npm&color=CB3837&label=npm"></a>
  <a href="https://npmmirror.com/package/dsh-n8n-plugin"><img alt="npmmirror weekly downloads" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.npmmirror.com%2Fdownloads%2Fpoint%2Flast-week%2Fdsh-n8n-plugin&query=%24.downloads&style=flat&logo=npm&color=CB3837&label=npmmirror%20weekly&cacheSeconds=3600"></a>
  <a href="https://socket.dev/npm/package/dsh-n8n-plugin"><img alt="Socket score" src="https://badge.socket.dev/npm/package/dsh-n8n-plugin"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%5E22.19_%7C%7C_%3E%3D24-339933?logo=nodedotjs">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-2563EB">
  <img alt="n8n" src="https://img.shields.io/badge/n8n-API_v1-EA4B71?logo=n8n">
  <img alt="agent tools" src="https://img.shields.io/badge/agent_tools-15-8A5CF6">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-3DA639">
</p>

English · [中文](README.zh.md)

</div>

---

<div align="center">
  <img src="icon.svg" alt="dsh-n8n-plugin logo" width="128">
</div>

## ✨ Why dsh-n8n-plugin

Most n8n integrations have you paste a base URL and an API key into every conversation. This plugin makes n8n a **first-class citizen of DeepSeek Harness**: one settings page, one instance registry, and 15 agent tools that share it.

### One alias away from any environment
Instances are registered once under **Settings → n8n instances** — an alias (`prod`, `staging`, `local`, …), a base URL and an API key. Every tool call picks its target by alias, so the same instruction works against any environment without repeating credentials.

### One registry, two surfaces, zero drift
The Settings page and the agent tools read **one and the same store** — what you configure in the GUI is exactly what the agent sees. The split of duties is deliberate: agents can **list** instances but can never create or edit one, because an API key must not be dictated through a conversation.

### Validate offline, publish with confidence
`n8n_workflow_validate` checks the full workflow document before anything is sent — unique node ids and names (connections are keyed by name), connection targets that actually exist, webhook nodes paired with their `Respond to Webhook` responder, a recommended `settings.executionOrder` — all without contacting the instance.

### Keys never leave this machine
API keys live only in `~/.dsh/dsh-n8n-plugin.json` with `0600` permissions. Every response masks them to the last four characters, and the Settings page never echoes a full key back.

### Built for n8n's moving API
Publishing uses the modern `POST /workflows/{id}/publish` and falls back to the legacy `activate` only on a 404. Version differences beyond that are one raw `n8n_api` call away.

## 🧩 Agent tools

15 tools, every one of them alias-addressed:

| Tool | Purpose |
| --- | --- |
| `n8n_instances` | List instances (alias, URL, masked key, default). Agents cannot create or edit instances |
| `n8n_workflows` | List workflows (filter by active / name / tags; cursor pagination) |
| `n8n_workflow_get` | Read a full workflow document |
| `n8n_workflow_create` | Create from JSON, optionally publishing immediately |
| `n8n_workflow_update` | Replace a workflow document, optionally changing its published state |
| `n8n_workflow_delete` | Delete a workflow (its triggers stop) |
| `n8n_workflow_publish` | Publish (activate) / unpublish (deactivate) |
| `n8n_workflow_validate` | Offline JSON validation, no instance contacted |
| `n8n_executions` | List executions (filter by workflow id / status) |
| `n8n_execution_get` | Read one execution as a structured view: status, duration, per-node results and error summaries |
| `n8n_wait_execution` | Poll one execution until it settles (configurable timeout and interval) |
| `n8n_webhook_call` | Run a workflow on demand through its Webhook trigger; waits for completion by default and returns per-node results |
| `n8n_tags` | List tags and their ids |
| `n8n_credentials` | List credential names and types (never secret values) |
| `n8n_api` | Raw `/api/v1` request (path starts with `/`) |

The workflow-JSON reference and ready-made patterns live in [`knowledge/workflow-guide.md`](knowledge/workflow-guide.md). With `announceToAgent` on, the prompt names that file's absolute path so the agent can read it on demand. Tool descriptions and user-facing messages are written in Chinese; tool names, parameter names and n8n protocol vocabulary (field names, node types, status enums) intentionally stay in English.

## 🖥️ Instance management

**Settings → n8n instances → Add instance**:

| Field | Meaning |
| --- | --- |
| Alias | Starts with a letter or digit; letters, digits, `.`, `_`, `-` only; at most 64 chars. The target identifier for every tool |
| Base URL | `https://n8n.example.com`, `http://localhost:5678`, optionally with a sub-path; a trailing `/api/v1` may be included and is normalized away |
| API key | Create it in n8n under **Settings → n8n API**. When editing, leave blank to keep the stored key |
| Description | Optional note |
| Default | The instance new work defaults to; only one exists, and deleting it promotes the first remaining entry |

The **Test** button calls `GET /workflows?limit=1` on the spot and reports latency — or the exact failure: connection refused, DNS, timeout, TLS, 401.

All instance data lives in one file:

```
~/.dsh/dsh-n8n-plugin.json     # $DSH_HOME/dsh-n8n-plugin.json — file 0600 / directory 0700
```

Writes are atomic (temp file + rename); a corrupted file is quarantined as `.corrupt-<timestamp>` instead of taking the plugin down.

## 🚀 Quick start

```sh
# By package name, from npm or a compatible registry
dsh plugin --profile web add dsh-n8n-plugin

# Into the desktop profile (the desktop build ships its own CLI; use it when `dsh` is not on PATH)
dsh plugin --profile desktop add dsh-n8n-plugin

# From a local tarball or source directory (development / air-gapped)
dsh plugin --profile web add ./dsh-n8n-plugin-0.1.0.tgz
dsh plugin --profile web add link:<path-to-this-package>
```

Restart `dsh web` or the desktop app afterwards; a **n8n instances** section appears in Settings. Nothing else to set up — you only need an n8n instance with an API key.

### Manual install (without `dsh plugin`)

1. Place the package at `<DSH_HOME>/profiles/<profile>/node_modules/dsh-n8n-plugin` (`DSH_HOME` defaults to `~/.dsh`) — unzip the tarball or copy the directory.
2. Add the plugin row to that profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: n8n
         name: 'dsh-n8n-plugin'
   ```

3. Restart the app.

The bundled `cordis.patch.yml` is the package-level patch used when the package is listed in `dsh.profile.bundles`; inserting the row directly into the profile is the simpler path.

## ⚙️ How it works

A standard double-sided DSH package: a host half (`lib/`) and a browser half (`client/index.js`, no build step).

```
Settings page (browser)                        Agent (model)
  │                                              │
  ├─ GET/POST/PATCH/DELETE ───┐                  ├─ 15 × n8n_* tools
  │  /api/dsh-n8n-plugin/*    │                  │
  ▼                           ▼                  ▼
┌───────────── loopback fence (127.0.0.1 / ::1 only) ─────────────┐
│    lib/routes.js                        lib/tools.js            │
│            └───────────────┬──────────────────┘                 │
│                      lib/store.js             lib/n8n.js        │
│     ~/.dsh/dsh-n8n-plugin.json         n8n REST API v1          │
└──────────────────────────────────────────────────────────────────┘
```

- **Host half** — `lib/index.js` registers routes, the 15 tools and the optional prompt section from one `apply()`; `lib/store.js` owns the registry (atomic writes, `0600`, corrupt-file quarantine); `lib/n8n.js` is the API v1 client (30 s timeout, merged abort signals, `accept-encoding: identity`) plus a direct webhook caller and an execution wait poller; `lib/http.js` enforces the loopback fence; `lib/mount-once.js` guarantees one mount per package and profile.
- **Browser half** — `client/index.js` renders the Settings section and talks to the same routes, so GUI and agent always agree.
- **Prompt guidance** — `lib/guidance.js` emits the system-prompt section; it renders only when n8n_* tools are visible in the session.

## ⚙️ Configuration

Two boolean flags live in the plugin's `config` inside the profile patch. Both are `volatile()`: an edit reaches the running instance **without a restart** — the loader announces the change and the plugin re-registers its surfaces in place.

```yaml
- id: n8n
  name: 'dsh-n8n-plugin'
  config:
    enabled: true          # master switch: routes, tools, prompt section
    announceToAgent: true  # inject the guidance into the agent prompt
```

## 🛡️ Security model

- `/api/dsh-n8n-plugin/*` accepts loopback requests only, validating the socket address, `Host`, `Origin` and `Sec-Fetch-Site`; any request carrying `X-Forwarded-For` / `CF-Connecting-IP` is refused. Never expose this page through a reverse proxy.
- Request bodies are capped at 256 KiB, and responses are sent `no-store`.
- API keys are plaintext in a `0600` user-owned file — the same trust model as `~/.n8n` or a `n8n-api.sh` environment file. Responses only carry the last four characters.
- Agents can read the instance list but cannot create or edit an instance: an API key must not be dictated through a conversation.
- An n8n API key carries that instance's API authority. Register trustworthy instances only, rotate keys, and prefer a dedicated automation user.
- Publishing immediately affects production webhook and schedule triggers; deleting a workflow stops its triggers; execution data can contain business-sensitive payloads. The injected guidance requires the agent to confirm these operations with the user first.

## 🛠 Development

Requires Node.js `^22.19.0 || >=24`.

```sh
npm run check             # syntax check over every source file
```

Layout:

```
lib/index.js             plugin entry (Config, apply, route/tool/prompt registration)
lib/store.js             instance store (atomic write, 0600, corrupt-file quarantine)
lib/n8n.js               n8n public API v1 client (+ direct webhook call, execution wait)
lib/routes.js            /api/dsh-n8n-plugin routes (loopback fence)
lib/tool-specs.js        15 agent tool definitions (parameters, output schema, render, execute)
lib/tools.js             the only defineTool() adapter over those definitions
lib/render.js            pure model-facing formatters used by the render hooks
lib/workflow-validate.js offline workflow validation
lib/http.js              JSON helpers + loopback fence
lib/mount-once.js        single-mount guard (one mount per package and profile)
lib/guidance.js          system-prompt text
client/index.js          browser half (settings section, no build step)
knowledge/               workflow-JSON reference
```

## 📦 Publishing

```sh
npm pack                 # writes dsh-n8n-plugin-0.1.0.tgz (lib/, client/, knowledge/, cordis.patch.yml, icon.svg, both READMEs)
npm publish              # publishes to the default registry once you are logged in
```

> The package name appears in three places at once — `package.json`, the cordis row in `cordis.patch.yml`, and the browser module id in `client/index.js`. If you publish under your own scope, update all three together.

## 🔐 Permissions & compatibility

- **Permissions**: writes one JSON file under the harness home (`~/.dsh` / `$DSH_HOME`); makes outbound HTTP(S) calls to the registered n8n instances; serves a loopback-only route family through the host's web server. **No** command execution, no shell.
- **Compatibility**: DSH `>= 0.2.1-rc.2` (declared as both `engines.dsh` and `dsh.engines.dsh`), Node.js `^22.19.0 || >=24`, n8n public API v1 (1.x and later; publishing has a modern/legacy fallback).
- **Lifecycle**: no `preinstall` / `install` / `postinstall` scripts — install and use.
- **Dependency posture**: the only runtime dependency is `@deepseek-ai/schemastery`; every `@deepseek-ai/dsh-*` package and `react` are optional peer dependencies — the plugin never re-installs, replaces or shadows official components.

## 🤖 Model experience

- 15 `n8n_*` tools (table above); `n8n_instances` and `n8n_workflow_validate` are the safe, read-mostly entry points.
- A run loop in one chain: `n8n_workflow_publish` → `n8n_webhook_call` (trigger + wait) → `n8n_execution_get` to re-inspect — deploy, run, verify.
- An optional system-prompt section (`announceToAgent`) teaches the alias convention and points at `knowledge/workflow-guide.md` for the full workflow-JSON rules.
- Destructive operations (publish, delete) are gated by an explicit confirm-with-the-user-first rule in the guidance.

## ⚠️ Known limitations

- The n8n public API still has no cross-version stable "run workflow manually" endpoint; `n8n_webhook_call` fills that gap through the Webhook trigger — the workflow needs a Webhook node and must be published (or use `mode:"test"` while the editor listens for test events). Workflows without a Webhook trigger must be run in the n8n UI, then inspected with `n8n_executions` / `n8n_execution_get`.
- Public-API endpoints and fields differ across n8n versions (for example `publish/unpublish` alongside `activate/deactivate`, and updates that may want a `versionId`). The plugin falls back on a 404 for publishing; other differences are reachable through `n8n_api`.
- A self-signed instance certificate is rejected by the DSH host's TLS validation; give the instance a trusted certificate or use internal HTTP.
- One mount per profile: the built-in single-instance guard deduplicates a second row for the same package.

## 📄 License

[MIT](LICENSE)
