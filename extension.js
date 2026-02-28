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
    const antigravityPath = path.join(home, '.antigravity', 'argv.json');
    const vscodePath = path.join(home, '.vscode', 'argv.json');
    if (fs.existsSync(antigravityPath)) return antigravityPath;
    if (fs.existsSync(vscodePath)) return vscodePath;
    return antigravityPath;
}

function stripJsonComments(text) {
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
            while (i < text.length && text[i] !== '\n') i++;
            result += '\n';
            continue;
        }
        result += ch;
    }
    result = result.replace(/,(\s*[}\]])/g, '$1');
    return result;
}

function isPortInUse(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const server = net.createServer();
        server.once('error', () => resolve(true));
        server.once('listening', () => { server.close(); resolve(false); });
        server.listen(port, '127.0.0.1');
    });
}

async function findAvailablePort(startPort) {
    for (let port = startPort; port <= startPort + 6; port++) {
        const inUse = await isPortInUse(port);
        if (!inUse) {
            log(`[${new Date().toLocaleTimeString()}] CDP: Port ${port} is available`);
            return port;
        }
        log(`[${new Date().toLocaleTimeString()}] CDP: Port ${port} is in use, trying next`);
    }
    return startPort;
}

function insertPortIntoArgv(rawContent, port) {
    const lastBrace = rawContent.lastIndexOf('}');
    if (lastBrace === -1) {
        return `{\n    "remote-debugging-port": ${port}\n}\n`;
    }
    const before = rawContent.substring(0, lastBrace).trimEnd();
    const after = rawContent.substring(lastBrace);
    const needsComma = /["\d\w\]}\-]/.test(before[before.length - 1]);
    return before + (needsComma ? ',' : '') + `\n    "remote-debugging-port": ${port}\n` + after;
}

function updatePortInArgv(rawContent, newPort) {
    return rawContent.replace(
        /("remote-debugging-port"\s*:\s*)\d+/,
        `$1${newPort}`
    );
}

async function ensureDebugPort() {
    const preferredPort = cfg('cdpPort');
    const argvPath = getArgvJsonPath();

    try {
        let rawContent = '';
        let data = {};

        if (fs.existsSync(argvPath)) {
            rawContent = fs.readFileSync(argvPath, 'utf8');
            data = JSON.parse(stripJsonComments(rawContent));
        }

        if (data['remote-debugging-port']) {
            const existingPort = data['remote-debugging-port'];
            log(`[${new Date().toLocaleTimeString()}] CDP: debug port configured (${existingPort}) in ${argvPath}`);
            return existingPort;
        }

        const port = await findAvailablePort(preferredPort);

        const dir = path.dirname(argvPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (rawContent) {
            const updated = insertPortIntoArgv(rawContent, port);
            fs.writeFileSync(argvPath, updated, 'utf8');
        } else {
            fs.writeFileSync(argvPath, `{\n    "remote-debugging-port": ${port}\n}\n`, 'utf8');
        }
        log(`[${new Date().toLocaleTimeString()}] CDP: Added remote-debugging-port=${port} to ${argvPath}`);

        const action = await vscode.window.showWarningMessage(
            'YoloMode: Debug port configured. Please restart Antigravity completely (close all windows) for auto-accept to work.',
            'Restart Now',
            'Later'
        );

        if (action === 'Restart Now') {
            vscode.commands.executeCommand('workbench.action.quit');
        }

        return null;
    } catch (err) {
        log(`[${new Date().toLocaleTimeString()}] CDP: Failed to configure argv.json: ${err.message}`);
        return null;
    }
}

// CDP state — persistent per-target WebSocket pool
let cdpTargetPool = new Map(); // Map<targetId, { ws, title, type, msgId, callbacks, isWebview, observerInjected }>
let cdpDiscoveryTimer = null;
let cdpPort = null;

// ============================================================
// CDP Connection Layer — per-target persistent WebSockets
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

function cdpSendTo(entry, method, params) {
    return new Promise((resolve, reject) => {
        if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('Not connected'));
        }
        const id = entry.msgId++;
        const msg = JSON.stringify({ id, method, params });
        entry.callbacks[id] = { resolve, reject };
        entry.ws.send(msg);

        setTimeout(() => {
            if (entry.callbacks[id]) {
                delete entry.callbacks[id];
                reject(new Error(`CDP call ${method} timed out`));
            }
        }, 5000);
    });
}

function cdpConnectTarget(target) {
    const targetId = target.id;
    if (cdpTargetPool.has(targetId)) return;

    const title = target.title || target.url || targetId;
    const entry = {
        ws: null,
        title,
        type: target.type,
        msgId: 1,
        callbacks: {},
        isWebview: null,       // null = unchecked, true/false = cached
        observerInjected: false,
    };

    try {
        entry.ws = new WebSocket(target.webSocketDebuggerUrl);
    } catch (err) {
        return;
    }

    entry.ws.on('open', () => {
        log(`[${new Date().toLocaleTimeString()}] CDP: Connected to "${title}" (${target.type})`);
    });

    entry.ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.id && entry.callbacks[msg.id]) {
                const cb = entry.callbacks[msg.id];
                delete entry.callbacks[msg.id];
                if (msg.error) {
                    cb.reject(new Error(msg.error.message));
                } else {
                    cb.resolve(msg.result);
                }
            }
        } catch (_) { }
    });

    entry.ws.on('close', () => {
        cdpTargetPool.delete(targetId);
        log(`[${new Date().toLocaleTimeString()}] CDP: Target disconnected: "${title}"`);
    });

    entry.ws.on('error', () => {
        // Will trigger close event
    });

    cdpTargetPool.set(targetId, entry);
}

async function cdpDiscoverAndConnect(port) {
    if (!enabled || !cfg('enableCDP')) return;

    try {
        const targets = await cdpGetTargets(port);
        const liveIds = new Set(targets.map(t => t.id));

        // Clean up connections for targets that disappeared
        for (const [id, entry] of cdpTargetPool) {
            if (!liveIds.has(id)) {
                if (entry.ws) { try { entry.ws.close(); } catch (_) { } }
                cdpTargetPool.delete(id);
            }
        }

        // Connect to new targets (skip workers with empty URLs)
        let newCount = 0;
        for (const target of targets) {
            if (!target.webSocketDebuggerUrl) continue;
            if (target.type === 'worker' || target.type === 'service_worker') continue;
            if (cdpTargetPool.has(target.id)) continue;

            cdpConnectTarget(target);
            newCount++;
        }
        if (newCount > 0) {
            log(`[${new Date().toLocaleTimeString()}] CDP: Discovered ${newCount} new target(s) (${cdpTargetPool.size} total)`);
        }
        // Always log target types for diagnostics
        const types = targets.map(t => `${t.type}:${(t.title || t.url || '').substring(0, 30)}`);
        log(`[${new Date().toLocaleTimeString()}] CDP TARGETS: ${targets.length} total [${types.join(', ')}]`);
    } catch (err) {
        // Silent — discovery will retry next cycle
    }
}

function startCdpDiscovery(port) {
    cdpPort = port;
    cdpDiscoverAndConnect(port);
    if (cdpDiscoveryTimer) clearInterval(cdpDiscoveryTimer);
    cdpDiscoveryTimer = setInterval(() => cdpDiscoverAndConnect(port), 10000);
}

function cdpDisconnect() {
    if (cdpDiscoveryTimer) {
        clearInterval(cdpDiscoveryTimer);
        cdpDiscoveryTimer = null;
    }
    for (const [id, entry] of cdpTargetPool) {
        if (entry.ws) { try { entry.ws.close(); } catch (_) { } }
    }
    cdpTargetPool.clear();
    // NOTE: do NOT clear cdpPort — it's needed for toggle-on reconnection
}

// ============================================================
// CDP Accept Logic — dual approach: button click + Alt+Enter KeyboardEvent
// ============================================================

// NOTE: Antigravity buttons include keyboard shortcut text in textContent
// e.g. "RunAlt+⌥↵" not just "Run". So we use startsWith matching, not exact match.
const CDP_ACCEPT_SCRIPT = `
    (function() {
        var clicked = 0;
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var text = (btn.textContent || '').trim();
            if (!/^(Run|Accept|Accept All|Allow|Allow Once|Allow This Conversation|Yes)/i.test(text)) continue;
            if (btn.offsetParent === null) continue;
            if (btn.disabled) continue;
            if (btn.dataset.yoloClicked && Date.now() - parseInt(btn.dataset.yoloClicked) < 5000) continue;
            btn.dataset.yoloClicked = Date.now().toString();
            btn.click();
            clicked++;
        }
        return clicked;
    })()
`;

// Alt+Enter on #conversation — proven fallback for IDE side panel
const ALT_ENTER_SCRIPT = `
    (function() {
        var conv = document.querySelector('#conversation');
        if (!conv) return 0;
        conv.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', altKey: true, shiftKey: false,
            bubbles: true, cancelable: true
        }));
        return 1;
    })()
`;

async function tryAcceptViaCDP() {
    if (cdpTargetPool.size === 0 || !cfg('enableCDP')) return;

    for (const [id, entry] of cdpTargetPool) {
        if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) continue;

        // Method 1: Click matching buttons
        try {
            const result = await cdpSendTo(entry, 'Runtime.evaluate', {
                expression: CDP_ACCEPT_SCRIPT,
                returnByValue: true,
            });
            if (result && result.result && result.result.value > 0) {
                log(`[${new Date().toLocaleTimeString()}] CDP: Clicked ${result.result.value} button(s) on "${entry.title.substring(0, 50)}"`);
            }
        } catch (_) {
            // Target may have been destroyed — ignore
        }
    }
}



// ============================================================
// Core accept logic: VS Code API + CDP fallback
// ============================================================

async function tryAcceptAll() {
    if (!enabled || isAccepting) return;
    isAccepting = true;

    try {
        // CDP: click accept buttons in webview DOMs
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
    const cdpStatus = cdpTargetPool.size > 0 ? `CDP ✓ (${cdpTargetPool.size} targets)` : 'CDP ✗';
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
    log('=== YoloMode v3.1.0 activated ===');
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
                // Restart CDP discovery to reconnect and re-activate observers
                if (cfg('enableCDP') && cdpPort) {
                    startCdpDiscovery(cdpPort);
                }
                vscode.window.showInformationMessage('YoloMode: ON');
            } else {
                log(`[${new Date().toLocaleTimeString()}] === DISABLED ===`);
                // Deactivate observers in all targets before disconnecting
                for (const [id, entry] of cdpTargetPool) {
                    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                        try { cdpSendTo(entry, 'Runtime.evaluate', { expression: 'window.__yolomode_active = false', returnByValue: true }); } catch (_) { }
                    }
                }
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
                    startCdpDiscovery(port);
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
