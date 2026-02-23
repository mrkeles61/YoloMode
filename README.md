# ⚡ YoloMode

**Stop clicking Accept. Let the AI work.**

YoloMode auto-accepts everything in Google Antigravity — agent steps, 
terminal commands, code edits. Install it and never think about it again.

## Get started

1. Open Extensions (Ctrl+Shift+X)
2. Search **YoloMode**
3. Install

That's it. YoloMode is already running.

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

---

<details>
<summary>Advanced</summary>

**Toggle:** Ctrl+Alt+Shift+A · **Force accept:** Ctrl+Alt+Shift+Y

All settings under `ag-auto-accept.*` in settings.json. 
Everything works out of the box — no configuration needed.

</details>

[Report an issue](https://github.com/mrkeles61/YoloMode/issues) · MIT License
