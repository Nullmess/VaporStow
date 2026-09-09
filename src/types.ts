export type AuditEntry = {
    path: string;
    name: string;
    type: 'file' | 'directory';
    size: number;
};

export type DirectoryListing = {
    directory: string;
    entries: AuditEntry[];
};

export type GameStatus = {
    id: 'asteroid' | 'world-of-shooting';
    appId: string;
    name: string;
    volumeName: string;
    quotaBytes: number;
    maxFiles: number;
    cloudPattern: string;
    platformSupported: boolean;
    nativeCloudSupport: boolean;
    protonExperimental: boolean;
    installed: boolean;
    installing: boolean;
    installDir: string | null;
    installSize: number;
    running: boolean;
    cloudRoot: string | null;
    cloudRootExists: boolean;
    auditRoot: string | null;
    auditBytes: number;
    auditFiles: number;
    cloudBytes: number;
    cloudFiles: number;
    rememberedBytes: number | null;
    rememberedFiles: number | null;
    disk: { free: number; total: number } | null;
};

export type AppStatus = {
    appVersion: string;
    platform: 'win32' | 'darwin' | 'linux' | string;
    steamInstalled: boolean;
    steamRunning: boolean;
    steamRoot: string | null;
    steamCloudLog: string | null;
    steamId64: string | null;
    games: GameStatus[];
};

export type CloudTransferProgress = {
    state: 'waiting' | 'evaluating' | 'uploading' | 'downloading' | 'rebuilding' | 'complete' | 'failed';
    direction: 'up' | 'down' | 'unknown';
    percent: number | null;
    transferredBytes: number;
    totalBytes: number | null;
    completedFiles: number;
    totalFiles: number | null;
    receivedParts?: number | null;
    completedParts?: number | null;
    totalParts?: number | null;
    currentFileIndex?: number | null;
    currentFileReceivedParts?: number | null;
    currentFileCompletedParts?: number | null;
    currentFileTotalParts?: number | null;
    cachedPartsUsed?: number | null;
    idleSeconds?: number | null;
    speedBytesPerSecond: number | null;
    etaSeconds: number | null;
    currentFile: string | null;
    message: string;
    logPath: string | null;
};

export type SplitRestoreProgress = {
    state: 'waiting' | 'rebuilding' | 'caching' | 'complete';
    percent: number | null;
    processedBytes: number;
    totalBytes: number;
    completedFiles: number;
    totalFiles: number;
    receivedParts: number;
    completedParts: number;
    totalParts: number;
    currentFileIndex: number | null;
    currentFileReceivedParts: number;
    currentFileCompletedParts: number;
    currentFileTotalParts: number;
    cachedPartsUsed: number;
    idleSeconds: number | null;
    speedBytesPerSecond: number | null;
    etaSeconds: number | null;
    currentFile: string | null;
    message: string;
};


export type StopResult = {
    stopped: number;
    pids: number[];
    cloudLogMarker: number;
};

export type CloudLogReset = {
    cleared: boolean;
    logPath: string | null;
    marker: number;
};

export type CloudSyncResult = {
    state: 'complete' | 'failed' | 'timeout' | 'no-log';
    lines: string[];
    message: string;
    uploadedFiles: string[];
    neededFiles: string[];
    reason: 'upload-complete' | 'no-changes' | 'error' | 'timeout' | 'no-log';
};

export type PrepareSyncResult = {
    splitFiles: number;
    parts: number;
    reusedParts: number;
    rewrittenParts: number;
    maxFileBytes: number;
    chunkBytes: number;
};

export type RestoreSplitResult = {
    restoredFiles: number;
    detected: boolean;
    cachedParts: number;
};

export type VaporApi = {
    getStatus: () => Promise<AppStatus>;
    openSteamDownload: () => Promise<void>;
    runSteam: () => Promise<{ launched: boolean; alreadyRunning: boolean }>;
    openStore: (id: GameStatus['id']) => Promise<void>;
    installGame: (id: GameStatus['id']) => Promise<void>;
    runGame: (id: GameStatus['id']) => Promise<void>;
    startBackgroundGuard: (id: GameStatus['id']) => Promise<{
        started: boolean;
        mode: string;
        affected: number;
    }>;
    stopBackgroundGuard: (id: GameStatus['id']) => Promise<boolean>;
    requestStop: (id: GameStatus['id']) => Promise<StopResult>;
    getCloudLogMarker: () => Promise<number>;
    resetCloudLog: () => Promise<CloudLogReset>;
    getCloudProgress: (
        id: GameStatus['id'],
        marker: number,
        direction?: 'up' | 'down' | 'auto'
    ) => Promise<CloudTransferProgress>;
    waitForCloudSync: (id: GameStatus['id'], marker: number) => Promise<CloudSyncResult>;
    prepareSync: (id: GameStatus['id']) => Promise<PrepareSyncResult>;
    restoreSplitFiles: (id: GameStatus['id']) => Promise<RestoreSplitResult>;
    getRestoreProgress: (id: GameStatus['id']) => Promise<SplitRestoreProgress | null>;
    rememberUsage: (id: GameStatus['id'], bytes: number, files: number) => Promise<boolean>;
    listDirectory: (id: GameStatus['id'], relativeDirectory: string) => Promise<DirectoryListing>;
    importFiles: (id: GameStatus['id'], relativeDirectory: string) => Promise<{ canceled: boolean }>;
    importFolder: (id: GameStatus['id'], relativeDirectory: string) => Promise<{ canceled: boolean }>;
    createFolder: (id: GameStatus['id'], relativeDirectory: string, name: string) => Promise<boolean>;
    deleteEntry: (id: GameStatus['id'], relativePath: string) => Promise<boolean>;
    openFolder: (id: GameStatus['id'], relativeDirectory: string) => Promise<boolean>;
    revealEntry: (id: GameStatus['id'], relativePath: string) => Promise<boolean>;
    getLogs: (id: GameStatus['id']) => Promise<string[]>;
};
