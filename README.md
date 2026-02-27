# ⚡ YoloMode

**Stop clicking Accept. Let the AI work.**

YoloMode auto-accepts everything in Google Antigravity — agent steps, 
terminal commands, code edits. Install it and never think about it again.

## Get started

1. Open Extensions (Ctrl+Shift+X)
2. Search **YoloMode**
3. Install

That's it. YoloMode is already running.

## CDP mode (v3)

YoloMode v3 uses **Chrome DevTools Protocol** to accept agent steps 
directly in the side panel — no more missed accepts.

**First-time setup is automatic:**
1. On first activation, YoloMode adds `remote-debugging-port` to your `argv.json`
2. You'll see a one-time "Restart Now" notification
3. After restart, CDP is active — zero configuration needed

To disable CDP mode: set `ag-auto-accept.enableCDP` to `false` in settings.
To change the port: set `ag-auto-accept.cdpPort` (default: `9222`).

## First launch

When Antigravity starts, it may open a default chat that isn't your 
working conversation. Before YoloMode can accept for you:

1. Open the chat sidebar in the IDE
2. Switch to the conversation you're working in
3. YoloMode now targets that conversation

You only need to do this once per session. After switching, you can 
use Agent Manager, minimize the IDE, or work in other apps — YoloMode 
stays locked to your active conversation.

## Works best with

Set these in Antigravity Settings for a fully autonomous workflow:

| Setting | Value |
|---------|-------|
| cascadeAutoExecutionPolicy | Turbo |
| browserJsExecutionPolicy | Turbo |
| artifactReviewMode | Turbo |

## Runs in the background

Add these to `argv.json` to keep YoloMode active even when minimized:

**Windows:** `%USERPROFILE%\.antigravity\argv.json`  
**Mac/Linux:** `~/.antigravity/argv.json`
```json
{
  "disable-background-timer-throttling": true,
  "disable-backgrounding-occluded-windows": true,
  "disable-renderer-backgrounding": true
}
```

Restart the IDE after saving.

<details>
<summary>Advanced</summary>

**Toggle:** Ctrl+Alt+Shift+A · **Force accept:** Ctrl+Alt+Shift+Y

All settings under `ag-auto-accept.*` in settings.json.
Everything works out of the box — no configuration needed.

**One conversation at a time.** YoloMode accepts on whichever 
conversation is active in the IDE sidebar. To switch, click 
the conversation in the sidebar. Multi-conversation support is 
a known Antigravity platform limitation.

</details>

[Report an issue](https://github.com/mrkeles61/YoloMode/issues) · MIT License
