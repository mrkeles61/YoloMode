# Changelog

## 3.0.0 (2026-02-27)

- **CDP mode**: Uses Chrome DevTools Protocol to click accept buttons directly in the agent side panel DOM
- **Auto-configuration**: Automatically adds `remote-debugging-port` to `argv.json` on first activation
- Hybrid approach: VS Code API commands + CDP fallback for maximum compatibility
- New settings: `ag-auto-accept.enableCDP`, `ag-auto-accept.cdpPort`
- WebSocket-based CDP connection with automatic reconnect
- CDP status shown in status bar tooltip
- Added `ws` dependency for WebSocket communication


## 2.0.0 (2026-02-20)

- Initial public release
- Three-state polling system (IDLE/FAST/SLOW) for minimal CPU usage
- Always-on heartbeat for Agent Manager support
- Five accept commands covering all Antigravity approval types
- Event-driven triggers with debounced text change detection
- Configurable polling intervals and cooldown durations
- Status bar toggle with visual state indicators
- Force accept command (Ctrl+Alt+Shift+Y)
- Output channel logging
