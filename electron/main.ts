import { app, BrowserWindow, dialog, ipcMain, shell, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { games, type GameDefinition, type GameId } from './games';
import * as cloudFs from './lib/cloudFs';
import * as cloudIndex from './lib/cloudIndex';
import * as steam from './lib/steam';

let mainWindow: BrowserWindow | null = null;

async function spawnDetached(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        try {
            const child = spawn(command, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });

            child.once('spawn', () => {
                child.unref();
                finish(true);
            });
            child.once('error', () => finish(false));

            // Borner l'attente du launcher pour ne jamais bloquer une requête IPC.
            setTimeout(() => finish(false), 1800).unref();
        } catch {
            finish(false);
        }
    });
}

async function openDirectoryInDefaultFileManager(target: string): Promise<void> {
    const attempts: Array<[string, string[]]> = process.platform === 'win32'
        ? [['explorer.exe', [target]]]
        : process.platform === 'darwin'
            ? [['open', [target]]]
            : [
                    ['xdg-open', [target]],
                    ['gio', ['open', target]]
                ];

    for (const [command, args] of attempts) {
        if (await spawnDetached(command, args)) return;
    }

    // Borner le fallback Electron même si le portal Linux reste bloqué.
    const result = await Promise.race([
        shell.openPath(target).then((message) => ({ done: true, message })),
        new Promise<{ done: false; message: string }>((resolve) =>
            setTimeout(() => resolve({ done: false, message: 'File manager timed out.' }), 2500)
        )
    ]);

    if (!result.done) throw new Error(result.message);
    if (result.message) throw new Error(result.message);
}

async function revealInDefaultFileManager(target: string): Promise<void> {
    if (process.platform === 'win32') {
        if (await spawnDetached('explorer.exe', [`/select,${target}`])) return;
    } else if (process.platform === 'darwin') {
        if (await spawnDetached('open', ['-R', target])) return;
    } else {
        // Utiliser l'intégration desktop Electron pour révéler l'entrée si possible.
        try {
            shell.showItemInFolder(target);
            return;
        } catch {
            const parent = path.dirname(target);
            if (await spawnDetached('xdg-open', [parent])) return;
            if (await spawnDetached('gio', ['open', parent])) return;
        }
    }

    // Garder un fallback pour les desktop environments atypiques.
    await openDirectoryInDefaultFileManager(path.dirname(target));
}


// Guard des fenêtres et process de jeu.

type BackgroundGuard = { timer: NodeJS.Timeout; busy: boolean; lastMode: string; affected: number; startedAt: number; stopped: boolean };
const backgroundGuards = new Map<GameId, BackgroundGuard>();
const managedGameSessions = new Set<GameId>();
const splitRestoreProgress = new Map<GameId, cloudFs.SplitRestoreProgress>();
const pendingIndexSnapshots = new Map<GameId, cloudIndex.CloudIndexSnapshot>();
let quitCleanupStarted = false;
let quitCleanupFinished = false;
let rendererClosePending = false;
let rendererCloseApproved = false;
let rendererQuitRequested = false;

function gameById(id: GameId): GameDefinition {
    const game = games.find((candidate) => candidate.id === id);
    if (!game) throw new Error('Unknown game.');
    return game;
}

function splitCacheRoot(id: GameId): string {
    return path.join(app.getPath('userData'), 'split-cache', id);
}

async function getEnvironment() {
    const steamRoot = await steam.detectSteamRoot();
    const libraries = await steam.detectLibraries(steamRoot);
    const steamId64 = await steam.detectSteamId64(steamRoot);
    return { steamRoot, libraries, steamId64 };
}


async function stopBackgroundGuard(id: GameId): Promise<boolean> {
    const guard = backgroundGuards.get(id);
    if (guard) {
        guard.stopped = true;
        clearTimeout(guard.timer);
        backgroundGuards.delete(id);
    }
    try {
        await steam.cleanupBackgroundApp(gameById(id));
    } catch {
        // Tolérer un cleanup refusé par le compositor sans bloquer l'application.
    }
    return Boolean(guard);
}

function refocusVaporStow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        mainWindow.show();
        mainWindow.moveTop();
        mainWindow.focus();
    } catch {
        // Tolérer les refus de focus explicite sur certains compositors Wayland.
    }
}

async function startBackgroundGuard(id: GameId) {
    await stopBackgroundGuard(id);
    const game = gameById(id);
    const env = await getEnvironment();
    const install = await steam.findInstalledApp(env.libraries, game.appId);
    const prepared = await steam.prepareBackgroundApp(game, install);

    const guard: BackgroundGuard = {
        timer: null as unknown as NodeJS.Timeout,
        busy: false,
        lastMode: prepared.mode,
        affected: 0,
        startedAt: Date.now(),
        stopped: false
    };

    const tick = async () => {
        if (guard.stopped || guard.busy) return;
        guard.busy = true;
        try {
            const result = await steam.backgroundApp(game, install);
            guard.lastMode = result.mode;
            guard.affected += result.affected;
            if (result.affected > 0) refocusVaporStow();
        } finally {
            guard.busy = false;
        }
    };

    const schedule = () => {
        if (guard.stopped) return;
        // Poll rapidement au démarrage puis ralentir pour limiter les requêtes système.
        const age = Date.now() - guard.startedAt;
        const delay = age < 15_000 ? 60 : 400;
        guard.timer = setTimeout(async () => {
            await tick();
            schedule();
        }, delay);
    };

    // Démarrer le guard avant le jeu pour capter sa première fenêtre.
    await tick();
    backgroundGuards.set(id, guard);
    managedGameSessions.add(id);
    schedule();

    return { started: true, mode: guard.lastMode, affected: guard.affected, prepared: prepared.prepared };
}

type UsageMemoryEntry = {
    cloudBytes?: number;
    cloudFiles?: number;
    // Conserver ce field 1.0.0 pour les anciennes builds de développement.
    bytes?: number;
    updatedAt: string;
};
type UsageMemory = Partial<Record<GameId, UsageMemoryEntry>>;

async function readUsageMemory(): Promise<UsageMemory> {
    try {
        const file = path.join(app.getPath('userData'), 'usage-memory.json');
        return JSON.parse(await fs.promises.readFile(file, 'utf8')) as UsageMemory;
    } catch {
        return {};
    }
}

async function writeUsageMemory(id: GameId, bytes: number, files: number): Promise<void> {
    const file = path.join(app.getPath('userData'), 'usage-memory.json');
    const memory = await readUsageMemory();
    memory[id] = {
        cloudBytes: Math.max(0, Math.floor(bytes)),
        cloudFiles: Math.max(0, Math.floor(files)),
        updatedAt: new Date().toISOString()
    };
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(memory, null, 2), 'utf8');
}

async function gameStatus(
    game: GameDefinition,
    env: Awaited<ReturnType<typeof getEnvironment>>,
    memory: UsageMemory
) {
    const install = await steam.findInstalledApp(env.libraries, game.appId);
    const running = install.installed ? await steam.isAppRunning(game, install) : false;
    const cloudRoot = game.getCloudRoot({
        steamLibraries: env.libraries,
        steamId64: env.steamId64,
        installedLibrary: install.library
    });
    const cloudRootExists = Boolean(cloudRoot && fs.existsSync(cloudRoot));

    let disk: { free: number; total: number } | null = null;
    try {
        if (cloudRoot) disk = await cloudFs.statFsFor(cloudRoot);
    } catch {
        disk = null;
    }

    const audit = cloudRoot
        ? await cloudFs.listAuditTree(cloudRoot)
        : { root: null, bytes: 0, files: 0 };
    const cloud = cloudRoot
        ? await cloudFs.treeStats(cloudRoot)
        : { bytes: 0, files: 0 };
    const remembered = memory[game.id];

    return {
        id: game.id,
        appId: game.appId,
        name: game.name,
        volumeName: game.volumeName,
        quotaBytes: game.quotaBytes,
        maxFiles: game.maxFiles,
        cloudPattern: game.cloudPattern,
        platformSupported: game.platforms.includes(process.platform),
        nativeCloudSupport: game.nativeCloudPlatforms.includes(process.platform),
        protonExperimental: Boolean(game.protonExperimental && process.platform === 'linux'),
        installed: install.installed,
        installing: install.installing,
        installDir: install.installDir,
        installSize: install.sizeOnDisk > 0 ? install.sizeOnDisk : game.installSizeFallbackBytes,
        running,
        cloudRoot,
        cloudRootExists,
        auditRoot: audit.root,
        auditBytes: audit.bytes,
        auditFiles: audit.files,
        cloudBytes: cloud.bytes,
        cloudFiles: cloud.files,
        rememberedBytes: remembered?.cloudBytes ?? remembered?.bytes ?? null,
        rememberedFiles: remembered?.cloudFiles ?? null,
        disk
    };
}

async function fullStatus() {
    const env = await getEnvironment();
    const memory = await readUsageMemory();
    const steamRunning = Boolean(env.steamRoot) && await steam.isSteamRunning();
    const steamCloudLog = await steam.detectCloudLogPath(env.steamRoot);
    const statuses = [];
    for (const game of games) statuses.push(await gameStatus(game, env, memory));

    return {
        appVersion: app.getVersion(),
        platform: process.platform,
        steamInstalled: Boolean(env.steamRoot),
        steamRunning,
        steamRoot: env.steamRoot,
        steamCloudLog,
        steamId64: env.steamId64,
        games: statuses
    };
}

async function requireRunningGame(id: GameId) {
    const game = gameById(id);
    const env = await getEnvironment();
    const status = await gameStatus(game, env, await readUsageMemory());

    if (!status.running) {
        throw new Error('The Steam session is not open for this volume.');
    }
    if (!status.cloudRoot) {
        throw new Error('No local Auto-Cloud path is available for this game on the current platform.');
    }

    return { game, env, status };
}



// API IPC exposée au renderer.

function registerIpc() {
    ipcMain.handle('status:get', fullStatus);

    ipcMain.handle('steam:download', async () => {
        await shell.openExternal('https://store.steampowered.com/about/');
    });

    ipcMain.handle('steam:run', async () => {
        const env = await getEnvironment();
        if (!env.steamRoot) throw new Error('Steam is not installed.');
        if (await steam.isSteamRunning()) return { launched: false, alreadyRunning: true };

        const launched = await steam.launchSteamBackground(env.steamRoot);
        if (!launched) await shell.openExternal('steam://open/main');
        return { launched: true, alreadyRunning: false };
    });

    ipcMain.handle('game:open-store', async (_event, id: GameId) => {
        await shell.openExternal(gameById(id).storeUrl);
    });

    ipcMain.handle('game:install', async (_event, id: GameId) => {
        const game = gameById(id);
        const steamRoot = await steam.detectSteamRoot();
        await shell.openExternal(steamRoot ? game.steamInstallUrl : game.storeUrl);
    });

    ipcMain.handle('game:run', async (_event, id: GameId) => {
        const game = gameById(id);
        const env = await getEnvironment();
        const launched = await steam.launchAppBackground(env.steamRoot, game.appId);
        if (!launched) await shell.openExternal(game.steamRunUrl);
    });

    ipcMain.handle('game:background-start', async (_event, id: GameId) => startBackgroundGuard(id));

    ipcMain.handle('game:background-stop', async (_event, id: GameId) => stopBackgroundGuard(id));

    ipcMain.handle('game:request-stop', async (_event, id: GameId) => {
        const game = gameById(id);
        const env = await getEnvironment();
        const install = await steam.findInstalledApp(env.libraries, game.appId);
        const cloudLogMarker = await steam.cloudLogMarker(env.steamRoot);
        try {
            const stopped = await steam.stopAppGracefully(game, install);
            return { ...stopped, cloudLogMarker };
        } finally {
            managedGameSessions.delete(id);
            await stopBackgroundGuard(id);
        }
    });

    ipcMain.handle('cloud:prepare-sync', async (_event, id: GameId) => {
        const { game, status } = await requireRunningGame(id);
        return cloudFs.prepareSplitFilesForSync(
            status.cloudRoot!,
            game.quotaBytes,
            game.maxFiles,
            splitCacheRoot(id)
        );
    });

    ipcMain.handle('cloud:content-summary', async (_event, id: GameId) => {
        const { status } = await requireRunningGame(id);
        return cloudFs.cloudContentSummary(status.cloudRoot!);
    });

    ipcMain.handle('cloud:prune-empty-directories', async (_event, id: GameId) => {
        const game = gameById(id);
        const env = await getEnvironment();
        const status = await gameStatus(game, env, await readUsageMemory());
        if (!status.cloudRoot) {
            throw new Error('No local Auto-Cloud path is available for this game on the current platform.');
        }
        return cloudFs.pruneEmptyAuditDirectories(status.cloudRoot);
    });

    ipcMain.handle('cloud:restore-split-files', async (_event, id: GameId) => {
        const { status } = await requireRunningGame(id);
        splitRestoreProgress.delete(id);
        return cloudFs.restoreSplitFiles(
            status.cloudRoot!,
            splitCacheRoot(id),
            (progress) => splitRestoreProgress.set(id, progress)
        );
    });

    ipcMain.handle('cloud:restore-progress', async (_event, id: GameId) => {
        return splitRestoreProgress.get(id) || null;
    });

    ipcMain.handle('cloud:log-marker', async () => {
        const env = await getEnvironment();
        return steam.cloudLogMarker(env.steamRoot);
    });

    ipcMain.handle('cloud:reset-log', async () => {
        const env = await getEnvironment();
        return steam.clearCloudLog(env.steamRoot);
    });

    ipcMain.handle(
        'cloud:progress',
        async (_event, id: GameId, marker: number, direction: steam.CloudTransferDirection = 'auto') => {
            const game = gameById(id);
            const env = await getEnvironment();
            const install = await steam.findInstalledApp(env.libraries, game.appId);
            const cloudRoot = game.getCloudRoot({
                steamLibraries: env.libraries,
                steamId64: env.steamId64,
                installedLibrary: install.library
            });
            const safeDirection: steam.CloudTransferDirection = direction === 'up' || direction === 'down' ? direction : 'auto';
            return steam.cloudTransferProgress(
                env.steamRoot,
                game.appId,
                Number.isFinite(marker) ? marker : 0,
                cloudRoot,
                safeDirection
            );
        }
    );

    ipcMain.handle('cloud:wait-sync', async (_event, id: GameId, marker: number) => {
        const game = gameById(id);
        const env = await getEnvironment();
        return steam.waitForCloudSync(env.steamRoot, game.appId, Number.isFinite(marker) ? marker : 0);
    });

    ipcMain.handle('memory:set-usage', async (_event, id: GameId, bytes: number, files: number) => {
        gameById(id);
        if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Invalid usage value.');
        if (!Number.isFinite(files) || files < 0) throw new Error('Invalid file-count value.');
        await writeUsageMemory(id, bytes, files);
        return true;
    });

    ipcMain.handle('cloud:index-search', async (_event, query: string, limit?: number) => {
        return cloudIndex.search(typeof query === 'string' ? query : '', limit);
    });

    ipcMain.handle('cloud:index-rebuild', async (_event, id: GameId) => {
        const { game, status } = await requireRunningGame(id);
        pendingIndexSnapshots.delete(id);
        return cloudIndex.rebuildGame(game, status.cloudRoot!);
    });

    ipcMain.handle('cloud:index-stage', async (_event, id: GameId) => {
        const { game, status } = await requireRunningGame(id);
        const snapshot = await cloudIndex.snapshotGame(game, status.cloudRoot!);
        pendingIndexSnapshots.set(id, snapshot);
        return snapshot.entries.length;
    });

    ipcMain.handle('cloud:index-commit', async (_event, id: GameId) => {
        gameById(id);
        const snapshot = pendingIndexSnapshots.get(id);
        if (!snapshot) throw new Error('No staged Cloud index is available.');
        cloudIndex.commitSnapshot(snapshot);
        pendingIndexSnapshots.delete(id);
        return snapshot.entries.length;
    });

    ipcMain.handle('cloud:index-discard', async (_event, id: GameId) => {
        gameById(id);
        return pendingIndexSnapshots.delete(id);
    });

    ipcMain.handle('cloud:list-directory', async (_event, id: GameId, relativeDirectory: string) => {
        const { status } = await requireRunningGame(id);
        return cloudFs.listAuditDirectory(status.cloudRoot!, relativeDirectory || '');
    });

    ipcMain.handle('cloud:import-files', async (_event, id: GameId, relativeDirectory: string) => {
        const { game, status } = await requireRunningGame(id);
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: `Import files · ${game.name}`,
            properties: ['openFile', 'multiSelections']
        });
        if (result.canceled || result.filePaths.length === 0) return { canceled: true };

        await cloudFs.preflightFilesImport(
            status.cloudRoot!,
            relativeDirectory || '',
            result.filePaths,
            game.quotaBytes,
            game.maxFiles
        );


        await cloudFs.importFiles(
            status.cloudRoot!,
            relativeDirectory || '',
            result.filePaths,
            game.quotaBytes,
            game.maxFiles
        );
        return { canceled: false };
    });

    ipcMain.handle('cloud:import-folder', async (_event, id: GameId, relativeDirectory: string) => {
        const { game, status } = await requireRunningGame(id);
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: `Import folder · ${game.name}`,
            properties: ['openDirectory']
        });
        if (result.canceled || result.filePaths.length === 0) return { canceled: true };
        await cloudFs.preflightDirectoryImport(
            status.cloudRoot!,
            relativeDirectory || '',
            result.filePaths[0],
            game.quotaBytes,
            game.maxFiles
        );


        await cloudFs.importDirectory(
            status.cloudRoot!,
            relativeDirectory || '',
            result.filePaths[0],
            game.quotaBytes,
            game.maxFiles
        );
        return { canceled: false };
    });

    ipcMain.handle(
        'cloud:create-folder',
        async (_event, id: GameId, relativeDirectory: string, name: string) => {
            const { status } = await requireRunningGame(id);
            await cloudFs.createFolder(status.cloudRoot!, relativeDirectory || '', name);
            return true;
        }
    );

    ipcMain.handle('cloud:delete', async (_event, id: GameId, relativePath: string) => {
        const { status } = await requireRunningGame(id);
        await cloudFs.deleteEntry(status.cloudRoot!, relativePath);
        return true;
    });

    ipcMain.handle('cloud:open-folder', async (_event, id: GameId, relativeDirectory: string) => {
        const game = gameById(id);
        const env = await getEnvironment();
        const status = await gameStatus(game, env, await readUsageMemory());
        if (!status.cloudRoot) throw new Error('Local Auto-Cloud path unavailable.');

        const target = cloudFs.resolveAuditDirectory(status.cloudRoot, relativeDirectory || '');
        await cloudFs.ensureDir(target);
        await openDirectoryInDefaultFileManager(target);
        return true;
    });

    ipcMain.handle('cloud:reveal-entry', async (_event, id: GameId, relativePath: string) => {
        const game = gameById(id);
        const env = await getEnvironment();
        const status = await gameStatus(game, env, await readUsageMemory());
        if (!status.cloudRoot) throw new Error('Local Auto-Cloud path unavailable.');

        const target = cloudFs.resolveAuditEntry(status.cloudRoot, relativePath);
        if (!fs.existsSync(target)) throw new Error('This item no longer exists locally.');

        await revealInDefaultFileManager(target);
        return true;
    });

    ipcMain.handle('cloud:logs', async (_event, id: GameId) => {
        const game = gameById(id);
        const env = await getEnvironment();
        return steam.recentCloudLog(env.steamRoot, game.appId, 120);
    });

    ipcMain.on('app:close-ready', () => {
        rendererClosePending = false;
        rendererCloseApproved = true;

        if (rendererQuitRequested) {
            app.quit();
            return;
        }

        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    ipcMain.on('app:close-cancel', () => {
        rendererClosePending = false;
        rendererQuitRequested = false;
    });
}

function requestRendererClose(quitApp: boolean): void {
    if (quitApp) rendererQuitRequested = true;
    if (rendererClosePending) return;

    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        rendererCloseApproved = true;
        if (rendererQuitRequested) app.quit();
        return;
    }

    rendererClosePending = true;
    mainWindow.webContents.send('app:close-request');
}

// Fenêtre Electron principale.

function createWindow() {
    rendererClosePending = false;
    rendererCloseApproved = false;
    rendererQuitRequested = false;

    // Fixer la fenêtre selon la work area pour rester compatible avec les écrans 768p.
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const width = Math.min(
        Math.max(560, workArea.width - 16),
        Math.max(720, Math.min(1040, Math.floor(workArea.width * 0.90)))
    );
    const height = Math.min(
        Math.max(500, workArea.height - 16),
        Math.max(540, Math.min(720, Math.floor(workArea.height * 0.90)))
    );

    mainWindow = new BrowserWindow({
        width,
        height,
        center: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        backgroundColor: '#0b0c0e',
        titleBarStyle: 'hidden',
        ...(process.platform !== 'darwin'
            ? { titleBarOverlay: { color: '#0b0c0e', symbolColor: '#777a80', height: 34 } }
            : {}),
        title: 'VaporStow',
        ...(process.platform !== 'darwin'
            ? {
                icon: path.join(
                    __dirname,
                    '..',
                    'assets',
                    'build',
                    process.platform === 'win32' ? 'windows.ico' : path.join('linux', '256x256.png')
                )
            }
            : {}),
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    // Fixer aussi min/max pour les window managers Linux les moins fiables.
    mainWindow.setMinimumSize(width, height);
    mainWindow.setMaximumSize(width, height);
    mainWindow.setResizable(false);
    mainWindow.setMaximizable(false);
    mainWindow.setFullScreenable(false);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('close', (event) => {
        if (rendererCloseApproved) return;
        event.preventDefault();
        requestRendererClose(false);
    });

    const devServer = process.env.VITE_DEV_SERVER_URL;
    if (devServer) {
        void mainWindow.loadURL(devServer);
    } else {
        void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }
}

async function shutdownManagedSession(id: GameId): Promise<void> {
    const game = gameById(id);
    const env = await getEnvironment();
    const install = await steam.findInstalledApp(env.libraries, game.appId);

    try {
        if (await steam.isAppRunning(game, install)) {
            const cloudRoot = game.getCloudRoot({
                steamLibraries: env.libraries,
                steamId64: env.steamId64,
                installedLibrary: install.library
            });

            // A Cloud session can contain rebuilt >100 MiB files while it is open.
            // Put the Steam-facing split representation back before stopping the
            // game so closing VaporStow cannot leave the cloud in an unsafe state.
            if (cloudRoot) {
                try {
                    await cloudFs.prepareSplitFilesForSync(
                        cloudRoot,
                        game.quotaBytes,
                        game.maxFiles,
                        splitCacheRoot(id)
                    );
                } catch (error) {
                    console.error(`[VaporStow] Failed to prepare ${game.name} during app shutdown:`, error);
                }
            }

            await steam.stopAppGracefully(game, install);
        }
    } finally {
        managedGameSessions.delete(id);
        await stopBackgroundGuard(id);
    }
}

async function shutdownManagedSessions(): Promise<void> {
    // Do this sequentially: Steam can serialize app shutdown/cloud work and the
    // supported game list is intentionally tiny.
    for (const id of [...managedGameSessions]) {
        try {
            await shutdownManagedSession(id);
        } catch (error) {
            console.error(`[VaporStow] Failed to stop managed game ${id}:`, error);
        }
    }
}

app.on('before-quit', (event) => {
    if (rendererCloseApproved) return;

    // Avec une session Cloud active, laisser le renderer exécuter le chemin
    // Synchronize complet (upload Steam + commit de l'index) avant de quitter.
    if (managedGameSessions.size > 0 && mainWindow && !mainWindow.isDestroyed()) {
        event.preventDefault();
        requestRendererClose(true);
        return;
    }

    // Fallback sans renderer (arrêt anormal/dev) : ne jamais laisser un jeu géré orphelin.
    if (quitCleanupFinished || managedGameSessions.size === 0) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;

    void shutdownManagedSessions().finally(() => {
        quitCleanupFinished = true;
        rendererCloseApproved = true;
        app.quit();
    });
});

// In development, concurrently sends SIGTERM when the dev stack is stopped.
// Route it through Electron's normal quit path so managed games are not orphaned.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        if (app.isReady()) app.quit();
        else process.exit(0);
    });
}

app.whenReady().then(() => {
    cloudIndex.initialize();
    registerIpc();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('will-quit', () => {
    cloudIndex.close();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
