import { app, BrowserWindow, dialog, ipcMain, shell, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { GameDefinition, GameId } from './games';
import { discoverSteamCloudGames } from './lib/steamCloudDiscovery';
import { currentExternalCatalogGames, currentExternalCatalogStats, refreshExternalCatalogDiscovery, startExternalCatalogDiscovery, type ExternalCatalogSearchCriteria } from './lib/steamCatalogDiscovery';
import * as cloudFs from './lib/cloudFs';
import * as cloudIndex from './lib/cloudIndex';
import * as carrierStorage from './lib/carrierStorage';
import * as protectedPools from './lib/protectedPools';
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
        try {
            shell.showItemInFolder(target);
            return;
        } catch {
            const parent = path.dirname(target);
            if (await spawnDetached('xdg-open', [parent])) return;
            if (await spawnDetached('gio', ['open', parent])) return;
        }
    }

    await openDirectoryInDefaultFileManager(path.dirname(target));
}



type BackgroundGuard = { timer: NodeJS.Timeout; busy: boolean; lastMode: string; affected: number; startedAt: number; stopped: boolean };
const detectedGames = new Map<GameId, GameDefinition>();
const backgroundGuards = new Map<GameId, BackgroundGuard>();
const managedGameSessions = new Set<GameId>();
const splitRestoreProgress = new Map<GameId, cloudFs.SplitRestoreProgress>();
const pendingIndexSnapshots = new Map<GameId, cloudIndex.CloudIndexSnapshot>();
const carrierHydratedSessions = new Set<GameId>();
const EMPTY_INSTALL_INFO: steam.InstallInfo = {
    installed: false,
    installing: false,
    library: null,
    manifest: null,
    installDir: null,
    sizeOnDisk: 0
};
let quitCleanupStarted = false;
let quitCleanupFinished = false;
let rendererClosePending = false;
let rendererCloseApproved = false;
let rendererQuitRequested = false;
let catalogBackgroundStarted = false;

function gameById(id: GameId): GameDefinition {
    const game = detectedGames.get(id);
    if (!game) throw new Error('Unknown or no longer detected Steam Cloud.');
    return game;
}

function replaceDetectedGames(games: GameDefinition[]): void {
    detectedGames.clear();
    for (const game of games) detectedGames.set(game.id, game);
}

function mergeDetectedGames(localGames: GameDefinition[], externalGames: GameDefinition[]): GameDefinition[] {
    const merged = new Map<string, GameDefinition>();
    for (const game of externalGames) {
        if (game.discoverySource !== 'catalog' || !game.isFreeApp || game.storePriceCents !== 0) continue;
        merged.set(game.appId, game);
    }
    for (const game of localGames) {
        if (game.discoverySource !== 'local') continue;
        merged.set(game.appId, game);
    }
    return [...merged.values()];
}

function splitCacheRoot(id: GameId): string {
    return path.join(app.getPath('userData'), 'split-cache', id);
}

function carrierWorkspaceRoot(id: GameId): string {
    return path.join(app.getPath('userData'), 'carrier-workspaces', id);
}

function physicalCloudRoot(
    game: GameDefinition,
    env: Awaited<ReturnType<typeof getEnvironment>>,
    install: steam.InstallInfo
): string | null {
    return game.getCloudRoot({
        steamLibraries: env.libraries,
        steamId64: env.steamId64,
        installedLibrary: install.library,
        installedDir: install.installDir
    });
}

function logicalCloudRoot(game: GameDefinition, physicalRoot: string | null): string | null {
    if (!physicalRoot) return null;
    return game.storageMode === 'carrier' ? carrierWorkspaceRoot(game.id) : physicalRoot;
}

async function getEnvironment() {
    const steamRoot = await steam.detectSteamRoot();
    const libraries = await steam.detectLibraries(steamRoot);
    const steamId64 = await steam.detectSteamId64(steamRoot);
    return { steamRoot, libraries, steamId64 };
}


async function describeImportPaths(inputPaths: string[]): Promise<protectedPools.ImportSelection[]> {
    const output: protectedPools.ImportSelection[] = [];
    const seen = new Set<string>();

    const addFile = async (sourcePath: string, relativePath: string) => {
        const stat = await fs.promises.stat(sourcePath);
        if (!stat.isFile()) return;
        const portable = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!portable || portable.split('/').some((part) => !part || part === '.' || part === '..')) return;
        const key = process.platform === 'win32' ? portable.toLowerCase() : portable;
        if (seen.has(key)) throw new Error(`Two dropped items target the same path: “${portable}”.`);
        seen.add(key);
        output.push({
            sourcePath,
            relativePath: portable,
            name: path.basename(portable),
            size: stat.size
        });
        if (output.length > 10_000) throw new Error('Import is limited to 10,000 files at once.');
    };

    const walk = async (absolute: string, relative: string): Promise<void> => {
        const stat = await fs.promises.stat(absolute);
        if (stat.isFile()) {
            await addFile(absolute, relative);
            return;
        }
        if (!stat.isDirectory()) return;
        const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() && !entry.isDirectory()) continue;
            await walk(path.join(absolute, entry.name), path.join(relative, entry.name));
        }
    };

    for (const raw of inputPaths) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const absolute = path.resolve(raw);
        const stat = await fs.promises.stat(absolute);
        if (stat.isDirectory()) await walk(absolute, path.basename(absolute));
        else if (stat.isFile()) await addFile(absolute, path.basename(absolute));
    }
    return output;
}

function protectionForRenderer(descriptor: protectedPools.ProtectionDescriptor | null) {
    if (!descriptor) return undefined;
    return {
        ...descriptor,
        memberNames: descriptor.memberGameIds.map((id) => detectedGames.get(id)?.name ?? id)
    };
}

function ensureCatalogBackgroundRefresh(steamRoot: string | null): void {
    if (!steamRoot || catalogBackgroundStarted) return;
    catalogBackgroundStarted = true;
    const cacheDir = path.join(app.getPath('userData'), 'catalog-cache');

    void (async () => {
        const cachedIndex = path.join(cacheDir, 'cloud-catalog.json');
        const bundledIndex = path.join(app.getAppPath(), 'assets', 'data', 'cloud-catalog.json');
        try {
            await fs.promises.access(cachedIndex);
        } catch {
            try {
                await fs.promises.mkdir(cacheDir, { recursive: true });
                await fs.promises.copyFile(bundledIndex, cachedIndex);
            } catch {
            }
        }
        await startExternalCatalogDiscovery(cacheDir, steamRoot);
    })();

}


async function stopBackgroundGuard(id: GameId): Promise<boolean> {
    const guard = backgroundGuards.get(id);
    if (guard) {
        guard.stopped = true;
        clearTimeout(guard.timer);
        backgroundGuards.delete(id);
    }
    carrierHydratedSessions.delete(id);
    try {
        await steam.cleanupBackgroundApp(gameById(id));
    } catch {
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
    }
}

function applyFullscreenPriority(enabled: boolean) {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    try {
        mainWindow.setAlwaysOnTop(enabled, enabled ? 'screen-saver' : 'normal', enabled ? 1 : 0);
    } catch {
    }

    if (process.platform !== 'win32') {
        try {
            mainWindow.setVisibleOnAllWorkspaces(enabled, { visibleOnFullScreen: enabled });
        } catch {
        }
    }

    if (enabled) {
        try { mainWindow.setFocusable(true); } catch {}
        refocusVaporStow();
    }
}

async function startBackgroundGuard(id: GameId) {
    await stopBackgroundGuard(id);
    carrierHydratedSessions.delete(id);
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
        const age = Date.now() - guard.startedAt;
        const delay = age < 15_000 ? 60 : 400;
        guard.timer = setTimeout(async () => {
            await tick();
            schedule();
        }, delay);
    };

    await tick();
    backgroundGuards.set(id, guard);
    managedGameSessions.add(id);
    schedule();

    return { started: true, mode: guard.lastMode, affected: guard.affected, prepared: prepared.prepared };
}

type UsageMemoryEntry = {
    cloudBytes?: number;
    cloudFiles?: number;
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
    memory: UsageMemory,
    options: {
        install?: steam.InstallInfo;
        running?: boolean;
        deep?: boolean;
        inLibrary?: boolean;
    } = {}
) {
    const install = options.install ?? await steam.findInstalledApp(env.libraries, game.appId);
    const running = options.running ?? (install.installed ? await steam.isAppRunning(game, install) : false);
    const physicalRoot = physicalCloudRoot(game, env, install);
    const cloudRoot = logicalCloudRoot(game, physicalRoot);
    const cloudRootExists = Boolean(physicalRoot && fs.existsSync(physicalRoot));
    const inspectStorage = options.deep ?? true;

    let disk: { free: number; total: number } | null = null;
    let audit = { root: cloudRoot ? path.join(cloudRoot, 'CloudAudit') : null, bytes: 0, files: 0 };
    let cloud = { bytes: 0, files: 0 };
    if (inspectStorage && cloudRoot) {
        try {
            disk = await cloudFs.statFsFor(physicalRoot ?? cloudRoot);
        } catch {
            disk = null;
        }
        audit = await cloudFs.listAuditTree(cloudRoot);
        if (physicalRoot) cloud = await cloudFs.treeStats(physicalRoot);
    }
    const remembered = memory[game.id];
    const hasProtectedFiles = await protectedPools.hasProtectedFiles(game.id);
    const protectedCorrupt = await protectedPools.isGameInaccessible(game.id);

    return {
        id: game.id,
        appId: game.appId,
        name: game.name,
        volumeName: game.volumeName,
        quotaBytes: game.quotaBytes,
        maxFiles: game.maxFiles,
        cloudPattern: game.cloudPattern,
        storageMode: game.storageMode,
        cloudRuleCount: game.cloudRules.length,
        discoverySource: game.discoverySource,
        isFreeApp: game.isFreeApp,
        storePriceCents: game.storePriceCents,
        storePriceLabel: game.storePriceLabel,
        artworkUrls: game.artworkUrls,
        platformSupported: game.platforms.includes(process.platform),
        nativeCloudSupport: game.nativeCloudPlatforms.includes(process.platform),
        protonExperimental: Boolean(game.protonExperimental && process.platform === 'linux'),
        inLibrary: options.inLibrary ?? install.installed,
        installed: install.installed,
        installing: install.installing,
        installDir: install.installDir,
        installSize: install.installed && install.sizeOnDisk > 0
            ? install.sizeOnDisk
            : game.installSizeFallbackBytes > 0
                ? game.installSizeFallbackBytes
                : install.sizeOnDisk,
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
        hasProtectedFiles,
        protectedCorrupt,
        disk
    };
}

async function fullStatus() {
    const env = await getEnvironment();
    const memory = await readUsageMemory();
    const steamRunning = Boolean(env.steamRoot) && await steam.isSteamRunning();
    const steamCloudLog = await steam.detectCloudLogPath(env.steamRoot);
    const localGames = await discoverSteamCloudGames(env.steamRoot, env.libraries, env.steamId64);

    const [installedApps, libraryAppIds] = await Promise.all([
        steam.scanInstalledApps(env.libraries),
        steam.scanLibraryAppIds(env.steamRoot, env.steamId64)
    ]);
    for (const appId of installedApps.keys()) libraryAppIds.add(appId);

    const games = mergeDetectedGames(localGames, currentExternalCatalogGames());
    replaceDetectedGames(games);

    const installedEntries = games.flatMap((game) => {
        const install = installedApps.get(game.appId);
        return install?.installed ? [{ game, install }] : [];
    });
    const runningGameIds = await steam.detectRunningGameIds(installedEntries);

    const statuses = await Promise.all(games.map((game) => {
        const install = installedApps.get(game.appId) ?? EMPTY_INSTALL_INFO;
        const running = runningGameIds.has(game.id);
        return gameStatus(game, env, memory, {
            install,
            running,
            inLibrary: libraryAppIds.has(game.appId),
            deep: running
        });
    }));

    return {
        appVersion: app.getVersion(),
        platform: process.platform,
        steamInstalled: Boolean(env.steamRoot),
        steamRunning,
        steamRoot: env.steamRoot,
        steamCloudLog,
        steamId64: env.steamId64,
        catalogDiscovery: currentExternalCatalogStats(),
        games: statuses
    };
}

async function resolveGameCloud(id: GameId) {
    const game = gameById(id);
    const env = await getEnvironment();
    const install = await steam.findInstalledApp(env.libraries, game.appId);
    const status = await gameStatus(game, env, await readUsageMemory(), { install });
    const physicalRoot = physicalCloudRoot(game, env, install);

    if (!status.cloudRoot || !physicalRoot) {
        throw new Error('No local Auto-Cloud path is available for this game on the current platform.');
    }

    return { game, env, install, status, physicalRoot };
}

async function requireRunningGame(id: GameId) {
    const resolved = await resolveGameCloud(id);
    if (!resolved.status.running) {
        throw new Error('The Steam session is not open for this volume.');
    }
    return resolved;
}




function registerIpc() {
    ipcMain.handle('status:get', fullStatus);
    ipcMain.handle('catalog:start-background', async () => {
        const env = await getEnvironment();
        ensureCatalogBackgroundRefresh(env.steamRoot);
        return true;
    });
    ipcMain.handle('catalog:search', async (_event, criteria: ExternalCatalogSearchCriteria = {}) => {
        const env = await getEnvironment();
        const steamId64 = await steam.detectSteamId64(env.steamRoot);
        const libraryAppIds = await steam.scanLibraryAppIds(env.steamRoot, steamId64);
        if (env.steamRoot) {
            const installedApps = await steam.scanInstalledApps(await steam.detectLibraries(env.steamRoot));
            for (const [appId, install] of installedApps) {
                if (install.installed) libraryAppIds.add(appId);
            }
        }
        const outsideCriteria: ExternalCatalogSearchCriteria = {
            ...criteria,
            excludeAppIds: [...libraryAppIds]
        };

        await refreshExternalCatalogDiscovery(
            path.join(app.getPath('userData'), 'catalog-cache'),
            env.steamRoot,
            outsideCriteria
        );
        return fullStatus();
    });

    ipcMain.handle('steam:download', async () => {
        await shell.openExternal('https://store.steampowered.com/about/');
    });

    ipcMain.handle('github:open-profile', async (_event, username: string) => {
        const allowed = new Map([
            ['nullmess', 'nullmess'],
            ['ybucaille', 'Ybucaille']
        ]);
        const canonical = allowed.get(String(username).toLowerCase());
        if (!canonical) throw new Error('Unknown GitHub profile.');
        await shell.openExternal(`https://github.com/${canonical}`);
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
        if (!steamRoot) throw new Error('Steam is not installed.');
        if (!await steam.isSteamRunning()) throw new Error('Steam is not running. Start Steam before installing a game.');

        const steamId64 = await steam.detectSteamId64(steamRoot);
        const libraryAppIds = await steam.scanLibraryAppIds(steamRoot, steamId64);
        const installed = await steam.findInstalledApp(await steam.detectLibraries(steamRoot), game.appId);
        const inLibrary = installed.installed || libraryAppIds.has(game.appId);

        if (!inLibrary && game.discoverySource === 'catalog') {
            if (steamRoot) await shell.openExternal(`steam://store/${game.appId}`);
            else await shell.openExternal(game.storeUrl);
            return;
        }
        await shell.openExternal(steamRoot ? game.steamInstallUrl : game.storeUrl);
    });

    ipcMain.handle('game:run', async (_event, id: GameId) => {
        const game = gameById(id);
        const env = await getEnvironment();
        const launched = await steam.launchAppBackground(env.steamRoot, game.appId, game.launchArgs ?? []);
        if (!launched) {
            const launchSuffix = game.launchArgs?.length
                ? `//${game.launchArgs.map((arg) => encodeURIComponent(arg)).join('%20')}/`
                : '';
            await shell.openExternal(`${game.steamRunUrl}${launchSuffix}`);
        }
    });

    ipcMain.handle('game:background-start', async (_event, id: GameId) => startBackgroundGuard(id));

    ipcMain.handle('game:background-stop', async (_event, id: GameId) => {
        managedGameSessions.delete(id);
        return stopBackgroundGuard(id);
    });

    ipcMain.handle('game:is-running', async (_event, id: GameId) => {
        const game = gameById(id);
        const env = await getEnvironment();
        const install = await steam.findInstalledApp(env.libraries, game.appId);
        if (!install.installed) return false;
        return steam.isAppRunning(game, install);
    });

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

    const prepareCloudForSync = async (id: GameId, requireRunning: boolean) => {
        const resolved = requireRunning ? await requireRunningGame(id) : await resolveGameCloud(id);
        const { game, status, physicalRoot } = resolved;
        const preparation = await cloudFs.prepareSplitFilesForSync(
            status.cloudRoot!,
            game.quotaBytes,
            game.maxFiles,
            splitCacheRoot(id)
        );
        if (game.storageMode === 'carrier') {
            const rule = game.cloudRules[0];
            if (!rule) throw new Error('No compatible Steam Cloud carrier rule is available.');
            await carrierStorage.packWorkspace(
                status.cloudRoot!,
                physicalRoot,
                rule.pattern,
                rule.recursive,
                game.quotaBytes,
                game.maxFiles
            );
        }
        return preparation;
    };

    ipcMain.handle('cloud:prepare-sync', async (_event, id: GameId) => prepareCloudForSync(id, true));

    // Used only when a managed game was closed outside VaporStow. The local
    // Cloud still needs to be converted back to its Steam-safe representation
    // before Steam finishes the post-exit upload.
    ipcMain.handle('cloud:prepare-sync-offline', async (_event, id: GameId) => prepareCloudForSync(id, false));

    ipcMain.handle('cloud:content-summary', async (_event, id: GameId) => {
        const { status } = await requireRunningGame(id);
        return cloudFs.cloudContentSummary(status.cloudRoot!);
    });

    ipcMain.handle('cloud:audit-usage', async (_event, id: GameId) => {
        const game = gameById(id);
        const env = await getEnvironment();
        const status = await gameStatus(game, env, await readUsageMemory(), { deep: true });
        return { bytes: status.auditBytes, files: status.auditFiles };
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
        const { game, status, physicalRoot } = await requireRunningGame(id);
        splitRestoreProgress.delete(id);
        if (game.storageMode === 'carrier' && !carrierHydratedSessions.has(id)) {
            await carrierStorage.restoreWorkspace(physicalRoot, status.cloudRoot!);
            carrierHydratedSessions.add(id);
        }
        const restored = await cloudFs.restoreSplitFiles(
            status.cloudRoot!,
            splitCacheRoot(id),
            (progress) => splitRestoreProgress.set(id, progress)
        );
        // Remove stale data from replaced/dissolved protected pools before
        // reading manifests, otherwise an old member could resurrect metadata.
        await protectedPools.cleanupRetiredPoolsFromCloud(id, status.cloudRoot!).catch(() => ({ removed: 0 }));
        await protectedPools.ingestManifests(status.cloudRoot!).catch(() => 0);
        return restored;
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
                installedLibrary: install.library,
                installedDir: install.installDir
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
        const term = typeof query === 'string' ? query : '';
        const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(240, Math.floor(limit!))) : 120;
        const base = cloudIndex.search(term, 240);
        const enriched: Array<(typeof base)[number] & { protection?: ReturnType<typeof protectionForRenderer> }> = [];
        for (const entry of base) {
            if (await protectedPools.isPathPendingDeletion(entry.gameId, entry.path)) continue;
            enriched.push({
                ...entry,
                protection: protectionForRenderer(await protectedPools.descriptorFor(entry.gameId, entry.path))
            });
        }
        const known = new Set(enriched.map((entry) => `${entry.gameId}:${entry.path}`));
        const virtual: Array<(typeof enriched)[number]> = [];
        for (const game of detectedGames.values()) {
            const entries = await protectedPools.virtualSearch(game.id, term);
            for (const entry of entries) {
                const key = `${game.id}:${entry.path}`;
                if (known.has(key)) continue;
                known.add(key);
                virtual.push({
                    ...entry,
                    gameId: game.id,
                    gameName: game.name,
                    volumeName: game.volumeName,
                    cachedAt: new Date().toISOString(),
                    protection: protectionForRenderer(entry.protection)
                });
            }
        }
        const combined = [...enriched, ...virtual];
        const deduplicated: typeof combined = [];
        const logicalProtected = new Set<string>();
        for (const entry of combined) {
            const protection = entry.protection;
            if (protection && entry.type === 'file') {
                const logicalKey = `${protection.poolId}:${String(entry.path).replace(/\\/g, '/')}`;
                if (logicalProtected.has(logicalKey)) continue;
                logicalProtected.add(logicalKey);
            }
            deduplicated.push(entry);
            if (deduplicated.length >= normalizedLimit) break;
        }
        return deduplicated;
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
        const listing = await cloudFs.listAuditDirectory(status.cloudRoot!, relativeDirectory || '');
        const entries: Array<cloudFs.AuditEntry & { protection?: ReturnType<typeof protectionForRenderer>; virtualProtected?: boolean }> = [];
        for (const entry of listing.entries) {
            if (await protectedPools.isPathPendingDeletion(id, entry.path)) continue;
            entries.push({
                ...entry,
                protection: protectionForRenderer(await protectedPools.descriptorFor(id, entry.path))
            });
        }
        const known = new Set(entries.map((entry) => entry.path.replace(/\\/g, '/')));
        const virtual = await protectedPools.virtualEntriesForDirectory(id, listing.directory);
        for (const entry of virtual) {
            if (known.has(entry.path)) continue;
            entries.push({ ...entry, protection: protectionForRenderer(entry.protection), virtualProtected: true });
        }
        entries.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
        return { ...listing, entries };
    });

    ipcMain.handle('cloud:select-import-files', async (_event, id: GameId) => {
        const game = gameById(id);
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: `Import files · ${game.name}`,
            properties: ['openFile', 'multiSelections']
        });
        if (result.canceled || result.filePaths.length === 0) return { canceled: true, files: [] };
        return { canceled: false, files: await describeImportPaths(result.filePaths) };
    });

    ipcMain.handle('cloud:describe-import-paths', async (_event, inputPaths: string[]) => {
        if (!Array.isArray(inputPaths)) throw new Error('Invalid dropped file list.');
        return describeImportPaths(inputPaths);
    });

    ipcMain.handle('cloud:import-selected-files', async (_event, id: GameId, relativeDirectory: string, files: protectedPools.ImportSelection[]) => {
        const { game, status } = await requireRunningGame(id);
        if (!Array.isArray(files) || files.length === 0) throw new Error('Select at least one file.');
        const mapped = files.map((file) => ({ source: file.sourcePath, relativePath: file.relativePath }));
        await cloudFs.importMappedFiles(status.cloudRoot!, relativeDirectory || '', mapped, game.quotaBytes, game.maxFiles);
        return { canceled: false, imported: files.length };
    });

    ipcMain.handle('protected:create-pool', async (_event, mode: protectedPools.ProtectedImportMode, originId: GameId, memberIds: GameId[], relativeDirectory: string, files: protectedPools.ImportSelection[]) => {
        await requireRunningGame(originId);
        if (mode !== 'mirror' && mode !== 'reed-solomon') throw new Error('Invalid protected storage mode.');
        if (!Array.isArray(memberIds)) throw new Error('Invalid Cloud selection.');
        const env = await getEnvironment();
        for (const memberId of memberIds) {
            const member = gameById(memberId);
            const install = await steam.findInstalledApp(env.libraries, member.appId);
            const status = await gameStatus(member, env, await readUsageMemory(), { install, deep: false });
            if (!status.platformSupported) {
                throw new Error(`${member.name} is not supported on this platform.`);
            }
            if (status.installing) {
                throw new Error(`${member.name} is still installing.`);
            }
            if (!status.installed) {
                throw new Error(`${member.name} must be installed before it can join protected storage.`);
            }
            if (!status.cloudRoot || (!status.cloudRootExists && status.rememberedBytes === null)) {
                throw new Error(`${member.name} must be opened and synchronized once before it can join protected storage.`);
            }
            if (!protectedPools.isProtectedCloudEligible(member.quotaBytes, member.maxFiles)) {
                throw new Error(`${member.name} requires at least 93 GiB of Steam Cloud quota and 10,000 file slots for protected storage.`);
            }
            if (memberId !== originId && status.running) {
                throw new Error(`${member.name} is already running. Close it before starting a protected import.`);
            }
        }
        const pool = await protectedPools.createPool(mode, originId, memberIds, relativeDirectory || '', files);
        return {
            id: pool.id,
            mode: pool.mode,
            memberGameIds: pool.memberGameIds,
            layout: pool.layout ?? null,
            fileCount: pool.files.length,
            totalBytes: pool.files.reduce((sum, file) => sum + file.size, 0)
        };
    });

    ipcMain.handle('protected:deploy', async (_event, poolId: string, id: GameId) => {
        const { game, status } = await requireRunningGame(id);
        return protectedPools.deployToCloud(poolId, id, status.cloudRoot!, game.quotaBytes, game.maxFiles);
    });

    ipcMain.handle('protected:finalize', async (_event, poolId: string) => {
        const pool = await protectedPools.finalizePool(poolId);
        return { id: pool.id, state: pool.state };
    });

    ipcMain.handle('protected:stage-delete', async (_event, poolId: string, logicalPath: string) => {
        return protectedPools.stageEntryDeletion(poolId, logicalPath);
    });

    ipcMain.handle('protected:pending-deletions', async (_event, id: GameId) => {
        gameById(id);
        return protectedPools.pendingEntryDeletionsForGame(id);
    });

    ipcMain.handle('protected:delete-entry', async (_event, poolId: string, id: GameId, logicalPath: string) => {
        const { status } = await requireRunningGame(id);
        return protectedPools.deleteEntryFromCloud(poolId, id, status.cloudRoot!, logicalPath);
    });

    ipcMain.handle('protected:finalize-delete', async (_event, poolId: string, logicalPath: string) => {
        return protectedPools.finalizeEntryDeletion(poolId, logicalPath);
    });

    ipcMain.handle('protected:mark-degraded', async (_event, poolId: string) => {
        await protectedPools.markPoolDegraded(poolId);
        return true;
    });


    ipcMain.handle('protected:rs-members', async (_event, id: GameId) => {
        gameById(id);
        return protectedPools.reedSolomonMemberIdsForGame(id);
    });

    ipcMain.handle('protected:repair-members', async (_event, id: GameId) => {
        gameById(id);
        return protectedPools.protectedRepairMemberIdsForGame(id);
    });

    ipcMain.handle('protected:mark-inaccessible', async (_event, id: GameId) => {
        gameById(id);
        return protectedPools.markGameInaccessible(id);
    });

    ipcMain.handle('protected:mark-accessible', async (_event, id: GameId) => {
        gameById(id);
        return protectedPools.markGameAccessible(id);
    });

    ipcMain.handle('protected:repair-issue', async (_event, id: GameId) => {
        gameById(id);
        return protectedPools.repairIssueForGame(id);
    });

    const repairCloudRoots = async (ids: GameId[]) => {
        const env = await getEnvironment();
        const roots: Partial<Record<GameId, string>> = {};
        for (const id of ids) {
            const game = gameById(id);
            const install = await steam.findInstalledApp(env.libraries, game.appId);
            const physicalRoot = physicalCloudRoot(game, env, install);
            const root = logicalCloudRoot(game, physicalRoot);
            if (root && fs.existsSync(root)) roots[id] = root;
        }
        return roots;
    };

    ipcMain.handle('protected:repair-replacement', async (_event, triggerId: GameId, corruptId: GameId, replacementId: GameId) => {
        gameById(triggerId);
        gameById(corruptId);
        const replacement = gameById(replacementId);
        if (!protectedPools.isProtectedCloudEligible(replacement.quotaBytes, replacement.maxFiles)) {
            throw new Error('Replacement storage requires at least 93 GiB of Steam Cloud quota and 10,000 file slots.');
        }
        const env = await getEnvironment();
        const replacementInstall = await steam.findInstalledApp(env.libraries, replacement.appId);
        const replacementStatus = await gameStatus(replacement, env, await readUsageMemory(), { install: replacementInstall, deep: false });
        if (!replacementStatus.platformSupported || replacementStatus.installing || !replacementStatus.installed || !replacementStatus.cloudRoot) {
            throw new Error('The replacement Cloud is not ready.');
        }
        if (replacementStatus.protectedCorrupt) throw new Error('A corrupt Cloud cannot be used as a replacement.');
        const issue = await protectedPools.repairIssueForGame(triggerId);
        if (!issue || !issue.corruptGameIds.includes(corruptId)) throw new Error('The selected Cloud is not marked corrupt for this pool.');
        const roots = await repairCloudRoots(issue.memberGameIds);
        return protectedPools.prepareReplacementRepair(triggerId, corruptId, replacementId, roots);
    });

    ipcMain.handle('protected:repair-gather-prepare', async (_event, triggerId: GameId, destinationId: GameId) => {
        gameById(triggerId);
        const destination = gameById(destinationId);
        const issue = await protectedPools.repairIssueForGame(triggerId);
        if (!issue) throw new Error('No degraded protected pool requires repair.');
        const env = await getEnvironment();
        const destinationInstall = await steam.findInstalledApp(env.libraries, destination.appId);
        const destinationStatus = await gameStatus(destination, env, await readUsageMemory(), { install: destinationInstall, deep: false });
        if (!destinationStatus.platformSupported || destinationStatus.installing || !destinationStatus.installed || !destinationStatus.cloudRoot) {
            throw new Error('The selected Cloud is not ready for repaired files.');
        }
        if (destinationStatus.protectedCorrupt) throw new Error('A corrupt Cloud cannot receive repaired files.');
        const usedBytes = destinationStatus.rememberedBytes ?? destinationStatus.auditBytes ?? 0;
        const usedFiles = destinationStatus.rememberedFiles ?? destinationStatus.auditFiles ?? 0;
        if (destination.quotaBytes - usedBytes < issue.totalBytes || destination.maxFiles - usedFiles < issue.fileCount) {
            throw new Error('The selected Cloud does not have enough capacity for the repaired files.');
        }
        const roots = await repairCloudRoots(issue.memberGameIds);
        return protectedPools.prepareGatherRepair(triggerId, destinationId, roots);
    });

    ipcMain.handle('protected:repair-gather-apply', async (_event, planId: string, id: GameId) => {
        const { game, status } = await requireRunningGame(id);
        return protectedPools.applyGatherRepairToDestination(planId, id, status.cloudRoot!, game.quotaBytes, game.maxFiles);
    });

    ipcMain.handle('protected:repair-gather-cleanup', async (_event, planId: string, id: GameId) => {
        const { status } = await requireRunningGame(id);
        return protectedPools.cleanupGatherRepairFromCloud(planId, id, status.cloudRoot!);
    });

    ipcMain.handle('protected:repair-gather-finalize', async (_event, planId: string) => {
        return protectedPools.finalizeGatherRepair(planId);
    });

    ipcMain.handle('protected:cleanup-retired', async (_event, id: GameId) => {
        const { status } = await requireRunningGame(id);
        return protectedPools.cleanupRetiredPoolsFromCloud(id, status.cloudRoot!);
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
        const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (normalized === protectedPools.PROTECTED_LIBRARY_FOLDER) {
            throw new Error('VaporStow Protected is managed automatically and cannot be deleted manually.');
        }
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

    ipcMain.handle('window:toggle-fullscreen', async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        const next = !mainWindow.isFullScreen();
        applyFullscreenPriority(next);
        mainWindow.setFullScreen(next);
        if (next) applyFullscreenPriority(true);
        return next;
    });

    ipcMain.handle('window:is-fullscreen', async () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()));

    ipcMain.on('window:request-close', () => requestRendererClose(false));

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


function createWindow() {
    rendererClosePending = false;
    rendererCloseApproved = false;
    rendererQuitRequested = false;

    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const width = Math.min(workArea.width - 24, Math.max(960, Math.floor(workArea.width * 0.88)));
    const height = Math.min(workArea.height - 24, Math.max(620, Math.floor(workArea.height * 0.86)));

    mainWindow = new BrowserWindow({
        width,
        height,
        center: true,
        minWidth: 760,
        minHeight: 520,
        resizable: true,
        maximizable: true,
        fullscreenable: true,
        backgroundColor: '#0b0c0e',
        ...(process.platform === 'linux'
            ? { frame: false }
            : {
                titleBarStyle: 'hidden' as const,
                ...(process.platform === 'win32'
                    ? { titleBarOverlay: { color: '#0b0c0e', symbolColor: '#777a80', height: 34 } }
                    : {})
            }),
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

    mainWindow.setMinimumSize(760, 520);
    mainWindow.setResizable(true);
    mainWindow.setMaximizable(true);
    mainWindow.setFullScreenable(true);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.on('enter-full-screen', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        applyFullscreenPriority(true);
        mainWindow.webContents.send('window:fullscreen-changed', true);
    });
    mainWindow.on('leave-full-screen', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        applyFullscreenPriority(false);
        mainWindow.webContents.send('window:fullscreen-changed', false);
    });
    mainWindow.on('blur', () => {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFullScreen()) return;
        setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFullScreen()) return;
            applyFullscreenPriority(true);
        }, 30).unref();
    });
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
                installedLibrary: install.library,
                installedDir: install.installDir
            });

            if (cloudRoot) {
                try {
                    const logicalRoot = logicalCloudRoot(game, cloudRoot)!;
                    await cloudFs.prepareSplitFilesForSync(
                        logicalRoot,
                        game.quotaBytes,
                        game.maxFiles,
                        splitCacheRoot(id)
                    );
                    if (game.storageMode === 'carrier') {
                        const rule = game.cloudRules[0];
                        if (!rule) throw new Error('No compatible Steam Cloud carrier rule is available.');
                        await carrierStorage.packWorkspace(
                            logicalRoot,
                            cloudRoot,
                            rule.pattern,
                            rule.recursive,
                            game.quotaBytes,
                            game.maxFiles
                        );
                    }
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

    if (managedGameSessions.size > 0 && mainWindow && !mainWindow.isDestroyed()) {
        event.preventDefault();
        requestRendererClose(true);
        return;
    }

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
