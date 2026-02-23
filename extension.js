const vscode = require('vscode');

// ============================================================
// YoloMode v2.0.0 -- Auto-accept for Antigravity
// Works in: Editor, Terminal, Agent Manager (standalone)
// Architecture: Three-state (IDLE/FAST/SLOW) + always-on heartbeat
// ============================================================

const State = { IDLE: 'IDLE', FAST: 'FAST', SLOW: 'SLOW' };

let outputChannel;
let statusBarItem;
let pollInterval;
let stateTimeout;
let heartbeatInterval;   // <-- Always-on baseline poll for Agent Manager
let currentState = State.IDLE;
let enabled = true;
let eventListeners = [];
let textChangeTimer;
const successCounters = {};
let totalAccepts = 0;

// The five Antigravity accept commands discovered via keybinding analysis
const ACCEPT_COMMANDS = [
    { id: 'antigravity.agent.acceptAgentStep', label: 'AgentStep' },
    { id: 'antigravity.terminalCommand.accept', label: 'TerminalCmd' },
    { id: 'antigravity.command.accept', label: 'EditorCmd' },
    { id: 'antigravity.prioritized.agentAcceptAllInFile', label: 'AcceptAllInFile' },
    { id: 'antigravity.prioritized.agentAcceptFocusedHunk', label: 'FocusedHunk' },
];

// --- Config helper ---
function cfg(key) {
    return vscode.workspace.getConfiguration('ag-auto-accept').get(key);
}

// --- Core accept logic ---
async function tryAcceptAll() {
    if (!enabled) return;

    for (const cmd of ACCEPT_COMMANDS) {
        if (cmd.configKey && !cfg(cmd.configKey)) continue;
        try {
            await vscode.commands.executeCommand(cmd.id);
            // Success -- something was actually accepted
            if (!successCounters[cmd.id]) successCounters[cmd.id] = 0;
            successCounters[cmd.id]++;
            totalAccepts++;

            // Log every 5th success per command to avoid spam
            if (successCounters[cmd.id] % 5 === 1) {
                outputChannel.appendLine(
                    `[${new Date().toLocaleTimeString()}] Accepted: ${cmd.label} (cmd total: ${successCounters[cmd.id]}, grand total: ${totalAccepts})`
                );
            }

            // Keep fast-polling since agent is actively producing work
            if (currentState === State.FAST) {
                resetFastTimeout();
            } else {
                transitionTo(State.FAST, cmd.label + '.accepted');
            }
        } catch (_) {
            // Nothing to accept -- this is expected and normal
        }
    }
}

// --- State machine ---
function transitionTo(newState, trigger) {
    const prev = currentState;
    clearStatefulTimers(); // Only clears FAST/SLOW interval+timeout, NOT heartbeat
    currentState = newState;

    if (prev !== newState) {
        outputChannel.appendLine(
            `[${new Date().toLocaleTimeString()}] State: ${prev} -> ${newState}${trigger ? ' (' + trigger + ')' : ''}`
        );
    }

    if (newState === State.FAST) {
        pollInterval = setInterval(tryAcceptAll, cfg('fastIntervalMs'));
        stateTimeout = setTimeout(
            () => transitionTo(State.SLOW, 'fastDurationExpired'),
            cfg('fastDurationMs')
        );
        updateStatusBar('$(check) YOLO', 'statusBarItem.warningBackground');
    } else if (newState === State.SLOW) {
        pollInterval = setInterval(tryAcceptAll, cfg('slowIntervalMs'));
        stateTimeout = setTimeout(
            () => transitionTo(State.IDLE, 'cooldownExpired'),
            cfg('cooldownDurationMs')
        );
        updateStatusBar('$(eye) YOLO', undefined);
    } else {
        // IDLE -- no fast/slow polling, but heartbeat continues
        updateStatusBar('$(clock) YOLO', undefined);
    }
}

function resetFastTimeout() {
    // Reset only the timeout that transitions FAST->SLOW
    // Does NOT recreate the interval (avoids timer thrashing)
    if (stateTimeout !== undefined) clearTimeout(stateTimeout);
    stateTimeout = setTimeout(
        () => transitionTo(State.SLOW, 'fastDurationExpired'),
        cfg('fastDurationMs')
    );
}

function clearStatefulTimers() {
    if (pollInterval !== undefined) { clearInterval(pollInterval); pollInterval = undefined; }
    if (stateTimeout !== undefined) { clearTimeout(stateTimeout); stateTimeout = undefined; }
    // NOTE: heartbeat is NOT cleared here -- it always runs
}

function clearAllTimers() {
    clearStatefulTimers();
    if (heartbeatInterval !== undefined) { clearInterval(heartbeatInterval); heartbeatInterval = undefined; }
    if (textChangeTimer !== undefined) { clearTimeout(textChangeTimer); textChangeTimer = undefined; }
}

// --- Heartbeat: always-on baseline poll for Agent Manager ---
// This is the KEY feature that makes it work when only Agent Manager is running.
// Even in IDLE state with no editor events firing, the heartbeat periodically
// tries to accept agent steps. This catches Agent Manager prompts that would
// otherwise be missed because no VS Code editor/terminal events fire.
function startHeartbeat() {
    stopHeartbeat();
    const interval = cfg('heartbeatIntervalMs');
    if (interval > 0) {
        heartbeatInterval = setInterval(() => {
            if (!enabled) return;
            // Only run heartbeat accept when NOT already fast-polling
            // (to avoid double-firing during FAST state)
            if (currentState === State.IDLE || currentState === State.SLOW) {
                tryAcceptAll();
            }
        }, interval);
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Heartbeat started (${interval}ms)`);
    }
}

function stopHeartbeat() {
    if (heartbeatInterval !== undefined) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
    }
}

// --- Status bar ---
function updateStatusBar(text, bgColor) {
    statusBarItem.text = text;
    statusBarItem.backgroundColor = bgColor
        ? new vscode.ThemeColor(bgColor)
        : undefined;
    statusBarItem.tooltip = `YoloMode -- ${currentState} | Total accepts: ${totalAccepts} | Click to toggle`;
    statusBarItem.show();
}

// --- Event listeners ---
function registerEventListeners() {
    disposeEventListeners();

    const trigger = (name) => () => {
        if (enabled) transitionTo(State.FAST, name);
    };

    eventListeners = [
        // Terminal events
        vscode.window.onDidChangeActiveTerminal(trigger('activeTerminalChanged')),
        vscode.window.onDidOpenTerminal(trigger('terminalOpened')),
        vscode.window.onDidCloseTerminal(trigger('terminalClosed')),

        // Editor events
        vscode.window.onDidChangeVisibleTextEditors(trigger('visibleEditorsChanged')),
        vscode.window.onDidChangeActiveTextEditor(trigger('activeEditorChanged')),

        // Window focus -- only trigger when gaining focus
        vscode.window.onDidChangeWindowState((e) => {
            if (enabled && e.focused) transitionTo(State.FAST, 'windowFocused');
        }),

        // Text document changes -- DEBOUNCED to prevent infinite loops
        // Only triggers transition if currently IDLE (already active states don't need reset)
        vscode.workspace.onDidChangeTextDocument(() => {
            if (!enabled) return;
            if (textChangeTimer) clearTimeout(textChangeTimer);
            textChangeTimer = setTimeout(() => {
                if (enabled && currentState === State.IDLE) {
                    transitionTo(State.FAST, 'textDocumentChanged');
                }
            }, 2000);
        }),

        // File system events
        vscode.workspace.onDidCreateFiles(trigger('filesCreated')),
        vscode.workspace.onDidSaveTextDocument(trigger('documentSaved')),

        // Task events
        vscode.tasks.onDidStartTask(trigger('taskStarted')),
        vscode.tasks.onDidEndTask(trigger('taskEnded')),

        // Debug events
        vscode.debug.onDidStartDebugSession(trigger('debugStarted')),

        // Settings changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ag-auto-accept')) {
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Configuration changed`);

                // Handle enabled toggle via settings
                const newEnabled = cfg('enabled');
                if (newEnabled !== enabled) {
                    vscode.commands.executeCommand('ag-auto-accept.toggle');
                }

                // Restart heartbeat if interval changed
                if (e.affectsConfiguration('ag-auto-accept.heartbeatIntervalMs')) {
                    startHeartbeat();
                }
            }
        }),
    ];
}

function disposeEventListeners() {
    for (const d of eventListeners) d.dispose();
    eventListeners = [];
}

// --- Activation ---
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('YoloMode');
    outputChannel.appendLine('=== YoloMode v2.0.0 activated ===');
    outputChannel.appendLine(`Time: ${new Date().toLocaleString()}`);

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
    statusBarItem.command = 'ag-auto-accept.toggle';
    context.subscriptions.push(statusBarItem);

    // Toggle command
    context.subscriptions.push(
        vscode.commands.registerCommand('ag-auto-accept.toggle', () => {
            enabled = !enabled;
            if (enabled) {
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] === ENABLED ===`);
                registerEventListeners();
                startHeartbeat();
                transitionTo(State.FAST, 'toggle');
                vscode.window.showInformationMessage('YoloMode: ON');
            } else {
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] === DISABLED ===`);
                clearAllTimers();
                disposeEventListeners();
                currentState = State.IDLE;
                updateStatusBar('$(x) YOLO', undefined);
                vscode.window.showInformationMessage('YoloMode: OFF');
            }
        })
    );

    // Force accept command -- manually trigger one round of accepts
    context.subscriptions.push(
        vscode.commands.registerCommand('ag-auto-accept.forceAccept', async () => {
            outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Force accept triggered`);
            await tryAcceptAll();
            vscode.window.showInformationMessage('YoloMode: Force accept executed');
        })
    );

    // Show log command
    context.subscriptions.push(
        vscode.commands.registerCommand('ag-auto-accept.showLog', () => {
            outputChannel.show();
        })
    );

    // Initialize
    enabled = cfg('enabled');
    if (enabled) {
        registerEventListeners();
        startHeartbeat();
        transitionTo(State.FAST, 'activate');
    } else {
        updateStatusBar('$(x) YOLO', undefined);
    }
}

function deactivate() {
    clearAllTimers();
    disposeEventListeners();
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
