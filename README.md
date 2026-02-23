# YoloMode — Auto Accept for Antigravity

Stop clicking Accept. Let the AI work.

YoloMode automatically accepts agent steps, terminal commands, code edits, and diff hunks in Google Antigravity IDE. It uses a three-state polling system with an always-on heartbeat to catch every approval prompt with minimal CPU overhead.

## Features

- **Agent Step Auto-Accept** — accepts pending steps in the Agent Manager panel
- **Terminal Command Auto-Accept** — accepts terminal run command prompts
- **Code Edit Auto-Accept** — accepts editor code changes and diff hunks
- **Three-State Polling** — IDLE (heartbeat only) → FAST (200ms) → SLOW (2s) → IDLE
- **Always-On Heartbeat** — 3s background poll catches Agent Manager prompts even with no editor activity
- **Status Bar Toggle** — click to enable/disable
- **Force Accept** — manually trigger with Ctrl+Alt+Shift+Y
- **Output Logging** — full activity log in the "YoloMode" output channel

## Installation

**From Marketplace:**
1. Open Antigravity IDE → Extensions (Ctrl+Shift+X)
2. Search for **"YoloMode"**
3. Click Install

**From VSIX:**
1. Download the `.vsix` file from [Releases](https://github.com/erenk/yolomode/releases)
2. Extensions panel → `...` menu → Install from VSIX

## Usage

Once installed, YoloMode activates automatically. The status bar shows:

| Icon | State | Meaning |
|------|-------|---------|
| `$(check) YOLO` | ACTIVE | Fast-polling (200ms) — agent is working |
| `$(eye) YOLO` | WATCHING | Slow-polling (2s) — cooling down |
| `$(clock) YOLO` | IDLE | Heartbeat only — waiting for activity |
| `$(x) YOLO` | OFF | Disabled |

Click the status bar item or press **Ctrl+Alt+Shift+A** to toggle.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| YoloMode: Toggle | Ctrl+Alt+Shift+A | Enable/disable |
| YoloMode: Force Accept Now | Ctrl+Alt+Shift+Y | Trigger one accept round |
| YoloMode: Show Log | — | Open the output log |

## Settings

All settings are under `ag-auto-accept.*` in your settings.json:

| Setting | Default | Description |
|---------|---------|-------------|
| `ag-auto-accept.enabled` | `true` | Global enable/disable |
| `ag-auto-accept.fastIntervalMs` | `200` | Fast polling interval (ms) |
| `ag-auto-accept.slowIntervalMs` | `2000` | Slow polling interval (ms) |
| `ag-auto-accept.heartbeatIntervalMs` | `3000` | Heartbeat interval (ms), 0 to disable |
| `ag-auto-accept.fastDurationMs` | `10000` | Fast polling duration before cooldown |
| `ag-auto-accept.cooldownDurationMs` | `30000` | Cooldown duration before going idle |
| `ag-auto-accept.enableTerminalAccept` | `true` | Auto-accept terminal commands |
| `ag-auto-accept.enableAgentStepAccept` | `true` | Auto-accept agent steps |
| `ag-auto-accept.enableEditorAccept` | `true` | Auto-accept code edits |

## How It Works

YoloMode fires these Antigravity internal commands on a polling loop:

- `antigravity.agent.acceptAgentStep` — Agent panel steps
- `antigravity.terminalCommand.accept` — Terminal commands
- `antigravity.command.accept` — Editor code edits
- `antigravity.prioritized.agentAcceptAllInFile` — All edits in a file
- `antigravity.prioritized.agentAcceptFocusedHunk` — Individual diff hunks

Event-driven triggers (terminal open, editor change, file create, etc.) start fast polling. After 10s of no new accepts, it slows down. After 30s more, it goes idle. The heartbeat always runs in the background to catch Agent Manager prompts.

## Recommended Antigravity Settings

For the best hands-free experience alongside YoloMode, set these in Antigravity Settings (Ctrl+,):

| Setting | Value | What it does |
|---------|-------|-------------|
| `cascadeAutoExecutionPolicy` | Turbo | Auto-approve all agent actions |
| `browserJsExecutionPolicy` | Turbo | Auto-approve browser script execution |
| `artifactReviewMode` | Turbo | Auto-approve artifact reviews |

## Known Limitations

1. **Agent Manager standalone** — The extension requires the main Antigravity IDE window to be open. If you open Agent Manager without the IDE, extensions don't load. This is an Antigravity platform limitation. Workaround: open the IDE first.

2. **Browser script permissions** — Browser JS execution prompts are controlled by Antigravity's built-in `browserJsExecutionPolicy` setting, not by this extension. Set it to Turbo in Settings → Agent.

3. **"Allow file access" prompts** — The "Allow Once" / "Allow This Conversation" prompts in new conversations are webview-internal and cannot be automated by any extension. Workaround: set `allowAgentAccessNonWorkspaceFiles` to `true` in Antigravity settings.

## Contributing

Found a bug or have a feature request? [Open an issue](https://github.com/erenk/yolomode/issues).

## License

MIT
