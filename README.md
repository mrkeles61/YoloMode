# YoloMode

**Auto-accept everything in Google Antigravity IDE.**

Install it, forget it. Agent steps, terminal commands, code edits — 
all accepted automatically.

## Background mode (optional)

By default, auto-accept pauses when the IDE is minimized. It catches 
up instantly when you restore the window.

To keep it running while minimized, add these to your `argv.json` 
(`%USERPROFILE%\.antigravity\argv.json` on Windows, 
`~/.antigravity/argv.json` on Mac/Linux):
```json
{
  "disable-background-timer-throttling": true,
  "disable-backgrounding-occluded-windows": true,
  "disable-renderer-backgrounding": true
}
```

Restart the IDE after saving.

## Install

1. Open Antigravity → Extensions (Ctrl+Shift+X)
2. Search **YoloMode**
3. Install. Done.

## How to use

There's nothing to configure. YoloMode starts automatically.

The status bar shows the current state:

| Status | Meaning |
|--------|---------|
| ✅ **YOLO** | Actively accepting (agent is working) |
| 👁 **YOLO** | Watching (cooling down) |
| 🕐 **YOLO** | Idle (waiting for activity) |
| ❌ **YOLO** | Disabled |

**Toggle on/off:** `Ctrl+Alt+Shift+A` or click the status bar  
**Force accept now:** `Ctrl+Alt+Shift+Y`

## Recommended Antigravity settings

For full hands-free mode, also set these in Antigravity Settings:

- `cascadeAutoExecutionPolicy` → **Turbo**
- `browserJsExecutionPolicy` → **Turbo**  
- `artifactReviewMode` → **Turbo**

## Advanced settings

Most users won't need to change these. All settings are under 
`ag-auto-accept.*`:

<details>
<summary>Click to expand settings</summary>

| Setting | Default | Description |
|---------|---------|-------------|
| enabled | true | Global on/off |
| fastIntervalMs | 200 | Fast polling interval |
| slowIntervalMs | 2000 | Slow polling interval |
| heartbeatIntervalMs | 3000 | Background heartbeat interval |
| fastDurationMs | 10000 | Duration before slowing down |
| cooldownDurationMs | 30000 | Duration before going idle |
| enableTerminalAccept | true | Auto-accept terminal commands |
| enableAgentStepAccept | true | Auto-accept agent steps |
| enableEditorAccept | true | Auto-accept code edits |

</details>

## Known limitations

- Auto-accept pauses when minimized (see Background Mode above)
- Agent Manager must have the main IDE window open
- "Allow file access" prompts can't be automated — set 
  `allowAgentAccessNonWorkspaceFiles` to true in Antigravity settings

## License

MIT
