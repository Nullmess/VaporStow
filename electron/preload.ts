import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

const droppedFileListeners = new Set<(paths: string[]) => void>();

window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
});

window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    const paths = Array.from(event.dataTransfer.files)
        .map((file) => webUtils.getPathForFile(file))
        .filter((value): value is string => Boolean(value));
    if (paths.length === 0) return;
    for (const listener of droppedFileListeners) listener(paths);
});

contextBridge.exposeInMainWorld('vaporApi', {
    getStatus: () => ipcRenderer.invoke('status:get'),
    startCatalogBackground: () => ipcRenderer.invoke('catalog:start-background'),
    searchExternalCatalog: (criteria?: { minQuotaBytes?: number; minFiles?: number; maxAppSizeBytes?: number | null; targetResults?: number }) => ipcRenderer.invoke('catalog:search', criteria),
    openSteamDownload: () => ipcRenderer.invoke('steam:download'),
    openGithubProfile: (username: string) => ipcRenderer.invoke('github:open-profile', username),
    runSteam: () => ipcRenderer.invoke('steam:run'),
    openStore: (id: string) => ipcRenderer.invoke('game:open-store', id),
    installGame: (id: string) => ipcRenderer.invoke('game:install', id),
    runGame: (id: string) => ipcRenderer.invoke('game:run', id),
    startBackgroundGuard: (id: string) => ipcRenderer.invoke('game:background-start', id),
    stopBackgroundGuard: (id: string) => ipcRenderer.invoke('game:background-stop', id),
    isGameRunning: (id: string) => ipcRenderer.invoke('game:is-running', id),
    requestStop: (id: string) => ipcRenderer.invoke('game:request-stop', id),
    getCloudLogMarker: () => ipcRenderer.invoke('cloud:log-marker'),
    resetCloudLog: () => ipcRenderer.invoke('cloud:reset-log'),
    getCloudProgress: (id: string, marker: number, direction: 'up' | 'down' | 'auto' = 'auto') => ipcRenderer.invoke('cloud:progress', id, marker, direction),
    waitForCloudSync: (id: string, marker: number) => ipcRenderer.invoke('cloud:wait-sync', id, marker),
    prepareSync: (id: string) => ipcRenderer.invoke('cloud:prepare-sync', id),
    prepareSyncOffline: (id: string) => ipcRenderer.invoke('cloud:prepare-sync-offline', id),
    getCloudContentSummary: (id: string) => ipcRenderer.invoke('cloud:content-summary', id),
    getAuditUsage: (id: string) => ipcRenderer.invoke('cloud:audit-usage', id),
    pruneEmptyDirectories: (id: string) => ipcRenderer.invoke('cloud:prune-empty-directories', id),
    restoreSplitFiles: (id: string) => ipcRenderer.invoke('cloud:restore-split-files', id),
    getRestoreProgress: (id: string) => ipcRenderer.invoke('cloud:restore-progress', id),
    rememberUsage: (id: string, bytes: number, files: number) => ipcRenderer.invoke('memory:set-usage', id, bytes, files),
    searchCloudIndex: (query: string, limit = 120) => ipcRenderer.invoke('cloud:index-search', query, limit),
    rebuildCloudIndex: (id: string) => ipcRenderer.invoke('cloud:index-rebuild', id),
    stageCloudIndex: (id: string) => ipcRenderer.invoke('cloud:index-stage', id),
    commitCloudIndex: (id: string) => ipcRenderer.invoke('cloud:index-commit', id),
    discardCloudIndex: (id: string) => ipcRenderer.invoke('cloud:index-discard', id),
    listDirectory: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:list-directory', id, relativeDirectory),
    selectImportFiles: (id: string) => ipcRenderer.invoke('cloud:select-import-files', id),
    describeImportPaths: (paths: string[]) => ipcRenderer.invoke('cloud:describe-import-paths', paths),
    importSelectedFiles: (id: string, relativeDirectory: string, files: unknown[]) => ipcRenderer.invoke('cloud:import-selected-files', id, relativeDirectory, files),
    importFiles: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:import-files', id, relativeDirectory),
    importFolder: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:import-folder', id, relativeDirectory),
    createProtectedPool: (mode: 'mirror' | 'reed-solomon', originId: string, memberIds: string[], relativeDirectory: string, files: unknown[]) => ipcRenderer.invoke('protected:create-pool', mode, originId, memberIds, relativeDirectory, files),
    deployProtectedPool: (poolId: string, id: string) => ipcRenderer.invoke('protected:deploy', poolId, id),
    finalizeProtectedPool: (poolId: string) => ipcRenderer.invoke('protected:finalize', poolId),
    stageProtectedDelete: (poolId: string, logicalPath: string) => ipcRenderer.invoke('protected:stage-delete', poolId, logicalPath),
    getPendingProtectedDeletions: (id: string) => ipcRenderer.invoke('protected:pending-deletions', id),
    deleteProtectedEntry: (poolId: string, id: string, logicalPath: string) => ipcRenderer.invoke('protected:delete-entry', poolId, id, logicalPath),
    finalizeProtectedDelete: (poolId: string, logicalPath: string) => ipcRenderer.invoke('protected:finalize-delete', poolId, logicalPath),
    markProtectedPoolDegraded: (poolId: string) => ipcRenderer.invoke('protected:mark-degraded', poolId),
    getReedSolomonMembers: (id: string) => ipcRenderer.invoke('protected:rs-members', id),
    getProtectedRepairMembers: (id: string) => ipcRenderer.invoke('protected:repair-members', id),
    markProtectedGameInaccessible: (id: string) => ipcRenderer.invoke('protected:mark-inaccessible', id),
    markProtectedGameAccessible: (id: string) => ipcRenderer.invoke('protected:mark-accessible', id),
    getProtectedRepairIssue: (id: string) => ipcRenderer.invoke('protected:repair-issue', id),
    prepareProtectedReplacement: (triggerId: string, corruptId: string, replacementId: string) => ipcRenderer.invoke('protected:repair-replacement', triggerId, corruptId, replacementId),
    prepareProtectedGather: (triggerId: string, destinationId: string) => ipcRenderer.invoke('protected:repair-gather-prepare', triggerId, destinationId),
    applyProtectedGather: (planId: string, id: string) => ipcRenderer.invoke('protected:repair-gather-apply', planId, id),
    cleanupProtectedGather: (planId: string, id: string) => ipcRenderer.invoke('protected:repair-gather-cleanup', planId, id),
    finalizeProtectedGather: (planId: string) => ipcRenderer.invoke('protected:repair-gather-finalize', planId),
    cleanupRetiredProtectedPools: (id: string) => ipcRenderer.invoke('protected:cleanup-retired', id),
    createFolder: (id: string, relativeDirectory: string, name: string) => ipcRenderer.invoke('cloud:create-folder', id, relativeDirectory, name),
    deleteEntry: (id: string, relativePath: string) => ipcRenderer.invoke('cloud:delete', id, relativePath),
    openFolder: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:open-folder', id, relativeDirectory),
    revealEntry: (id: string, relativePath: string) => ipcRenderer.invoke('cloud:reveal-entry', id, relativePath),
    getLogs: (id: string) => ipcRenderer.invoke('cloud:logs', id),
    onFilesDropped: (callback: (paths: string[]) => void) => {
        droppedFileListeners.add(callback);
        return () => droppedFileListeners.delete(callback);
    },
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
    isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
    requestWindowClose: () => ipcRenderer.send('window:request-close'),
    onFullscreenChanged: (callback: (fullscreen: boolean) => void) => {
        const listener = (_event: IpcRendererEvent, fullscreen: boolean) => callback(fullscreen);
        ipcRenderer.on('window:fullscreen-changed', listener);
        return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
    },
    onWindowCloseRequested: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('app:close-request', listener);
        return () => ipcRenderer.removeListener('app:close-request', listener);
    },
    confirmWindowClose: () => ipcRenderer.send('app:close-ready'),
    cancelWindowClose: () => ipcRenderer.send('app:close-cancel')
});
