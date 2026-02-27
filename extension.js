const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

// ============================================================
// YoloMode v3.0.0 -- Auto-accept for Antigravity
// Works in: Editor, Terminal, Agent Manager (standalone)
// Architecture: Event-driven three-state (IDLE/FAST/SLOW) + heartbeat
//               + CDP fallback for agentSidePanel accept
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

// CDP state
let cdpWs = null;
let cdpReady = false;
let cdpMessageId = 1;
let cdpPendingCallbacks = {};
let cdpReconnectTimer = null;
let cdpSetupDone = false;

// Accept commands (VS Code API path)
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

// ============================================================
// argv.json auto-configuration
// ============================================================

function getArgvJsonPath() {
    const home = os.homedir();
    // Try .antigravity first, fall back to .vscode
    const antigravityPath = path.join(home, '.antigravity', 'argv.json');
    const vscodePath = path.join(home, '.vscode', 'argv.json');
    if (fs.existsSync(antigravityPath)) return antigravityPath;
    if (fs.existsSync(vscodePath)) return vscodePath;
    // Default to .antigravity
    return antigravityPath;
}

function stripJsonComments(text) {
    // Remove single-line // comments (not inside strings)
    let result = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            result += ch;
            escape = false;
            continue;
        }
        if (ch === '\\' && inString) {
            result += ch;
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            result += ch;
            continue;
        }
        if (!inString && ch === '/' && text[i + 1] === '/') {
            // Skip to end of line
            while (i < text.length && text[i] !== '\n') i++;
            result += '\n';
            continue;
        }
        result += ch;
    }
    return result;
}

async function ensureDebugPort() {
    const port = cfg('cdpPort');
    const argvPath = getArgvJsonPath();

    try {
        let content = '';
        let data = {};

        if (fs.existsSync(argvPath)) {
            content = fs.readFileSync(argvPath, 'utf8');
            data = JSON.parse(stripJsonComments(content));
        }

        if (data['remote-debugging-port']) {
            log(`[${new Date().toLocaleTimeString()}] CDP: debug port already configured (${data['remote-debugging-port']}) in ${argvPath}`);
            return data['remote-debugging-port'];
        }

        // Add the flag
        data['remote-debugging-port'] = port;

        // Ensure directory exists
        const dir = path.dirname(argvPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(argvPath, JSON.stringify(data, null, 2), 'utf8');
        log(`[${new Date().toLocaleTimeString()}] CDP: Added remote-debugging-port=${port} to ${argvPath}`);

        const action = await vscode.window.showInformationMessage(
            'YoloMode: CDP auto-accept configured. Restart the IDE for full agent step acceptance.',
            'Restart Now',
            'Later'
        );

        if (action === 'Restart Now') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }

        return null; // Port not active yet until restart
    } catch (err) {
        log(`[${new Date().toLocaleTimeString()}] CDP: Failed to configure argv.json: ${err.message}`);
        return null;
    }
}

// ============================================================
// CDP Connection Layer
// ============================================================

function cdpGetTargets(port) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error('Failed to parse CDP targets'));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => {
            req.destroy();
            reject(new Error('CDP target discovery timed out'));
        });
    });
}

function cdpSend(method, params) {
    return new Promise((resolve, reject) => {
        if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
            return reject(new Error('CDP not connected'));
        }
        const id = cdpMessageId++;
        const msg = JSON.stringify({ id, method, params });
        cdpPendingCallbacks[id] = { resolve, reject };
        cdpWs.send(msg);

        // Timeout
        setTimeout(() => {
            if (cdpPendingCallbacks[id]) {
                delete cdpPendingCallbacks[id];
                reject(new Error(`CDP call ${method} timed out`));
            }
        }, 5000);
    });
}

async function cdpConnect(port) {
    if (cdpWs && cdpWs.readyState === WebSocket.OPEN) return;

    try {
        const targets = await cdpGetTargets(port);
        // Find the main window target (type: "page")
        const target = targets.find(t =>
            t.type === 'page' && t.webSocketDebuggerUrl
        );
        if (!target) {
            log(`[${new Date().toLocaleTimeString()}] CDP: No suitable target found among ${targets.length} targets`);
            return;
        }

        log(`[${new Date().toLocaleTimeString()}] CDP: Connecting to ${target.title || target.url}`);

        cdpWs = new WebSocket(target.webSocketDebuggerUrl);

        cdpWs.on('open', () => {
            cdpReady = true;
            log(`[${new Date().toLocaleTimeString()}] CDP: Connected`);
        });

        cdpWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id && cdpPendingCallbacks[msg.id]) {
                    const cb = cdpPendingCallbacks[msg.id];
                    delete cdpPendingCallbacks[msg.id];
                    if (msg.error) {
                        cb.reject(new Error(msg.error.message));
                    } else {
                        cb.resolve(msg.result);
                    }
                }
            } catch (_) { }
        });

        cdpWs.on('close', () => {
            cdpReady = false;
            cdpWs = null;
            cdpPendingCallbacks = {};
            log(`[${new Date().toLocaleTimeString()}] CDP: Disconnected`);
            scheduleCdpReconnect(port);
        });

        cdpWs.on('error', (err) => {
            log(`[${new Date().toLocaleTimeString()}] CDP: WebSocket error: ${err.message}`);
        });

    } catch (err) {
        log(`[${new Date().toLocaleTimeString()}] CDP: Connection failed: ${err.message}`);
        scheduleCdpReconnect(port);
    }
}

function scheduleCdpReconnect(port) {
    if (cdpReconnectTimer) return;
    cdpReconnectTimer = setTimeout(() => {
        cdpReconnectTimer = null;
        if (enabled && cfg('enableCDP')) {
            cdpConnect(port);
        }
    }, 10000);
}

function cdpDisconnect() {
    if (cdpReconnectTimer) {
        clearTimeout(cdpReconnectTimer);
        cdpReconnectTimer = null;
    }
    if (cdpWs) {
        cdpReady = false;
        cdpWs.close();
        cdpWs = null;
    }
    cdpPendingCallbacks = {};
}

// ============================================================
// CDP Accept Logic — click accept buttons in the DOM
// ============================================================

async function tryAcceptViaCDP() {
    if (!cdpReady || !cfg('enableCDP')) return;

    try {
        // Use the persistent CDP connection (cdpWs) to evaluate in the main page.
        // We use Page.getFrameTree + Runtime on specific contexts to reach webviews.
        // This avoids opening new WebSocket connections per poll which causes
        // the webview frame to activate and trigger scroll-into-view.

        // The accept script — minimal DOM interaction, no scrolling, no focus changes.
        // Uses element.click() which dispatches a click event without scrolling.
        // No getBoundingClientRect, no scrollIntoView, no focus, no coordinate math.
        const script = `
            (function() {
                let clicked = 0;
                try {
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        const text = (btn.textContent || '').trim().toLowerCase();

                        // Strict exact-match only
                        if (
                            text !== 'run' &&
                            text !== 'accept' &&
                            text !== 'approve' &&
                            text !== 'continue' &&
                            text !== 'run command' &&
                            text !== 'accept all' &&
                            text !== 'yes' &&
                            text !== 'allow'
                        ) continue;

                        // Must be rendered (not display:none or detached)
                        if (btn.offsetParent === null) continue;

                        // Click without any scrolling or focus changes
                        btn.click();
                        clicked++;
                    }
                } catch (e) { }
                return clicked;
            })()
        `;

        // Execute on the persistent main-page connection
        // This does NOT open new connections or activate frames
        const result = await cdpSend('Runtime.evaluate', {
            expression: script,
            returnByValue: true,
        });

        if (result && result.result && result.result.value > 0) {
            log(`[${new Date().toLocaleTimeString()}] CDP: Clicked ${result.result.value} accept button(s)`);
        }
    } catch (err) {
        // Silently fail — CDP is best-effort
    }
}



// ============================================================
// Core accept logic: VS Code API + CDP fallback
// ============================================================

async function tryAcceptAll() {
    if (!enabled || isAccepting) return;
    isAccepting = true;

    try {
        // Path 1: VS Code API commands (works for terminal, editor, and legacy agent accept)
        for (const cmdId of ACCEPT_COMMANDS) {
            try {
                await vscode.commands.executeCommand(cmdId);
            } catch (_) {
                // Command not available or failed — ignore
            }
        }

        // Path 2: CDP fallback (clicks accept buttons in the agentSidePanel DOM)
        await tryAcceptViaCDP();
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
    const cdpStatus = cdpReady ? 'CDP ✓' : 'CDP ✗';
    statusBarItem.tooltip = `YoloMode — ${currentState} | ${cdpStatus} | Click to toggle`;
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
    log('=== YoloMode v3.0.2 activated ===');
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
                cdpDisconnect();
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

        // CDP setup: ensure debug port is configured, then connect
        if (cfg('enableCDP')) {
            ensureDebugPort().then(port => {
                if (port) {
                    cdpConnect(port);
                } else {
                    log(`[${new Date().toLocaleTimeString()}] CDP: Debug port not active yet (restart required)`);
                }
            });
        }
    } else {
        updateStatusBar('$(x) YOLO', undefined);
    }
}

function deactivate() {
    clearAllTimers();
    disposeEventListeners();
    cdpDisconnect();
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
