export type GameId = string;

export type CloudContext = {
    steamLibraries: string[];
    steamId64: string | null;
    installedLibrary: string | null;
    installedDir: string | null;
};

export type CloudStorageMode = 'direct' | 'carrier';

export type CloudStorageRule = {
    root: string;
    relativePath: string;
    pattern: string;
    recursive: boolean;
    native: boolean;
    proton: boolean;
    score: number;
    storageMode: CloudStorageMode;
};

export type GameDefinition = {
    id: GameId;
    appId: string;
    name: string;
    volumeName: string;
    quotaBytes: number;
    installSizeFallbackBytes: number;
    maxFiles: number;
    cloudPattern: string;
    cloudRules: CloudStorageRule[];
    storageMode: CloudStorageMode;
    discoverySource: 'local' | 'catalog';
    isFreeApp: boolean;
    storePriceCents: number | null;
    storePriceLabel: string | null;
    artworkUrls: string[];
    platforms: NodeJS.Platform[];
    nativeCloudPlatforms: NodeJS.Platform[];
    protonExperimental?: boolean;
    storeUrl: string;
    steamInstallUrl: string;
    steamRunUrl: string;
    launchArgs?: string[];
    processHints: string[];
    windowHints: string[];
    getCloudRoot: (ctx: CloudContext) => string | null;
};
