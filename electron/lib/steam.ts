import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { GameDefinition } from '../config/games';

const execFileAsync = promisify(execFile);

type ProcessInfo = { pid: number; ppid: number; command: string };

export type InstallInfo = {
    installed: boolean;
    installing: boolean;
    library: string | null;
    manifest: string | null;
    installDir: string | null;
    sizeOnDisk: number;
};

export function exists(target: string | null | undefined): boolean {
    try {
        return Boolean(target && fs.existsSync(target));
    } catch {
        return false;
    }
}

function uniquePaths(items: Array<string | null | undefined>): string[] {
    return [...new Set(items.filter(Boolean).map((item) => path.normalize(item as string)))];
}

async function windowsRegistrySteamPath(): Promise<string | null> {
    if (process.platform !== 'win32') return null;

    try {
        const { stdout } = await execFileAsync(
            'reg',
            ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
            { windowsHide: true }
        );
        return stdout.match(/SteamPath\s+REG_SZ\s+(.+)$/mi)?.[1]?.trim() || null;
    } catch {
        return null;
    }
}

// Détection de Steam, libraries et installations.

export async function detectSteamRoot(): Promise<string | null> {
    const home = os.homedir();
    const candidates: Array<string | null | undefined> = [process.env.STEAM_DIR];

    if (process.platform === 'win32') {
        candidates.push(await windowsRegistrySteamPath());
        if (process.env['PROGRAMFILES(X86)']) {
            candidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Steam'));
        }
        if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, 'Steam'));
    } else if (process.platform === 'darwin') {
        candidates.push(path.join(home, 'Library', 'Application Support', 'Steam'));
    } else {
        candidates.push(
            path.join(home, '.local', 'share', 'Steam'),
            path.join(home, '.steam', 'steam'),
            path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
            path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
            path.join(home, 'snap', 'steam', 'common', '.steam', 'root')
        );
    }

    for (const candidate of uniquePaths(candidates)) {
        if (exists(path.join(candidate, 'steamapps'))) return candidate;
    }

    return null;
}


export async function launchSteamBackground(steamRoot: string | null): Promise<boolean> {
    type LaunchCandidate = { executable: string; args: string[] };
    const candidates: LaunchCandidate[] = [];

    if (process.platform === 'win32') {
        if (steamRoot) candidates.push({ executable: path.join(steamRoot, 'steam.exe'), args: ['-silent'] });
    } else if (process.platform === 'darwin') {
        if (steamRoot) {
            candidates.push({
                executable: path.join(steamRoot, 'Steam.AppBundle', 'Steam', 'Contents', 'MacOS', 'steam_osx'),
                args: ['-silent']
            });
        }
        candidates.push({ executable: '/Applications/Steam.app/Contents/MacOS/steam_osx', args: ['-silent'] });
    } else {
        if (steamRoot?.includes(`${path.sep}.var${path.sep}app${path.sep}com.valvesoftware.Steam${path.sep}`)) {
            candidates.push({ executable: 'flatpak', args: ['run', 'com.valvesoftware.Steam', '-silent'] });
        }
        if (steamRoot?.includes(`${path.sep}snap${path.sep}steam${path.sep}`)) {
            candidates.push({ executable: 'snap', args: ['run', 'steam', '-silent'] });
        }
        if (steamRoot) {
            candidates.push({ executable: path.join(steamRoot, 'steam.sh'), args: ['-silent'] });
            candidates.push({ executable: path.join(steamRoot, 'ubuntu12_32', 'steam'), args: ['-silent'] });
        }
        candidates.push({ executable: '/usr/bin/steam', args: ['-silent'] });
        candidates.push({ executable: '/usr/bin/steam-native', args: ['-silent'] });
    }

    for (const candidate of candidates) {
        const absoluteCandidate = path.isAbsolute(candidate.executable);
        if (absoluteCandidate && !exists(candidate.executable)) continue;
        if (!absoluteCandidate && !(await commandAvailable(candidate.executable))) continue;

        try {
            const child = spawn(candidate.executable, candidate.args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();
            return true;
        } catch {
            // Tester le mode d'installation Steam suivant.
        }
    }

    return false;
}

export async function launchAppBackground(steamRoot: string | null, appId: string): Promise<boolean> {
    type LaunchCandidate = { executable: string; args: string[] };
    const candidates: LaunchCandidate[] = [];

    if (process.platform === 'win32') {
        if (steamRoot) candidates.push({ executable: path.join(steamRoot, 'steam.exe'), args: ['-silent', '-applaunch', appId] });
    } else if (process.platform === 'darwin') {
        if (steamRoot) {
            candidates.push({
                executable: path.join(steamRoot, 'Steam.AppBundle', 'Steam', 'Contents', 'MacOS', 'steam_osx'),
                args: ['-silent', '-applaunch', appId]
            });
        }
        candidates.push({ executable: '/Applications/Steam.app/Contents/MacOS/steam_osx', args: ['-silent', '-applaunch', appId] });
    } else {
        // Préférer le launcher cohérent avec le Steam root détecté.
        if (steamRoot?.includes(`${path.sep}.var${path.sep}app${path.sep}com.valvesoftware.Steam${path.sep}`)) {
            candidates.push({ executable: 'flatpak', args: ['run', 'com.valvesoftware.Steam', '-silent', '-applaunch', appId] });
        }
        if (steamRoot?.includes(`${path.sep}snap${path.sep}steam${path.sep}`)) {
            candidates.push({ executable: 'snap', args: ['run', 'steam', '-silent', '-applaunch', appId] });
        }
        if (steamRoot) {
            candidates.push({ executable: path.join(steamRoot, 'steam.sh'), args: ['-silent', '-applaunch', appId] });
            candidates.push({ executable: path.join(steamRoot, 'ubuntu12_32', 'steam'), args: ['-silent', '-applaunch', appId] });
        }
        candidates.push({ executable: '/usr/bin/steam', args: ['-silent', '-applaunch', appId] });
        candidates.push({ executable: '/usr/bin/steam-native', args: ['-silent', '-applaunch', appId] });
    }

    for (const candidate of candidates) {
        const absoluteCandidate = path.isAbsolute(candidate.executable);
        if (absoluteCandidate && !exists(candidate.executable)) continue;
        if (!absoluteCandidate && !(await commandAvailable(candidate.executable))) continue;

        try {
            const child = spawn(candidate.executable, candidate.args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();
            return true;
        } catch {
            // Tester le mode d'installation Steam suivant.
        }
    }

    return false;
}

function decodeVdfPath(raw: string): string {
    return raw.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

export async function detectLibraries(steamRoot: string | null): Promise<string[]> {
    if (!steamRoot) return [];

    const libraries = [steamRoot];
    const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');

    try {
        const text = await fsp.readFile(vdf, 'utf8');
        const pattern = /"path"\s+"([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text))) libraries.push(decodeVdfPath(match[1]));
    } catch {
        // Garder la library par défaut si libraryfolders.vdf est indisponible.
    }

    return uniquePaths(libraries).filter(exists);
}

export async function findInstalledApp(libraries: string[], appId: string): Promise<InstallInfo> {
    for (const library of libraries) {
        const manifest = path.join(library, 'steamapps', `appmanifest_${appId}.acf`);
        if (!exists(manifest)) continue;

        try {
            const text = await fsp.readFile(manifest, 'utf8');
            const installName = text.match(/"installdir"\s+"([^"]+)"/i)?.[1] || null;
            const size = Number(text.match(/"SizeOnDisk"\s+"(\d+)"/i)?.[1] || 0);
            const rawStateFlags = text.match(/"StateFlags"\s+"(\d+)"/i)?.[1];
            const stateFlags = rawStateFlags === undefined ? Number.NaN : Number(rawStateFlags);
            const validStateFlags = Number.isFinite(stateFlags);

            // Steam creates appmanifest_<appid>.acf as soon as an install starts.
            // StateFlags=4 is the FullyInstalled bit; do not expose Open before that bit appears.
            const fullyInstalled = validStateFlags ? (stateFlags & 4) !== 0 : true;
            const activeInstallMask = 2 | 256 | 512 | 1024 | 65536 | 131072 | 262144 | 524288 | 1048576 | 2097152 | 4194304 | 8388608;
            const installing = validStateFlags ? !fullyInstalled && (stateFlags & activeInstallMask) !== 0 : false;

            return {
                installed: fullyInstalled,
                installing,
                library,
                manifest,
                installDir: installName ? path.join(library, 'steamapps', 'common', installName) : null,
                sizeOnDisk: Number.isFinite(size) ? size : 0
            };
        } catch {
            // Tester une autre Steam library si le manifest est illisible.
        }
    }

    return {
        installed: false,
        installing: false,
        library: null,
        manifest: null,
        installDir: null,
        sizeOnDisk: 0
    };
}

export async function detectSteamId64(steamRoot: string | null): Promise<string | null> {
    if (!steamRoot) return null;

    const loginUsers = path.join(steamRoot, 'config', 'loginusers.vdf');
    try {
        const text = await fsp.readFile(loginUsers, 'utf8');
        const blockPattern = /"(7656119\d{10})"\s*\{([\s\S]*?)\n\s*\}/g;
        let first: string | null = null;
        let match: RegExpExecArray | null;

        while ((match = blockPattern.exec(text))) {
            if (!first) first = match[1];
            if (/"MostRecent"\s+"1"/i.test(match[2])) return match[1];
        }

        return first;
    } catch {
        const userdata = path.join(steamRoot, 'userdata');
        try {
            const dirs = await fsp.readdir(userdata, { withFileTypes: true });
            const account = dirs.find((dir) => dir.isDirectory() && /^\d+$/.test(dir.name));
            if (!account) return null;
            return (76561197960265728n + BigInt(account.name)).toString();
        } catch {
            return null;
        }
    }
}

// Détection des process et gestion des fenêtres.

async function processList(): Promise<ProcessInfo[]> {
    if (process.platform === 'win32') {
        const script = [
            '$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine;',
            '$p | ConvertTo-Json -Compress'
        ].join(' ');

        try {
            const { stdout } = await execFileAsync(
                'powershell.exe',
                ['-NoProfile', '-Command', script],
                { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
            );
            const parsed = JSON.parse(stdout || '[]');
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            return rows.map((row) => ({
                pid: Number(row.ProcessId),
                ppid: Number(row.ParentProcessId || 0),
                command: `${row.ExecutablePath || ''} ${row.CommandLine || ''}`
            }));
        } catch {
            return [];
        }
    }

    try {
        const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], {
            maxBuffer: 8 * 1024 * 1024
        });
        return stdout
            .split('\n')
            .map((line) => {
                const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
                return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
            })
            .filter((row): row is ProcessInfo => Boolean(row));
    } catch {
        return [];
    }
}

export async function isSteamRunning(): Promise<boolean> {
    const processes = await processList();

    return processes.some((processInfo) => {
        const command = processInfo.command.replace(/\\/g, '/').toLowerCase();

        if (process.platform === 'win32') {
            return command.includes('steam.exe');
        }

        if (process.platform === 'darwin') {
            return command.includes('/steam_osx') || command.includes('steam.app/contents/macos/steam');
        }

        // Détecter Steam indépendamment du process du jeu.
        return /(^|[\s/])(steam|steam\.sh|steamwebhelper)(?=\s|$)/.test(command)
            || command.includes('com.valvesoftware.steam');
    });
}

function processMatches(game: GameDefinition, install: InstallInfo, processInfo: ProcessInfo): boolean {
    const hints = [...game.processHints];
    if (install.installDir) hints.push(install.installDir);
    const command = processInfo.command.toLowerCase();

    if (hints.some((hint) => hint && command.includes(hint.toLowerCase()))) return true;

    // Proton/Steam Linux launch wrappers do not always contain the game name,
    // but they normally carry the app id in their command line. Matching those
    // wrappers makes window hiding and shutdown reliable before the final game
    // executable appears. Never classify Steam's own UI processes as the game.
    const steamInfrastructure = /(^|[\s/])(steam|steam\.sh|steamwebhelper)(?=\s|$)/.test(command)
        || command.includes('com.valvesoftware.steam');
    if (steamInfrastructure) return false;

    return [
        `appid=${game.appId}`,
        `appid ${game.appId}`,
        `steamappid=${game.appId}`,
        `steam_appid=${game.appId}`,
        `steamgameid=${game.appId}`
    ].some((marker) => command.includes(marker));
}

async function matchingProcesses(game: GameDefinition, install: InstallInfo): Promise<ProcessInfo[]> {
    const processes = await processList();
    const matched = new Set(
        processes.filter((processInfo) => processMatches(game, install, processInfo)).map((item) => item.pid)
    );

    // Inclure les process enfants qui possèdent réellement la fenêtre du jeu.
    let changed = true;
    while (changed) {
        changed = false;
        for (const processInfo of processes) {
            if (!matched.has(processInfo.pid) && matched.has(processInfo.ppid)) {
                matched.add(processInfo.pid);
                changed = true;
            }
        }
    }

    return processes.filter((processInfo) => matched.has(processInfo.pid));
}

export async function isAppRunning(game: GameDefinition, install: InstallInfo): Promise<boolean> {
    return (await matchingProcesses(game, install)).length > 0;
}

async function commandAvailable(command: string): Promise<boolean> {
    if (process.platform === 'win32') return true;

    if (path.isAbsolute(command)) {
        try {
            await fsp.access(command, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        try {
            await fsp.access(path.join(directory, command), fs.constants.X_OK);
            return true;
        } catch {
            // Continue searching the PATH.
        }
    }
    return false;
}

function backgroundHints(game: GameDefinition, install: InstallInfo): string[] {
    const values = [game.name, ...game.windowHints, ...game.processHints];
    if (install.installDir) values.push(path.basename(install.installDir));
    return [...new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length >= 3))];
}

function escapeRe2(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hyprRegex(game: GameDefinition, install: InstallInfo): string {
    const hints = backgroundHints(game, install)
        .map((hint) => escapeRe2(hint))
        .filter(Boolean);
    if (hints.length === 0) return '(?i)^$';
    return `(?i)(${hints.map((hint) => `.*${hint}.*`).join('|')})`;
}

async function hyprlandVersionMajorMinor(): Promise<{ major: number; minor: number } | null> {
    if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || !(await commandAvailable('hyprctl'))) return null;
    try {
        const { stdout } = await execFileAsync('hyprctl', ['version', '-j'], { maxBuffer: 1024 * 1024 });
        const parsed = JSON.parse(stdout || '{}') as { tag?: string; version?: string };
        const raw = parsed.tag || parsed.version || '';
        const match = raw.match(/(\d+)\.(\d+)/);
        if (!match) return null;
        return { major: Number(match[1]), minor: Number(match[2]) };
    } catch {
        return null;
    }
}

function isNewHyprRules(version: { major: number; minor: number } | null): boolean {
    if (!version) return false;
    return version.major > 0 || version.minor >= 53;
}

async function setHyprNamedRuleProperty(name: string, property: string, value: string): Promise<boolean> {
    try {
        await execFileAsync('hyprctl', ['keyword', `windowrule[${name}]:${property} ${value}`], {
            maxBuffer: 1024 * 1024
        });
        return true;
    } catch {
        return false;
    }
}

// Préparer une rule Hyprland avant la fenêtre pour éviter son flash initial.
export async function prepareBackgroundApp(
    game: GameDefinition,
    install: InstallInfo
): Promise<{ mode: string; prepared: boolean }> {
    if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) {
        return { mode: 'runtime-guard', prepared: false };
    }
    if (!(await commandAvailable('hyprctl'))) return { mode: 'runtime-guard', prepared: false };

    const version = await hyprlandVersionMajorMinor();
    if (!isNewHyprRules(version)) {
        return { mode: 'hyprland-runtime-guard', prepared: false };
    }

    const regex = hyprRegex(game, install);
    const names = [`vaporstow-${game.id}-class`, `vaporstow-${game.id}-title`];
    const matches: Array<[string, string]> = [
        ['match:class', regex],
        ['match:title', regex]
    ];

    let prepared = false;
    for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        const [matchProp, matchValue] = matches[index];
        const ok = await setHyprNamedRuleProperty(name, matchProp, matchValue);
        if (!ok) continue;

        await setHyprNamedRuleProperty(name, 'workspace', 'special:vaporstow silent');
        await setHyprNamedRuleProperty(name, 'no_initial_focus', 'on');
        await setHyprNamedRuleProperty(name, 'no_anim', 'on');
        await setHyprNamedRuleProperty(name, 'suppress_event', 'activate activatefocus fullscreen maximize');
        await setHyprNamedRuleProperty(name, 'enable', 'true');
        prepared = true;
    }

    return {
        mode: prepared ? 'hyprland-prelaunch-rule' : 'hyprland-runtime-guard',
        prepared
    };
}

export async function cleanupBackgroundApp(game: GameDefinition): Promise<void> {
    if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
    if (!(await commandAvailable('hyprctl'))) return;
    const version = await hyprlandVersionMajorMinor();
    if (!isNewHyprRules(version)) return;

    for (const name of [`vaporstow-${game.id}-class`, `vaporstow-${game.id}-title`]) {
        await setHyprNamedRuleProperty(name, 'enable', 'false');
    }
}

function metadataMatchesGame(game: GameDefinition, install: InstallInfo, values: Array<string | null | undefined>): boolean {
    const haystack = values.filter(Boolean).join(' ').toLowerCase();
    if (!haystack || haystack.includes('vaporstow')) return false;
    return backgroundHints(game, install).some((hint) => haystack.includes(hint));
}

async function backgroundOnHyprland(game: GameDefinition, install: InstallInfo, pids: number[]): Promise<number> {
    if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || !(await commandAvailable('hyprctl'))) return 0;

    try {
        const { stdout } = await execFileAsync('hyprctl', ['clients', '-j'], { maxBuffer: 8 * 1024 * 1024 });
        const clients = JSON.parse(stdout || '[]') as Array<{
            pid?: number;
            address?: string;
            class?: string;
            title?: string;
            initialClass?: string;
            initialTitle?: string;
            workspace?: { name?: string };
        }>;
        let affected = 0;

        for (const client of clients) {
            if (!client.address) continue;
            if (client.workspace?.name === 'special:vaporstow') continue;
            const pidMatch = Boolean(client.pid && pids.includes(Number(client.pid)));
            const metadataMatch = metadataMatchesGame(game, install, [
                client.class,
                client.title,
                client.initialClass,
                client.initialTitle
            ]);
            if (!pidMatch && !metadataMatch) continue;

            try {
                await execFileAsync('hyprctl', [
                    'dispatch',
                    'movetoworkspacesilent',
                    `special:vaporstow,address:${client.address}`
                ]);
                affected += 1;
            } catch {
                // Ignorer une fenêtre disparue entre la détection et l'action.
            }
        }

        return affected;
    } catch {
        return 0;
    }
}

type SwayNode = {
    id?: number;
    pid?: number;
    name?: string;
    app_id?: string;
    window_properties?: { class?: string; instance?: string; title?: string };
    nodes?: SwayNode[];
    floating_nodes?: SwayNode[];
};

function flattenSwayTree(node: SwayNode, output: SwayNode[] = []): SwayNode[] {
    output.push(node);
    for (const child of node.nodes || []) flattenSwayTree(child, output);
    for (const child of node.floating_nodes || []) flattenSwayTree(child, output);
    return output;
}

async function backgroundOnSway(game: GameDefinition, install: InstallInfo, pids: number[]): Promise<number> {
    if (!process.env.SWAYSOCK || !(await commandAvailable('swaymsg'))) return 0;
    try {
        const { stdout } = await execFileAsync('swaymsg', ['-t', 'get_tree', '-r'], { maxBuffer: 12 * 1024 * 1024 });
        const tree = JSON.parse(stdout || '{}') as SwayNode;
        let affected = 0;
        for (const node of flattenSwayTree(tree)) {
            if (!node.id) continue;
            const pidMatch = Boolean(node.pid && pids.includes(Number(node.pid)));
            const metadataMatch = metadataMatchesGame(game, install, [
                node.name,
                node.app_id,
                node.window_properties?.class,
                node.window_properties?.instance,
                node.window_properties?.title
            ]);
            if (!pidMatch && !metadataMatch) continue;
            try {
                await execFileAsync('swaymsg', [`[con_id=${node.id}]`, 'move', 'scratchpad']);
                affected += 1;
            } catch {
                // Continuer avec les autres fenêtres du jeu.
            }
        }
        return affected;
    } catch {
        return 0;
    }
}

type NiriWindow = {
    id?: number;
    pid?: number;
    app_id?: string;
    title?: string;
    workspace_id?: number;
};

async function backgroundOnNiri(game: GameDefinition, install: InstallInfo, pids: number[]): Promise<number | null> {
    if (!process.env.NIRI_SOCKET || !(await commandAvailable('niri'))) return null;

    try {
        const [{ stdout }, workspacesResult] = await Promise.all([
            execFileAsync('niri', ['msg', '--json', 'windows'], { maxBuffer: 8 * 1024 * 1024 }),
            execFileAsync('niri', ['msg', '--json', 'workspaces'], { maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: '[]' }))
        ]);
        const windows = JSON.parse(stdout || '[]') as NiriWindow[];
        const workspaces = JSON.parse(workspacesResult.stdout || '[]') as Array<{ id?: number; idx?: number }>;
        const stashWorkspaceId = workspaces.find((workspace) => Number(workspace.idx) === 99)?.id ?? null;
        let affected = 0;

        for (const window of windows) {
            if (!window.id) continue;
            if (stashWorkspaceId !== null && Number(window.workspace_id) === Number(stashWorkspaceId)) continue;
            const pidMatch = Boolean(window.pid && pids.includes(Number(window.pid)));
            const metadataMatch = metadataMatchesGame(game, install, [window.app_id, window.title]);
            if (!pidMatch && !metadataMatch) continue;

            try {
                // Niri has no built-in scratchpad. A high, non-focused dynamic
                // workspace gives us the same background-session behaviour while
                // keeping the user's current workspace and focus untouched.
                await execFileAsync('niri', [
                    'msg', 'action', 'move-window-to-workspace',
                    '--window-id', String(window.id),
                    '--focus', 'false',
                    '99'
                ], { maxBuffer: 1024 * 1024 });
                affected += 1;
            } catch {
                // The window may have disappeared between enumeration and move.
            }
        }

        return affected;
    } catch {
        return 0;
    }
}

async function backgroundOnKdeWayland(pids: number[]): Promise<number> {
    // Utiliser kdotool sur KWin/Wayland lorsqu'il est déjà disponible.
    if (!(await commandAvailable('kdotool'))) return 0;
    let affected = 0;
    for (const pid of pids) {
        try {
            const { stdout } = await execFileAsync('kdotool', ['search', '--pid', String(pid)], { maxBuffer: 1024 * 1024 });
            const windows = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
            for (const windowId of windows) {
                try {
                    await execFileAsync('kdotool', ['windowminimize', windowId]);
                    affected += 1;
                } catch {
                    // Ignorer cette fenêtre KWin.
                }
            }
        } catch {
            // Aucun window trouvé pour ce pid.
        }
    }
    return affected;
}

async function backgroundOnX11(pids: number[]): Promise<number> {
    let affected = 0;

    if (await commandAvailable('xdotool')) {
        for (const pid of pids) {
            try {
                const { stdout } = await execFileAsync('xdotool', ['search', '--onlyvisible', '--pid', String(pid)], {
                    maxBuffer: 1024 * 1024
                });
                const windows = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
                for (const windowId of windows) {
                    try {
                        await execFileAsync('xdotool', ['windowminimize', windowId]);
                        affected += 1;
                    } catch {
                        // Ignorer cette fenêtre.
                    }
                }
            } catch {
                // Un process peut ne posséder aucune fenêtre X11/XWayland visible.
            }
        }
        if (affected > 0) return affected;
    }

    if (await commandAvailable('wmctrl')) {
        try {
            const { stdout } = await execFileAsync('wmctrl', ['-lp'], { maxBuffer: 1024 * 1024 });
            for (const line of stdout.split(/\r?\n/)) {
                const match = line.trim().match(/^(0x[0-9a-fA-F]+)\s+\S+\s+(\d+)\s+/);
                if (!match || !pids.includes(Number(match[2]))) continue;
                try {
                    await execFileAsync('wmctrl', ['-ir', match[1], '-b', 'add,hidden']);
                    affected += 1;
                } catch {
                    // Ignorer cette fenêtre.
                }
            }
        } catch {
            // Aucune liste de fenêtres X11 disponible.
        }
    }

    return affected;
}

async function backgroundOnWindows(pids: number[]): Promise<number> {
    if (pids.length === 0) return 0;
    const list = pids.join(',');
    const script = [
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class VaporWindow {',
        '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
        '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
        '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
        '}',
        '"@;',
        `$ids = @(${list});`,
        '$count = 0;',
        '$callback = [VaporWindow+EnumWindowsProc]{',
        '  param([IntPtr]$hWnd, [IntPtr]$lParam)',
        '  [uint32]$ownerPid = 0;',
        '  [void][VaporWindow]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid);',
        '  if (($ids -contains [int]$ownerPid) -and [VaporWindow]::IsWindowVisible($hWnd)) {',
        '    [VaporWindow]::ShowWindowAsync($hWnd, 0) | Out-Null;',
        '    $script:count++;',
        '  }',
        '  return $true;',
        '};',
        '[VaporWindow]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null;',
        'Write-Output $count;'
    ].join('\n');

    try {
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
            windowsHide: true
        });
        return Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
        return 0;
    }
}

async function backgroundOnMac(pids: number[]): Promise<number> {
    let affected = 0;
    for (const pid of pids) {
        try {
            const { stdout } = await execFileAsync('osascript', [
                '-e', 'tell application "System Events"',
                '-e', `set matches to every process whose unix id is ${pid}`,
                '-e', 'set changed to 0',
                '-e', 'repeat with p in matches',
                '-e', 'if visible of p then',
                '-e', 'set visible of p to false',
                '-e', 'set changed to changed + 1',
                '-e', 'end if',
                '-e', 'end repeat',
                '-e', 'return changed',
                '-e', 'end tell'
            ]);
            affected += Number.parseInt(stdout.trim(), 10) || 0;
        } catch {
            // macOS peut demander la permission Automation/Accessibility.
        }
    }
    return affected;
}

export async function backgroundApp(
    game: GameDefinition,
    install: InstallInfo
): Promise<{ mode: string; affected: number }> {
    const matches = await matchingProcesses(game, install);
    const pids = [...new Set(matches.map((item) => item.pid).filter(Boolean))];

    // Matcher les metadata du compositor pour couvrir wrappers et renderers.
    if (process.platform === 'linux') {
        const niri = await backgroundOnNiri(game, install, pids);
        if (niri !== null) return { mode: 'niri-background-workspace', affected: niri };

        const hypr = await backgroundOnHyprland(game, install, pids);
        if (hypr > 0) return { mode: 'hyprland-special-workspace', affected: hypr };

        const sway = await backgroundOnSway(game, install, pids);
        if (sway > 0) return { mode: 'sway-scratchpad', affected: sway };

        const kde = await backgroundOnKdeWayland(pids);
        if (kde > 0) return { mode: 'kwin-minimize', affected: kde };

        const x11 = await backgroundOnX11(pids);
        if (x11 > 0) return { mode: 'x11-minimize', affected: x11 };

        if (pids.length === 0) return { mode: 'waiting-for-process', affected: 0 };
        const session = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
        return {
            mode: session === 'wayland' ? 'wayland-no-window-control' : 'waiting-for-window',
            affected: 0
        };
    }

    if (pids.length === 0) return { mode: 'waiting-for-process', affected: 0 };

    if (process.platform === 'win32') {
        const windows = await backgroundOnWindows(pids);
        return { mode: windows > 0 ? 'windows-hide' : 'waiting-for-window', affected: windows };
    }

    if (process.platform === 'darwin') {
        const mac = await backgroundOnMac(pids);
        return { mode: mac > 0 ? 'macos-hide' : 'waiting-for-window', affected: mac };
    }

    return { mode: 'unsupported-platform', affected: 0 };
}

export async function stopAppGracefully(
    game: GameDefinition,
    install: InstallInfo
): Promise<{ stopped: number; pids: number[] }> {
    const initial = await matchingProcesses(game, install);
    const pids: number[] = [];

    for (const processInfo of initial) {
        if (!processInfo.pid || processInfo.pid === process.pid) continue;
        try {
            if (process.platform === 'win32') {
                await execFileAsync('taskkill', ['/PID', String(processInfo.pid)], { windowsHide: true });
            } else {
                process.kill(processInfo.pid, 'SIGTERM');
            }
            pids.push(processInfo.pid);
        } catch {
            // Continuer avec les autres process du jeu.
        }
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
    const remaining = await matchingProcesses(game, install);

    for (const processInfo of remaining) {
        if (!processInfo.pid || processInfo.pid === process.pid) continue;
        try {
            if (process.platform === 'win32') {
                await execFileAsync('taskkill', ['/F', '/PID', String(processInfo.pid)], { windowsHide: true });
            } else {
                process.kill(processInfo.pid, 'SIGKILL');
            }
            if (!pids.includes(processInfo.pid)) pids.push(processInfo.pid);
        } catch {
            // Laisser Steam signaler l'échec si un process survit.
        }
    }

    return { stopped: pids.length, pids };
}


export type CloudTransferDirection = 'up' | 'down' | 'auto';

export type CloudTransferProgress = {
    state: 'waiting' | 'evaluating' | 'uploading' | 'downloading' | 'complete' | 'failed';
    direction: 'up' | 'down' | 'unknown';
    percent: number | null;
    transferredBytes: number;
    totalBytes: number | null;
    completedFiles: number;
    totalFiles: number | null;
    speedBytesPerSecond: number | null;
    etaSeconds: number | null;
    currentFile: string | null;
    message: string;
    logPath: string | null;
};

// Lecture et suivi du Steam Cloud log.

export async function detectCloudLogPath(steamRoot: string | null): Promise<string | null> {
    const home = os.homedir();
    const candidates: Array<string | null | undefined> = [];

    if (steamRoot) candidates.push(path.join(steamRoot, 'logs', 'cloud_log.txt'));

    if (process.platform === 'win32') {
        const registry = await windowsRegistrySteamPath();
        if (registry) candidates.push(path.join(registry, 'logs', 'cloud_log.txt'));
        if (process.env['PROGRAMFILES(X86)']) {
            candidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Steam', 'logs', 'cloud_log.txt'));
        }
        if (process.env.PROGRAMFILES) {
            candidates.push(path.join(process.env.PROGRAMFILES, 'Steam', 'logs', 'cloud_log.txt'));
        }
    } else if (process.platform === 'darwin') {
        candidates.push(path.join(home, 'Library', 'Application Support', 'Steam', 'logs', 'cloud_log.txt'));
    } else {
        candidates.push(
            path.join(home, '.local', 'share', 'Steam', 'logs', 'cloud_log.txt'),
            path.join(home, '.steam', 'steam', 'logs', 'cloud_log.txt'),
            path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam', 'logs', 'cloud_log.txt'),
            path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam', 'logs', 'cloud_log.txt'),
            path.join(home, 'snap', 'steam', 'common', '.steam', 'root', 'logs', 'cloud_log.txt')
        );
    }

    const normalized = uniquePaths(candidates);
    for (const candidate of normalized) {
        if (exists(candidate)) return candidate;
    }

    // Retourner le Cloud log attendu même avant sa première création par Steam.
    return normalized[0] || null;
}

export async function cloudLogMarker(steamRoot: string | null): Promise<number> {
    const log = await detectCloudLogPath(steamRoot);
    if (!log) return 0;
    try {
        return (await fsp.stat(log)).size;
    } catch {
        return 0;
    }
}

export async function clearCloudLog(steamRoot: string | null): Promise<{ cleared: boolean; logPath: string | null; marker: number }> {
    const log = await detectCloudLogPath(steamRoot);
    if (!log) return { cleared: false, logPath: null, marker: 0 };

    // Réessayer le truncate si Steam rouvre temporairement cloud_log.txt.
    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            await fsp.mkdir(path.dirname(log), { recursive: true });
            const handle = await fsp.open(log, 'a+');
            try {
                await handle.truncate(0);
                await handle.sync();
            } finally {
                await handle.close();
            }
            cloudProgressFileSizeCache.clear();
            return { cleared: true, logPath: log, marker: 0 };
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 125 + attempt * 100));
        }
    }

    // Conserver le marker courant si le log reste temporairement verrouillé.
    return { cleared: false, logPath: log, marker: await cloudLogMarker(steamRoot) };
}

async function readCloudLogFrom(steamRoot: string | null, marker: number): Promise<{ text: string; logPath: string | null }> {
    const log = await detectCloudLogPath(steamRoot);
    if (!log) return { text: '', logPath: null };

    try {
        const handle = await fsp.open(log, 'r');
        try {
            const stat = await handle.stat();
            if (stat.size === marker) return { text: '', logPath: log };
            // Relire depuis le début si Steam a tronqué ou recréé le log.
            const start = stat.size < marker ? 0 : marker;
            const length = stat.size - start;
            if (length <= 0) return { text: '', logPath: log };
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, start);
            return { text: buffer.toString('utf8'), logPath: log };
        } finally {
            await handle.close();
        }
    } catch {
        return { text: '', logPath: log };
    }
}

export type CloudSyncWaitResult = {
    state: 'complete' | 'failed' | 'timeout' | 'no-log';
    lines: string[];
    message: string;
    uploadedFiles: string[];
    neededFiles: string[];
    reason: 'upload-complete' | 'no-changes' | 'error' | 'timeout' | 'no-log';
};

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function extractCloudPath(line: string, prefix: string): string | null {
    const index = line.indexOf(prefix);
    if (index < 0) return null;
    const value = line.slice(index + prefix.length).trim();
    return value || null;
}

function normalizeCloudLogPath(value: string): string {
    return value.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseSteamLogTimestamp(line: string): number | null {
    const match = line.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/);
    if (!match) return null;
    const [, y, m, d, hh, mm, ss] = match;
    const stamp = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
    return Number.isFinite(stamp) ? stamp : null;
}

async function statLoggedCloudPath(cloudRoot: string | null, loggedPath: string): Promise<number | null> {
    if (!cloudRoot) return null;
    const normalizedLogged = normalizeCloudLogPath(loggedPath);
    const slashLogged = normalizedLogged.replace(/\\/g, '/');
    const candidates: string[] = [];

    if (path.isAbsolute(normalizedLogged)) candidates.push(normalizedLogged);

    // Résoudre les paths Auto-Cloud relativement au profile utilisateur.
    candidates.push(path.join(os.homedir(), normalizedLogged));

    // Tester les suffixes du Cloud root pour rester portable entre plateformes.
    const rootSlash = path.resolve(cloudRoot).replace(/\\/g, '/');
    const rootParts = rootSlash.split('/').filter(Boolean);
    const lowerLogged = slashLogged.toLowerCase();
    for (let count = Math.min(5, rootParts.length); count >= 1; count -= 1) {
        const needle = rootParts.slice(-count).join('/');
        const index = lowerLogged.lastIndexOf(needle.toLowerCase());
        if (index < 0) continue;
        const suffix = slashLogged.slice(index + needle.length).replace(/^\/+/, '');
        candidates.push(path.join(cloudRoot, suffix));
        break;
    }

    // Garder des suffixes de secours pour les noms uniques de VaporStow.parts.
    const pieces = slashLogged.split('/').filter(Boolean);
    if (pieces.length >= 2) candidates.push(path.join(cloudRoot, pieces.slice(-2).join(path.sep)));
    if (pieces.length >= 1) candidates.push(path.join(cloudRoot, pieces.at(-1)!));

    for (const candidate of uniquePaths(candidates)) {
        try {
            const stat = await fsp.stat(candidate);
            if (stat.isFile()) return stat.size;
        } catch {
            // Tester le candidat suivant.
        }
    }

    return null;
}

function detectDirection(lines: string[], preferred: CloudTransferDirection): 'up' | 'down' | 'unknown' {
    if (preferred === 'up' || preferred === 'down') return preferred;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const lower = lines[index].toLowerCase();
        if (/starting sync \([^)]*\bup\b/.test(lower)) return 'up';
        if (/starting sync \([^)]*\bdown\b/.test(lower)) return 'down';
    }
    if (lines.some((line) => /need to upload file |http upload for file |upload ok for file /i.test(line))) return 'up';
    if (lines.some((line) => /need to download file |http download for file |download ok for file /i.test(line))) return 'down';
    return 'unknown';
}

function latestCurrentFile(lines: string[], direction: 'up' | 'down' | 'unknown'): string | null {
    const beginPattern = direction === 'down'
        ? /HTTP download for file ['"](.+?)['"].*beginning/i
        : /HTTP upload for file ['"](.+?)['"].*beginning/i;
    const donePrefix = direction === 'down' ? 'Download OK for file ' : 'Upload OK for file ';
    let current: string | null = null;

    for (const line of lines) {
        const begin = line.match(beginPattern)?.[1];
        if (begin) current = begin;
        const done = extractCloudPath(line, donePrefix);
        if (done && current && normalizeCloudLogPath(done) === normalizeCloudLogPath(current)) current = null;
    }
    return current;
}

const cloudProgressFileSizeCache = new Map<string, Map<string, number>>();

async function cachedLoggedCloudPathSize(
    sessionKey: string,
    cloudRoot: string | null,
    loggedPath: string
): Promise<number | null> {
    let session = cloudProgressFileSizeCache.get(sessionKey);
    if (!session) {
        session = new Map<string, number>();
        cloudProgressFileSizeCache.set(sessionKey, session);
    }

    const key = normalizeCloudLogPath(loggedPath).toLowerCase();
    const cached = session.get(key);
    if (cached !== undefined) return cached;

    const size = await statLoggedCloudPath(cloudRoot, loggedPath);
    // Ne pas cacher les misses pendant un pull encore incomplet.
    if (size !== null) session.set(key, size);
    return size;
}

export async function cloudTransferProgress(
    steamRoot: string | null,
    appId: string,
    marker: number,
    cloudRoot: string | null,
    preferredDirection: CloudTransferDirection = 'auto'
): Promise<CloudTransferProgress> {
    const { text, logPath } = await readCloudLogFrom(steamRoot, marker);
    const lines = text
        .split(/\r?\n/)
        .filter((line) => line.includes(`[AppID ${appId}]`));

    if (lines.length === 0) {
        return {
            state: 'waiting', direction: preferredDirection === 'auto' ? 'unknown' : preferredDirection,
            percent: null, transferredBytes: 0, totalBytes: null,
            completedFiles: 0, totalFiles: null, speedBytesPerSecond: null, etaSeconds: null,
            currentFile: null, message: 'Waiting for Steam Cloud…', logPath
        };
    }

    const lower = lines.join('\n').toLowerCase();
    const direction = detectDirection(lines, preferredDirection);
    if (/timed out|\btimeout\b|failure|\bfailed\b|quota|exceed|sync error|unable to sync|http .* error|result (?:fail|error)/.test(lower)) {
        return {
            state: 'failed', direction, percent: null, transferredBytes: 0, totalBytes: null,
            completedFiles: 0, totalFiles: null, speedBytesPerSecond: null, etaSeconds: null,
            currentFile: null, message: 'Steam Cloud reported a synchronization failure.', logPath
        };
    }

    const neededPrefix = direction === 'down' ? 'Need to download file ' : 'Need to upload file ';
    const donePrefix = direction === 'down' ? 'Download OK for file ' : 'Upload OK for file ';
    const neededFiles = unique(lines
        .map((line) => extractCloudPath(line, neededPrefix))
        .filter((value): value is string => Boolean(value)));
    const completedPaths = unique(lines
        .map((line) => extractCloudPath(line, donePrefix))
        .filter((value): value is string => Boolean(value)));

    const complete = direction === 'up'
        ? /upload complete, result ok|upload complete in build list|successfully synced to changenumber|sync complete/i.test(text)
        : direction === 'down'
            ? /download complete, result ok|download complete in build list|successfully synced to changenumber/i.test(text)
            : /successfully synced to changenumber/i.test(text);

    // Garder le progress indéterminé tant que Steam peut ajouter des fichiers.
    const batchReady = complete || (direction === 'up'
        ? /upload batch initiated|HTTP upload for file .* beginning/i.test(text)
        : direction === 'down'
            ? /download batch initiated|HTTP download for file .* beginning/i.test(text)
            : false);

    const sessionKey = `${steamRoot ?? ''}|${appId}|${marker}|${cloudRoot ?? ''}|${direction}`;
    const neededSizes = new Map<string, number>();
    if (neededFiles.length > 0) {
        const resolved = await Promise.all(neededFiles.map(async (file) => ({
            file,
            size: await cachedLoggedCloudPathSize(sessionKey, cloudRoot, file)
        })));
        for (const item of resolved) {
            if (item.size !== null) neededSizes.set(normalizeCloudLogPath(item.file).toLowerCase(), item.size);
        }
    }

    let transferredBytes = 0;
    let totalBytes: number | null = null;
    let speedBytesPerSecond: number | null = null;
    let etaSeconds: number | null = null;
    let currentFile = latestCurrentFile(lines, direction);
    let currentStartedAt: number | null = null;
    let currentEstimatedBytes = 0;
    const completedTransferDurations: number[] = [];

    if (direction === 'up') {
        const activeBegins = new Map<string, { file: string; startedAt: number | null }>();
        const seenSegments = new Set<string>();
        let activeTransferSeconds = 0;
        let confirmedBytes = 0;

        for (const line of lines) {
            const begin = line.match(/HTTP upload for file ['"](.+?)['"].*beginning/i)?.[1];
            if (begin) {
                const normalized = normalizeCloudLogPath(begin).toLowerCase();
                activeBegins.set(normalized, { file: begin, startedAt: parseSteamLogTimestamp(line) });
            }

            const success = line.match(/HTTP upload for file ['"](.+?)['"] \(offset=(\d+), length=(\d+)\).* - success\./i);
            if (success) {
                const normalized = normalizeCloudLogPath(success[1]).toLowerCase();
                const segmentKey = `${normalized}:${success[2]}:${success[3]}`;
                if (!seenSegments.has(segmentKey)) {
                    seenSegments.add(segmentKey);
                    const bytes = Number(success[3]) || 0;
                    confirmedBytes += bytes;

                    const finishedAt = parseSteamLogTimestamp(line);
                    const active = activeBegins.get(normalized);
                    if (active?.startedAt !== null && active?.startedAt !== undefined && finishedAt !== null) {
                        const seconds = Math.max(0.25, (finishedAt - active.startedAt) / 1000);
                        activeTransferSeconds += seconds;
                        completedTransferDurations.push(seconds);
                    }
                }
                activeBegins.delete(normalized);
            }

            const uploadOk = extractCloudPath(line, 'Upload OK for file ');
            if (uploadOk) activeBegins.delete(normalizeCloudLogPath(uploadOk).toLowerCase());
        }

        if (activeTransferSeconds > 0 && confirmedBytes > 0) {
            speedBytesPerSecond = confirmedBytes / activeTransferSeconds;
        }

        if (neededFiles.length > 0 && neededSizes.size === neededFiles.length) {
            totalBytes = [...neededSizes.values()].reduce((sum, value) => sum + value, 0);
        }

        // Interpoler l'upload courant avec le throughput mesuré entre deux logs Steam.
        let newest: { file: string; startedAt: number | null } | null = null;
        for (const active of activeBegins.values()) {
            if (!newest || (active.startedAt ?? 0) >= (newest.startedAt ?? 0)) newest = active;
        }
        if (newest) {
            currentFile = newest.file;
            currentStartedAt = newest.startedAt;
            const currentSize = neededSizes.get(normalizeCloudLogPath(newest.file).toLowerCase()) ?? null;
            if (speedBytesPerSecond && currentStartedAt !== null && currentSize !== null) {
                const elapsed = Math.max(0, (Date.now() - currentStartedAt) / 1000);
                currentEstimatedBytes = Math.min(currentSize * 0.97, elapsed * speedBytesPerSecond);
            }
        }

        transferredBytes = confirmedBytes + currentEstimatedBytes;
        if (totalBytes !== null) transferredBytes = Math.min(totalBytes, transferredBytes);

        if (speedBytesPerSecond && totalBytes !== null && totalBytes > transferredBytes) {
            etaSeconds = Math.max(0, (totalBytes - transferredBytes) / speedBytesPerSecond);
        }
    } else if (direction === 'down') {
        // Utiliser les bytes seulement si chaque fichier téléchargé peut être résolu.
        let resolvedTotal = 0;
        let resolvedNeeded = 0;
        let resolvedDone = 0;
        for (const file of neededFiles) {
            const size = neededSizes.get(normalizeCloudLogPath(file).toLowerCase());
            if (size !== undefined) {
                resolvedTotal += size;
                resolvedNeeded += 1;
            }
        }
        for (const file of completedPaths) {
            const size = await cachedLoggedCloudPathSize(sessionKey, cloudRoot, file);
            if (size !== null) {
                transferredBytes += size;
                resolvedDone += 1;
            }
        }
        if (neededFiles.length > 0 && resolvedNeeded === neededFiles.length && resolvedDone === completedPaths.length) {
            totalBytes = resolvedTotal;
        }
    }

    const totalFiles = neededFiles.length > 0 && batchReady ? neededFiles.length : null;
    const completedFiles = completedPaths.length;

    // Estimer par durée de fichier lorsque le total en bytes reste inconnu.
    if (etaSeconds === null && batchReady && totalFiles !== null && completedTransferDurations.length > 0) {
        const averageSeconds = completedTransferDurations.reduce((sum, value) => sum + value, 0) / completedTransferDurations.length;
        etaSeconds = Math.max(0, (totalFiles - completedFiles) * averageSeconds);
    }

    let percent: number | null = null;
    if (complete) {
        percent = 100;
    } else if (batchReady && totalBytes !== null && totalBytes > 0) {
        percent = Math.max(0, Math.min(99.5, (transferredBytes / totalBytes) * 100));
    } else if (batchReady && totalFiles && totalFiles > 0) {
        percent = Math.max(0, Math.min(99.5, (completedFiles / totalFiles) * 100));
    }

    const state: CloudTransferProgress['state'] = complete
        ? 'complete'
        : direction === 'up' && batchReady && (neededFiles.length > 0 || /http upload for file /i.test(text))
            ? 'uploading'
            : direction === 'down' && batchReady && (neededFiles.length > 0 || /http download for file /i.test(text))
                ? 'downloading'
                : 'evaluating';

    // Garder les messages du parser génériques pour éviter les doublons dans l'UI.
    const message = state === 'complete'
        ? 'Steam Cloud synchronized.'
        : state === 'uploading'
            ? 'Uploading to Steam Cloud…'
            : state === 'downloading'
                ? 'Downloading from Steam Cloud…'
                : neededFiles.length > 0
                    ? 'Steam is preparing cloud files…'
                    : 'Steam is evaluating cloud changes…';

    return {
        state, direction, percent, transferredBytes, totalBytes,
        completedFiles, totalFiles, speedBytesPerSecond, etaSeconds,
        currentFile, message, logPath
    };
}

// Attendre l'activité Cloud de l'AppID et accepter le cas valide sans changement.
export async function waitForCloudSync(
    steamRoot: string | null,
    appId: string,
    marker: number,
    timeoutMs = 30 * 60 * 1000
): Promise<CloudSyncWaitResult> {
    const emptyBase = {
        lines: [] as string[],
        uploadedFiles: [] as string[],
        neededFiles: [] as string[]
    };

    if (!steamRoot) {
        return {
            state: 'no-log',
            ...emptyBase,
            reason: 'no-log',
            message: 'Steam installation could not be located.'
        };
    }

    const started = Date.now();
    let lastLines: string[] = [];
    let lastSignature = '';
    let lastAppActivityAt = 0;
    let sawActivity = false;
    let sawAutoCloudComplete = false;
    let sawUploadIntent = false;
    let sawUploadBatch = false;
    let sawUploadSuccess = false;
    let neededFiles: string[] = [];
    let uploadedFiles: string[] = [];

    while (Date.now() - started < timeoutMs) {
        const { text: chunk } = await readCloudLogFrom(steamRoot, marker);
        const lines = chunk
            .split(/\r?\n/)
            .filter((line) => line.includes(`[AppID ${appId}]`));

        if (lines.length > 0) {
            sawActivity = true;
            lastLines = lines.slice(-160);

            const signature = `${lines.length}:${lines.at(-1) ?? ''}`;
            if (signature !== lastSignature) {
                lastSignature = signature;
                lastAppActivityAt = Date.now();
            }

            const lower = lines.join('\n').toLowerCase();

            if (
                /timed out|\btimeout\b|failure|\bfailed\b|quota|exceed|sync error|unable to sync|http .* error|result (?:fail|error)/.test(lower)
            ) {
                return {
                    state: 'failed',
                    lines: lastLines,
                    neededFiles: unique(neededFiles),
                    uploadedFiles: unique(uploadedFiles),
                    reason: 'error',
                    message: 'Steam Cloud reported an upload/synchronization failure.'
                };
            }

            sawAutoCloudComplete ||= /autocloud complete/i.test(chunk);
            sawUploadIntent ||= /need to upload file /i.test(chunk);
            sawUploadBatch ||= /upload batch initiated/i.test(chunk);
            sawUploadSuccess ||= /upload ok for file |http upload for file .* - success\./i.test(chunk);

            neededFiles = unique([
                ...neededFiles,
                ...lines
                    .map((line) => extractCloudPath(line, 'Need to upload file '))
                    .filter((value): value is string => Boolean(value))
            ]);

            uploadedFiles = unique([
                ...uploadedFiles,
                ...lines
                    .map((line) => extractCloudPath(line, 'Upload OK for file '))
                    .filter((value): value is string => Boolean(value))
            ]);

            if (/upload complete, result ok/i.test(chunk)) {
                await new Promise((resolve) => setTimeout(resolve, 650));
                return {
                    state: 'complete',
                    lines: lastLines,
                    neededFiles: unique(neededFiles),
                    uploadedFiles: unique(uploadedFiles),
                    reason: 'upload-complete',
                    message: uploadedFiles.length > 0
                        ? `Steam Cloud upload completed (${unique(uploadedFiles).length} file(s) confirmed).`
                        : 'Steam Cloud upload completed.'
                };
            }

            if (/upload complete in build list|successfully synced to changenumber|sync complete/i.test(chunk)) {
                await new Promise((resolve) => setTimeout(resolve, 650));
                return {
                    state: 'complete',
                    lines: lastLines,
                    neededFiles: unique(neededFiles),
                    uploadedFiles: unique(uploadedFiles),
                    reason: 'upload-complete',
                    message: 'Steam Cloud synchronization completed.'
                };
            }

            if (
                sawAutoCloudComplete &&
                !sawUploadIntent &&
                !sawUploadBatch &&
                !sawUploadSuccess &&
                lastAppActivityAt > 0 &&
                Date.now() - lastAppActivityAt >= 3500
            ) {
                return {
                    state: 'complete',
                    lines: lastLines,
                    neededFiles: [],
                    uploadedFiles: [],
                    reason: 'no-changes',
                    message: 'Steam Cloud is already up to date; no upload was required.'
                };
            }
        }

        await new Promise((resolve) => setTimeout(resolve, sawActivity ? 500 : 350));
    }

    return {
        state: 'timeout',
        lines: lastLines,
        neededFiles: unique(neededFiles),
        uploadedFiles: unique(uploadedFiles),
        reason: 'timeout',
        message: sawActivity
            ? 'Steam Cloud activity was detected, but no final success marker was observed before the timeout.'
            : 'No Steam Cloud activity was detected for this app.'
    };
}

export async function recentCloudLog(
    steamRoot: string | null,
    appId: string,
    limit = 100
): Promise<string[]> {
    if (!steamRoot) return [];

    const log = await detectCloudLogPath(steamRoot);
    if (!log) return [];
    try {
        const text = await fsp.readFile(log, 'utf8');
        return text
            .split(/\r?\n/)
            .filter((line) => line.includes(appId))
            .slice(-limit);
    } catch {
        return [];
    }
}
