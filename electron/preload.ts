import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('vaporApi', {
    getStatus: () => ipcRenderer.invoke('status:get'),
    openSteamDownload: () => ipcRenderer.invoke('steam:download'),
    runSteam: () => ipcRenderer.invoke('steam:run'),
    openStore: (id: string) => ipcRenderer.invoke('game:open-store', id),
    installGame: (id: string) => ipcRenderer.invoke('game:install', id),
    runGame: (id: string) => ipcRenderer.invoke('game:run', id),
    startBackgroundGuard: (id: string) => ipcRenderer.invoke('game:background-start', id),
    stopBackgroundGuard: (id: string) => ipcRenderer.invoke('game:background-stop', id),
    requestStop: (id: string) => ipcRenderer.invoke('game:request-stop', id),
    getCloudLogMarker: () => ipcRenderer.invoke('cloud:log-marker'),
    resetCloudLog: () => ipcRenderer.invoke('cloud:reset-log'),
    getCloudProgress: (id: string, marker: number, direction: 'up' | 'down' | 'auto' = 'auto') => ipcRenderer.invoke('cloud:progress', id, marker, direction),
    waitForCloudSync: (id: string, marker: number) => ipcRenderer.invoke('cloud:wait-sync', id, marker),
    prepareSync: (id: string) => ipcRenderer.invoke('cloud:prepare-sync', id),
    getCloudContentSummary: (id: string) => ipcRenderer.invoke('cloud:content-summary', id),
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
    importFiles: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:import-files', id, relativeDirectory),
    importFolder: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:import-folder', id, relativeDirectory),
    createFolder: (id: string, relativeDirectory: string, name: string) => ipcRenderer.invoke('cloud:create-folder', id, relativeDirectory, name),
    deleteEntry: (id: string, relativePath: string) => ipcRenderer.invoke('cloud:delete', id, relativePath),
    openFolder: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:open-folder', id, relativeDirectory),
    revealEntry: (id: string, relativePath: string) => ipcRenderer.invoke('cloud:reveal-entry', id, relativePath),
    getLogs: (id: string) => ipcRenderer.invoke('cloud:logs', id),
    onWindowCloseRequested: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('app:close-request', listener);
        return () => ipcRenderer.removeListener('app:close-request', listener);
    },
    confirmWindowClose: () => ipcRenderer.send('app:close-ready'),
    cancelWindowClose: () => ipcRenderer.send('app:close-cancel')
});
