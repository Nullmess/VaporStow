import os from 'node:os';
import path from 'node:path';

export type GameId = 'neko-dice' | 'asteroid' | 'hunt-for-gods' | 'world-of-shooting';

export type CloudContext = {
    steamLibraries: string[];
    steamId64: string | null;
    installedLibrary: string | null;
};

export type GameDefinition = {
    id: GameId;
    appId: string;
    name: string;
    volumeName: string;
    quotaBytes: number;
    // Conservative Steam storage requirement used when no local appmanifest exists.
    installSizeFallbackBytes: number;
    maxFiles: number;
    cloudPattern: string;
    platforms: NodeJS.Platform[];
    nativeCloudPlatforms: NodeJS.Platform[];
    protonExperimental?: boolean;
    storeUrl: string;
    steamInstallUrl: string;
    steamRunUrl: string;
    processHints: string[];
    windowHints: string[];
    getCloudRoot: (ctx: CloudContext) => string | null;
};

const GIB = 1024 ** 3;
const LARGE_QUOTA = 100_000_000_000;

function nekoDiceCloudRoot({ installedLibrary }: CloudContext): string | null {
    if (!installedLibrary) return null;

    return path.join(
        installedLibrary,
        'steamapps',
        'common',
        'NekoDice',
        'NekoData',
        'Model'
    );
}

function asteroidCloudRoot(): string {
    if (process.platform === 'win32') {
        return path.join(
            process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'Asteroid'
        );
    }

    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Asteroid');
    }

    return path.join(os.homedir(), '.config', 'Asteroid');
}

function huntForGodsCloudRoot({ installedLibrary }: CloudContext): string | null {
    if (!installedLibrary) return null;

    return path.join(
        installedLibrary,
        'steamapps',
        'common',
        'Hunt For Gods',
        'ItemSets'
    );
}

function worldOfShootingCloudRoot({ installedLibrary, steamId64 }: CloudContext): string | null {
    if (!steamId64) return null;

    if (process.platform === 'win32') {
        return path.join(
            process.env.USERPROFILE || os.homedir(),
            'AppData',
            'LocalLow',
            'Noble Empire',
            'World Of Shooting',
            'CustomLevels',
            steamId64
        );
    }

    // Résoudre le path Windows Auto-Cloud via le prefix Proton sous Linux.
    if (process.platform === 'linux' && installedLibrary) {
        return path.join(
            installedLibrary,
            'steamapps',
            'compatdata',
            '1678150',
            'pfx',
            'drive_c',
            'users',
            'steamuser',
            'AppData',
            'LocalLow',
            'Noble Empire',
            'World Of Shooting',
            'CustomLevels',
            steamId64
        );
    }

    return null;
}

export const games: GameDefinition[] = [
    {
        id: 'neko-dice',
        appId: '1621860',
        name: 'NekoDice',
        volumeName: 'Neko',
        quotaBytes: LARGE_QUOTA,
        installSizeFallbackBytes: 581.62 * 1024 ** 2,
        maxFiles: 10_000,
        cloudPattern: '* · recursive · Model',
        platforms: ['win32', 'linux'],
        nativeCloudPlatforms: ['win32'],
        protonExperimental: true,
        storeUrl: 'https://store.steampowered.com/app/1621860/NekoDice/',
        steamInstallUrl: 'steam://install/1621860',
        steamRunUrl: 'steam://run/1621860',
        processHints: ['NekoDice', 'NekoDice.exe'],
        windowHints: ['NekoDice'],
        getCloudRoot: nekoDiceCloudRoot
    },
    {
        id: 'asteroid',
        appId: '2020850',
        name: 'Asteroid',
        volumeName: 'Orbit',
        quotaBytes: LARGE_QUOTA,
        installSizeFallbackBytes: 964.43 * 1024 ** 2,
        maxFiles: 10_000,
        cloudPattern: '* · recursive',
        platforms: ['win32', 'darwin', 'linux'],
        nativeCloudPlatforms: ['win32', 'darwin', 'linux'],
        storeUrl: 'https://store.steampowered.com/app/2020850/Asteroid/',
        steamInstallUrl: 'steam://install/2020850',
        steamRunUrl: 'steam://run/2020850',
        processHints: ['Asteroid'],
        windowHints: ['Asteroid'],
        getCloudRoot: asteroidCloudRoot
    },
    {
        id: 'hunt-for-gods',
        appId: '576940',
        name: 'Hunt For Gods',
        volumeName: 'Pantheon',
        quotaBytes: LARGE_QUOTA,
        installSizeFallbackBytes: 4.25 * GIB,
        maxFiles: 10_000,
        cloudPattern: '* · recursive · ItemSets',
        platforms: ['win32', 'linux'],
        nativeCloudPlatforms: ['win32'],
        protonExperimental: true,
        storeUrl: 'https://store.steampowered.com/app/576940/Hunt_For_Gods/',
        steamInstallUrl: 'steam://install/576940',
        steamRunUrl: 'steam://run/576940',
        processHints: ['HuntForGods', 'Hunt For Gods'],
        windowHints: ['Hunt For Gods', 'HuntForGods'],
        getCloudRoot: huntForGodsCloudRoot
    },
    {
        id: 'world-of-shooting',
        appId: '1678150',
        name: 'World of Shooting',
        volumeName: 'Range',
        quotaBytes: LARGE_QUOTA,
        installSizeFallbackBytes: 12.53 * GIB,
        maxFiles: 10_000,
        cloudPattern: '*.* · recursive · CustomLevels',
        platforms: ['win32', 'linux'],
        nativeCloudPlatforms: ['win32'],
        protonExperimental: true,
        storeUrl: 'https://store.steampowered.com/app/1678150/World_of_Shooting/',
        steamInstallUrl: 'steam://install/1678150',
        steamRunUrl: 'steam://run/1678150',
        processHints: ['World Of Shooting', 'WorldOfShooting', 'World of Shooting'],
        windowHints: ['World Of Shooting', 'WorldOfShooting', 'World of Shooting'],
        getCloudRoot: worldOfShootingCloudRoot
    }
];
