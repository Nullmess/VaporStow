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
    restoreSplitFiles: (id: string) => ipcRenderer.invoke('cloud:restore-split-files', id),
    getRestoreProgress: (id: string) => ipcRenderer.invoke('cloud:restore-progress', id),
    rememberUsage: (id: string, bytes: number, files: number) => ipcRenderer.invoke('memory:set-usage', id, bytes, files),
    listDirectory: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:list-directory', id, relativeDirectory),
    importFiles: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:import-files', id, relativeDirectory),
    importFolder: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:import-folder', id, relativeDirectory),
    createFolder: (id: string, relativeDirectory: string, name: string) => ipcRenderer.invoke('cloud:create-folder', id, relativeDirectory, name),
    deleteEntry: (id: string, relativePath: string) => ipcRenderer.invoke('cloud:delete', id, relativePath),
    openFolder: (id: string, relativeDirectory: string) => ipcRenderer.invoke('cloud:open-folder', id, relativeDirectory),
    revealEntry: (id: string, relativePath: string) => ipcRenderer.invoke('cloud:reveal-entry', id, relativePath),
    getLogs: (id: string) => ipcRenderer.invoke('cloud:logs', id)
});
