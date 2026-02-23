const vscode = require('vscode');

// ============================================================
// YoloMode v2.5.1 -- Auto-accept for Antigravity
// Works in: Editor, Terminal, Agent Manager (standalone)
// Architecture: Event-driven three-state (IDLE/FAST/SLOW) + heartbeat
// ============================================================

const State = { IDLE: 'IDLE', FAST: 'FAST', SLOW: 'SLOW' };

let outputChannel;
let statusBarItem;
let pollInterval;
let stateTimeout;
let heartbeatInterval;
let currentState = State.IDLE;
let enabled = true;
let eventListeners = [];
let textChangeTimer;
let logLineCount = 0;
const MAX_LOG_LINES = 1000;
let commandsVerified = false;
let windowFocused = true;
let lastTickTime = Date.now();    // sleep/lock detection
let sleepCheckInterval;           // drift check timer
let isAccepting = false;          // re-entrancy guard

// Accept commands
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.command.accept',
    'antigravity.prioritized.agentAcceptAllInFile',
    'antigravity.prioritized.agentAcceptFocusedHunk',
];

// --- Config helper ---
function cfg(key) {
    return vscode.workspace.getConfiguration('ag-auto-accept').get(key);
}

// --- Logging with cap ---
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

// --- Core accept logic: fire-and-forget ---
async function tryAcceptAll() {
    if (!enabled || isAccepting) return;
    isAccepting = true;

    try {
        for (const cmdId of ACCEPT_COMMANDS) {
            try {
                await vscode.commands.executeCommand(cmdId);
            } catch (_) {
                // Command not available or failed — ignore
            }
        }
    } catch (err) {
        log(`[${new Date().toLocaleTimeString()}] ERROR in tryAcceptAll: ${err.message}`);
    } finally {
        isAccepting = false;
    }
}

// --- State machine (event-driven only) ---
function transitionTo(newState, trigger) {
    const prev = currentState;
    clearStatefulTimers();
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
        // IDLE — no fast/slow polling, heartbeat continues
        updateStatusBar('$(clock) YOLO', undefined);
    }
}

function clearStatefulTimers() {
    if (pollInterval !== undefined) { clearInterval(pollInterval); pollInterval = undefined; }
    if (stateTimeout !== undefined) { clearTimeout(stateTimeout); stateTimeout = undefined; }
}

function clearAllTimers() {
    clearStatefulTimers();
    stopHeartbeat();
    if (textChangeTimer !== undefined) { clearTimeout(textChangeTimer); textChangeTimer = undefined; }
    if (sleepCheckInterval !== undefined) { clearInterval(sleepCheckInterval); sleepCheckInterval = undefined; }
}

// --- Heartbeat: always-on baseline poll for Agent Manager ---
function startHeartbeat() {
    stopHeartbeat();
    const baseInterval = cfg('heartbeatIntervalMs');
    if (baseInterval > 0) {
        heartbeatInterval = setInterval(() => {
            if (!enabled) return;
            if (currentState === State.IDLE) {
                tryAcceptAll();
            }
        }, baseInterval);
        log('[' + new Date().toLocaleTimeString() + '] Heartbeat started (' + baseInterval + 'ms)');
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
    statusBarItem.tooltip = `YoloMode — ${currentState} | Click to toggle`;
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

        // Window focus
        vscode.window.onDidChangeWindowState((e) => {
            if (e.focused !== windowFocused) {
                windowFocused = e.focused;
                if (e.focused) {
                    log(`[${new Date().toLocaleTimeString()}] Window focused`);
                    if (enabled) transitionTo(State.FAST, 'windowFocused');
                } else {
                    log(`[${new Date().toLocaleTimeString()}] Window backgrounded`);
                }
            }
        }),

        // Text document changes — debounced, only from IDLE
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

                const newEnabled = cfg('enabled');
                if (newEnabled !== enabled) {
                    try {
                        vscode.commands.executeCommand('ag-auto-accept.toggle');
                    } catch (_) { }
                }

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

// --- Command verification ---
async function verifyCommands() {
    try {
        const allCommands = await vscode.commands.getCommands(true);
        const commandSet = new Set(allCommands);
        let found = 0;
        for (const cmdId of ACCEPT_COMMANDS) {
            if (commandSet.has(cmdId)) {
                found++;
            } else {
                log(`[${new Date().toLocaleTimeString()}] WARNING: Command not found: ${cmdId}`);
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

// --- Conflicting extension detection ---
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

// --- Sleep/lock recovery ---
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
    log('=== YoloMode v2.5.1 activated ===');
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

    // Force accept command
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
        startSleepDetection();
        checkConflictingExtensions();
        // Delayed start: wait 3s for Antigravity commands to register
        setTimeout(() => {
            verifyCommands();
            transitionTo(State.FAST, 'activate');
        }, 3000);
        updateStatusBar('$(clock) YOLO', undefined);
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
