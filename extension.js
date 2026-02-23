const vscode = require('vscode');

// ============================================================
// YoloMode v2.3.0 -- Auto-accept for Antigravity
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
let logLineCount = 0;
const MAX_LOG_LINES = 1000;
let commandsVerified = false;
let windowFocused = true;
let lastAcceptTime = 0;          // #11: adaptive heartbeat
let lastTickTime = Date.now();    // #10: sleep/lock detection
let sleepCheckInterval;          // #10: drift check timer
let isAccepting = false;         // #5: re-entrancy guard

// Accept commands discovered via keybinding analysis + cockpit retry (#12)
const ACCEPT_COMMANDS = [
    { id: 'antigravity.agent.acceptAgentStep', label: 'AgentStep', focusRetry: 'agentPanel' },
    { id: 'antigravity.terminalCommand.accept', label: 'TerminalCmd', focusRetry: 'terminal' },
    { id: 'antigravity.command.accept', label: 'EditorCmd' },
    { id: 'antigravity.prioritized.agentAcceptAllInFile', label: 'AcceptAllInFile' },
    { id: 'antigravity.prioritized.agentAcceptFocusedHunk', label: 'FocusedHunk' },
];

// Agent panel focus commands to try (#1/#9)
const AGENT_FOCUS_COMMANDS = [
    'antigravity.toggleChatFocus',
    'antigravity.agentSidePanelInputBox',
    'antigravity.sidecar.v1.OpenAgentManagerEvent',
];

// --- Config helper ---
function cfg(key) {
    return vscode.workspace.getConfiguration('ag-auto-accept').get(key);
}

// --- Logging with cap (#19) ---
function log(msg) {
    if (logLineCount >= MAX_LOG_LINES) {
        outputChannel.clear();
        logLineCount = 0;
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Log cleared (exceeded ${MAX_LOG_LINES} lines)`);
        logLineCount++;
    }
    outputChannel.appendLine(msg);
    logLineCount++;
}

// --- Focus-retry helpers (#23: terminal, #1/#9: agent panel) ---
// IMPORTANT: Only called during IDLE/SLOW state to prevent focus flickering
async function tryWithTerminalFocus(cmdId) {
    try {
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
        await vscode.commands.executeCommand(cmdId);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        return true;
    } catch (_) {
        return false;
    }
}

async function tryWithAgentPanelFocus(cmdId) {
    for (const focusCmd of AGENT_FOCUS_COMMANDS) {
        try {
            await vscode.commands.executeCommand(focusCmd);
            await vscode.commands.executeCommand(cmdId);
            return true;
        } catch (_) {
            // This focus command didn't help, try next
        }
    }
    return false;
}

// --- Core accept logic (#2/#15: loop until exhausted) ---
async function tryAcceptAll() {
    if (!enabled || isAccepting) return; // #5: re-entrancy guard
    isAccepting = true;

    try {
        // Only attempt focus tricks in IDLE/SLOW to prevent flickering (#3)
        const shouldTryFocus = (currentState === State.IDLE || currentState === State.SLOW);
        let pass = 0;
        let anySuccess = true;
        while (anySuccess && pass < 10) {
            anySuccess = false;
            pass++;
            for (const cmd of ACCEPT_COMMANDS) {
                if (cmd.configKey && !cfg(cmd.configKey)) continue;
                let accepted = false;
                try {
                    await vscode.commands.executeCommand(cmd.id);
                    accepted = true;
                } catch (_) {
                    // First attempt failed -- try focus-retry only in IDLE/SLOW
                    if (shouldTryFocus && cmd.focusRetry === 'terminal') {
                        accepted = await tryWithTerminalFocus(cmd.id);
                    } else if (shouldTryFocus && cmd.focusRetry === 'agentPanel') {
                        accepted = await tryWithAgentPanelFocus(cmd.id);
                    }
                }
                if (accepted) {
                    if (!successCounters[cmd.id]) successCounters[cmd.id] = 0;
                    successCounters[cmd.id]++;
                    totalAccepts++;
                    lastAcceptTime = Date.now(); // #11: track for adaptive heartbeat
                    anySuccess = true;

                    if (successCounters[cmd.id] % 5 === 1) {
                        log(
                            `[${new Date().toLocaleTimeString()}] Accepted: ${cmd.label} (cmd total: ${successCounters[cmd.id]}, grand total: ${totalAccepts})`
                        );
                    }

                    if (currentState === State.FAST) {
                        resetFastTimeout();
                    } else {
                        transitionTo(State.FAST, cmd.label + '.accepted');
                    }
                }
            }
        }
        if (pass > 1) {
            log(`[${new Date().toLocaleTimeString()}] Multi-pass accept: ${pass} passes`);
        }
    } catch (err) {
        // #17: Top-level error recovery
        log(`[${new Date().toLocaleTimeString()}] ERROR in tryAcceptAll: ${err.message}`);
    } finally {
        isAccepting = false;
    }
}

// --- State machine ---
function transitionTo(newState, trigger) {
    const prev = currentState;
    clearStatefulTimers(); // Only clears FAST/SLOW interval+timeout, NOT heartbeat
    currentState = newState;

    if (prev !== newState) {
        log(
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
    stopHeartbeat();
    if (textChangeTimer !== undefined) { clearTimeout(textChangeTimer); textChangeTimer = undefined; }
    if (sleepCheckInterval !== undefined) { clearInterval(sleepCheckInterval); sleepCheckInterval = undefined; }
}

// --- Heartbeat: always-on baseline poll for Agent Manager ---
// #11: Adaptive speed — 1s if recently active, normal interval otherwise
let adaptiveHeartbeatInterval;

function startHeartbeat() {
    stopHeartbeat();
    const baseInterval = cfg('heartbeatIntervalMs');
    if (baseInterval > 0) {
        heartbeatInterval = setInterval(() => {
            if (!enabled) return;
            if (currentState === State.IDLE || currentState === State.SLOW) {
                tryAcceptAll();
            }
        }, baseInterval);

        // #11: Adaptive fast heartbeat for recently-active sessions
        adaptiveHeartbeatInterval = setInterval(() => {
            if (!enabled) return;
            const recentlyActive = (Date.now() - lastAcceptTime) < 120000;
            if (recentlyActive && (currentState === State.IDLE || currentState === State.SLOW)) {
                tryAcceptAll();
            }
        }, 1000);

        log('[' + new Date().toLocaleTimeString() + '] Heartbeat started (' + baseInterval + 'ms)');
    }
}

function stopHeartbeat() {
    if (heartbeatInterval !== undefined) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
    }
    if (adaptiveHeartbeatInterval !== undefined) {
        clearInterval(adaptiveHeartbeatInterval);
        adaptiveHeartbeatInterval = undefined;
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

        // Window focus -- trigger on gain, detect background (#6/#7)
        vscode.window.onDidChangeWindowState((e) => {
            if (e.focused !== windowFocused) {
                windowFocused = e.focused;
                if (e.focused) {
                    log(`[${new Date().toLocaleTimeString()}] Window focused (timers restored)`);
                    if (enabled) transitionTo(State.FAST, 'windowFocused');
                } else {
                    log(`[${new Date().toLocaleTimeString()}] Window backgrounded (timers may be throttled)`);
                }
            }
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
                log(`[${new Date().toLocaleTimeString()}] Configuration changed`);

                // Handle enabled toggle via settings
                const newEnabled = cfg('enabled');
                if (newEnabled !== enabled) {
                    try {
                        vscode.commands.executeCommand('ag-auto-accept.toggle');
                    } catch (_) { }
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

// --- Command verification (#5/#20) ---
async function verifyCommands() {
    try {
        const allCommands = await vscode.commands.getCommands(true);
        const commandSet = new Set(allCommands);
        let found = 0;
        for (const cmd of ACCEPT_COMMANDS) {
            if (commandSet.has(cmd.id)) {
                found++;
            } else {
                log(`[${new Date().toLocaleTimeString()}] WARNING: Command not found: ${cmd.id}`);
            }
        }
        commandsVerified = true;
        log(`[${new Date().toLocaleTimeString()}] Verified ${found}/${ACCEPT_COMMANDS.length} commands available`);
        if (found === 0) {
            log(`[${new Date().toLocaleTimeString()}] WARNING: No Antigravity accept commands found. Is this Antigravity IDE?`);
        }
    } catch (err) {
        log(`[${new Date().toLocaleTimeString()}] Command verification failed: ${err.message}`);
    }
}

// --- Conflicting extension detection (#21) ---
function checkConflictingExtensions() {
    const competitors = [
        'pesosz.antigravity-auto-accept',
        'MunKhin.auto-accept-agent',
    ];
    for (const id of competitors) {
        const ext = vscode.extensions.getExtension(id);
        if (ext) {
            const name = ext.packageJSON.displayName || id;
            log(`[${new Date().toLocaleTimeString()}] WARNING: Conflicting extension detected: ${name}`);
            vscode.window.showWarningMessage(
                `YoloMode: "${name}" is also installed and may conflict. Consider disabling it.`
            );
        }
    }
}

// --- Sleep/lock recovery (#10) ---
function startSleepDetection() {
    if (sleepCheckInterval !== undefined) clearInterval(sleepCheckInterval);
    lastTickTime = Date.now();
    sleepCheckInterval = setInterval(() => {
        const now = Date.now();
        const drift = now - lastTickTime;
        if (drift > 10000) {
            log(`[${new Date().toLocaleTimeString()}] Sleep/lock detected (drift: ${drift}ms) - restarting`);
            if (enabled) transitionTo(State.FAST, 'sleepRecovery');
        }
        lastTickTime = now;
    }, 5000);
}

// --- Activation ---
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('YoloMode');
    log('=== YoloMode v2.3.0 activated ===');
    log(`Time: ${new Date().toLocaleString()}`);

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
    statusBarItem.command = 'ag-auto-accept.toggle';
    context.subscriptions.push(statusBarItem);

    // Toggle command
    context.subscriptions.push(
        vscode.commands.registerCommand('ag-auto-accept.toggle', () => {
            enabled = !enabled;
            if (enabled) {
                log(`[${new Date().toLocaleTimeString()}] === ENABLED ===`);
                registerEventListeners();
                startHeartbeat();
                transitionTo(State.FAST, 'toggle');
                vscode.window.showInformationMessage('YoloMode: ON');
            } else {
                log(`[${new Date().toLocaleTimeString()}] === DISABLED ===`);
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
            log(`[${new Date().toLocaleTimeString()}] Force accept triggered`);
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
        startSleepDetection(); // #10
        checkConflictingExtensions(); // #21
        // Delayed start (#5): wait 3s for Antigravity commands to register
        setTimeout(() => {
            verifyCommands();
            transitionTo(State.FAST, 'activate');
        }, 3000);
        updateStatusBar('$(clock) YOLO', undefined); // show IDLE while waiting
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
