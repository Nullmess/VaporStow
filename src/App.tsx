import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppStatus, AuditEntry, CloudTransferProgress, DirectoryListing, GameStatus, SplitRestoreProgress } from './types';

type GameId = GameStatus['id'];
type Phase = 'closed' | 'opening' | 'open' | 'saving' | 'saved';
type NavDirection = 'forward' | 'back' | 'same';

type ModalState =
    | null
    | { kind: 'open'; game: GameStatus }
    | { kind: 'import'; game: GameStatus; directory: string }
    | { kind: 'folder'; game: GameStatus; directory: string }
    | { kind: 'delete'; game: GameStatus; entry: AuditEntry }
    | { kind: 'message'; title: string; body: string };

const GIB = 1024 ** 3;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeRelative(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function parentDirectory(value: string): string {
    const parts = normalizeRelative(value).split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function depth(value: string): number {
    return normalizeRelative(value).split('/').filter(Boolean).length;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[exponent]}`;
}

function formatEta(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const rounded = Math.max(0, Math.round(seconds));
    if (rounded < 60) return `~${rounded}s`;
    const minutes = Math.floor(rounded / 60);
    const remain = rounded % 60;
    if (minutes < 60) return `~${minutes}m ${remain}s`;
    const hours = Math.floor(minutes / 60);
    return `~${hours}h ${minutes % 60}m`;
}

function formatIdle(seconds: number): string {
    const rounded = Math.max(0, Math.floor(seconds));
    if (rounded < 60) return `${rounded}s`;
    const minutes = Math.floor(rounded / 60);
    const remain = rounded % 60;
    if (minutes < 60) return `${minutes}m ${String(remain).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function displayFileName(value: string): string {
    const normalized = value.replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() || value;
}

function quotaLabel(bytes: number): string {
    return `${(bytes / GIB).toFixed(2)} GiB`;
}

function remainingFileSlots(game: GameStatus, open: boolean): number | null {
    const used = open ? game.cloudFiles : game.rememberedFiles;
    return used === null ? null : Math.max(0, game.maxFiles - used);
}

function usageLabel(game: GameStatus, open: boolean): string {
    const current = open ? game.auditBytes : game.rememberedBytes;
    const remaining = remainingFileSlots(game, open);
    const files = remaining === null ? '?' : remaining.toLocaleString();
    return `${current === null ? '?' : formatBytes(current)} / ${quotaLabel(game.quotaBytes)} · ${files} files left`;
}

function statusTone(game: GameStatus): 'missing' | 'idle' | 'running' {
    if (game.running) return 'running';
    if (game.installed) return 'idle';
    return 'missing';
}

function operationTitle(phase: Phase, gameName: string): string {
    if (phase === 'opening') return `Opening ${gameName}`;
    if (phase === 'saving') return 'Synchronizing';
    return 'Cloud saved';
}

function operationProgressSubtitle(
    phase: Phase,
    progress: CloudTransferProgress | null | undefined,
    isSplitRestore: boolean
): string | null {
    if (!progress || phase === 'saved') return null;
    if (progress.state === 'uploading') return 'Uploading to Steam Cloud…';
    if (progress.state === 'downloading') return 'Downloading from Steam Cloud…';
    if (progress.state === 'rebuilding') return 'Rebuilding split file…';
    if (progress.state === 'waiting' && isSplitRestore) return 'Waiting for Steam Cloud…';
    if (progress.state === 'evaluating') return 'Checking Steam Cloud…';
    return null;
}

function operationFallbackSubtitle(phase: Phase): string {
    if (phase === 'opening') return 'Steam is restoring the cloud locally.';
    if (phase === 'saving') return 'Preparing local changes and synchronizing with Steam Cloud.';
    return 'The cloud is up to date.';
}

async function restoreSplitFilesSafe(id: GameId): Promise<void> {
    try {
        await window.vaporApi.restoreSplitFiles(id);
    } catch {
        // Un restore de recovery est best-effort et idempotent.
    }
}

// Composants UI locaux.

function OpenLocationIcon({ size = 14 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M14 5h5v5" />
            <path d="M19 5l-8 8" />
            <path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" />
        </svg>
    );
}

function Operation({
    phase,
    gameName,
    detail,
    progress
}: {
    phase: Phase;
    gameName: string;
    detail?: string | null;
    progress?: CloudTransferProgress | null;
}) {
    if (phase === 'closed' || phase === 'open') return null;

    const title = operationTitle(phase, gameName);
    const isSplitRestore = Boolean(
        phase === 'opening'
        && progress
        && progress.direction === 'unknown'
        && (progress.totalParts ?? 0) > 0
    );
    const idleSeconds = progress?.idleSeconds ?? null;
    const progressSubtitle = operationProgressSubtitle(phase, progress, isSplitRestore);
    const subtitle = progressSubtitle || detail || operationFallbackSubtitle(phase);

    const determinate = phase !== 'saved' && progress?.percent !== null && progress?.percent !== undefined;
    const percent = determinate ? Math.max(0, Math.min(100, progress!.percent!)) : null;
    const mainStats: string[] = [];
    const detailStats: string[] = [];
    const speedStats: string[] = [];

    if (progress && phase !== 'saved') {
        if (percent !== null) mainStats.push(`${Math.round(percent)}%`);
        if (progress.totalBytes !== null && progress.totalBytes > 0) {
            mainStats.push(`${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)}`);
        }

        if (isSplitRestore) {
            const total = progress.currentFileTotalParts && progress.currentFileTotalParts > 0
                ? progress.currentFileTotalParts
                : (progress.totalParts ?? 0);
            const ready = Math.max(0, Math.min(total, progress.currentFileReceivedParts ?? progress.receivedParts ?? 0));
            const rebuilt = Math.max(0, Math.min(total, progress.currentFileCompletedParts ?? progress.completedParts ?? 0));
            const waiting = Math.max(0, total - ready);

            if (total > 0) {
                if (ready === rebuilt) detailStats.push(`${ready} / ${total} parts`);
                else detailStats.push(`${ready} ready · ${rebuilt} rebuilt`);
                if (waiting > 0) detailStats.push(`${waiting} waiting`);
            }
        } else if (progress.totalFiles !== null && progress.totalFiles > 1) {
            // Ne pas dupliquer le nombre de fichiers restants.
            detailStats.push(`${progress.completedFiles} / ${progress.totalFiles} files`);
        }

        if (progress.speedBytesPerSecond !== null && progress.speedBytesPerSecond > 0) {
            speedStats.push(`${formatBytes(progress.speedBytesPerSecond)}/s`);
        }
        if (progress.etaSeconds !== null && progress.etaSeconds >= 0) {
            speedStats.push(formatEta(progress.etaSeconds));
        }
    }

    const currentFile = progress?.currentFile ? displayFileName(progress.currentFile) : null;
    const showIdleWarning = Boolean(isSplitRestore && progress?.state === 'waiting' && idleSeconds !== null && idleSeconds >= 10);

    return (
        <section className={`operation-screen ${phase}`}>
            <div className="sync-orbit" aria-hidden="true"><span /></div>
            <strong>{title}</strong>
            <p>{subtitle}</p>
            {phase !== 'saved' && (
                <>
                    <div
                        className={`operation-progress ${determinate ? 'determinate' : ''}`}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent === null ? undefined : Math.round(percent)}
                    >
                        <span style={percent === null ? undefined : { width: `${percent}%` }} />
                    </div>
                    {mainStats.length > 0 && (
                        <div className="transfer-stats transfer-main" aria-live="polite">{mainStats.join(' · ')}</div>
                    )}
                    {detailStats.length > 0 && (
                        <div className="transfer-stats transfer-detail">{detailStats.join(' · ')}</div>
                    )}
                    {speedStats.length > 0 && (
                        <div className="transfer-stats transfer-speed">{speedStats.join(' · ')}</div>
                    )}
                    {showIdleWarning && (
                        <div className="transfer-idle">No new Steam data for {formatIdle(idleSeconds!)}</div>
                    )}
                    {currentFile && phase !== 'saved' && (
                        <div className="transfer-current" title={progress?.currentFile || currentFile}>
                            {currentFile}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}

function Breadcrumbs({ directory, onNavigate }: { directory: string; onNavigate: (path: string) => void }) {
    const parts = normalizeRelative(directory).split('/').filter(Boolean);

    return (
        <nav className="breadcrumbs" aria-label="Current folder">
            <button onClick={() => onNavigate('')}>Cloud</button>
            {parts.map((part, index) => {
                const target = parts.slice(0, index + 1).join('/');
                return (
                    <span key={target}>
                        <i>/</i>
                        <button onClick={() => onNavigate(target)}>{part}</button>
                    </span>
                );
            })}
        </nav>
    );
}

function Explorer({
    game,
    listing,
    selected,
    setSelected,
    navigate,
    setModal,
    synchronize,
    syncNotice,
    navDirection,
    navKey
}: {
    game: GameStatus;
    listing: DirectoryListing;
    selected: AuditEntry | null;
    setSelected: (entry: AuditEntry | null) => void;
    navigate: (directory: string) => Promise<void>;
    setModal: (modal: ModalState) => void;
    synchronize: (game: GameStatus) => Promise<void>;
    syncNotice: string | null;
    navDirection: NavDirection;
    navKey: number;
}) {
    const directory = normalizeRelative(listing.directory);
    const fileSlots = remainingFileSlots(game, true);

    async function openSystemFolder() {
        try {
            await window.vaporApi.openFolder(game.id, directory);
        } catch (error) {
            setModal({
                kind: 'message',
                title: 'Unable to open folder',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async function revealEntry(entry: AuditEntry) {
        try {
            await window.vaporApi.revealEntry(game.id, normalizeRelative(entry.path));
        } catch (error) {
            setModal({
                kind: 'message',
                title: 'Unable to show item',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }

    return (
        <section className="cloud-view">
            <div className="cloud-topbar">
                <div className="cloud-title">
                    <span className="status-dot running" />
                    <strong>{game.name}</strong>
                    <small>{usageLabel(game, true)}</small>
                </div>
                <button className="save-button" onClick={() => void synchronize(game)}>Synchronize</button>
            </div>

            {syncNotice && <div className="sync-notice" role="status">{syncNotice}</div>}

            <div className="explorer-bar">
                <div className="path-side">
                    <button
                        className="icon-button"
                        aria-label="Parent folder"
                        title="Parent folder"
                        disabled={!directory}
                        onClick={() => void navigate(parentDirectory(directory))}
                    >
                        ←
                    </button>
                    <Breadcrumbs directory={directory} onNavigate={(target) => void navigate(target)} />
                </div>

                <div className="explorer-actions">
                    <button
                        title={fileSlots === 0 ? 'No new file slots remain; replacing existing files is still possible' : 'Import files or a folder'}
                        onClick={() => setModal({ kind: 'import', game, directory })}
                    >
                        Import
                    </button>
                    <button onClick={() => setModal({ kind: 'folder', game, directory })}>New folder</button>
                    <button
                        className="explorer-location-button"
                        onClick={() => void openSystemFolder()}
                        title="Open current folder in the system file manager"
                        aria-label="Open current folder in the system file manager"
                    >
                        <OpenLocationIcon />
                    </button>
                    <button
                        disabled={!selected}
                        onClick={() => selected && setModal({ kind: 'delete', game, entry: selected })}
                    >
                        Delete
                    </button>
                </div>
            </div>

            <div className="file-table" role="listbox" aria-label={`${game.name} cloud files`}>
                <div key={`${listing.directory}-${navKey}`} className={`file-list-motion ${navDirection}`}>
                    {directory && (
                        <button
                            className="file-row parent-row"
                            onDoubleClick={() => void navigate(parentDirectory(directory))}
                            onClick={() => void navigate(parentDirectory(directory))}
                        >
                            <span className="file-icon">↰</span>
                            <span className="file-name">..</span>
                            <span />
                            <span />
                        </button>
                    )}

                    {listing.entries.length === 0 ? (
                        <div className="empty-folder">This folder is empty</div>
                    ) : listing.entries.map((entry) => {
                        const cleanPath = normalizeRelative(entry.path);
                        const normalizedEntry = { ...entry, path: cleanPath };
                        const isSelected = selected?.path === cleanPath;
                        return (
                            <div
                                key={cleanPath}
                                className={`file-row ${entry.type} ${isSelected ? 'selected' : ''}`}
                                role="option"
                                aria-selected={isSelected}
                                tabIndex={0}
                                onClick={() => setSelected(normalizedEntry)}
                                onDoubleClick={() => {
                                    if (entry.type === 'directory') void navigate(cleanPath);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && entry.type === 'directory') void navigate(cleanPath);
                                    if (event.key === ' ') {
                                        event.preventDefault();
                                        setSelected(normalizedEntry);
                                    }
                                }}
                            >
                                <span className="file-icon">{entry.type === 'directory' ? '▸' : '·'}</span>
                                <span className="file-name">{entry.name}</span>
                                <span className="file-size">{entry.type === 'file' ? formatBytes(entry.size) : ''}</span>
                                <button
                                    className="reveal-button"
                                    aria-label={`Show ${entry.name} in system folder`}
                                    title="Show in folder"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setSelected(normalizedEntry);
                                        void revealEntry(normalizedEntry);
                                    }}
                                    onDoubleClick={(event) => event.stopPropagation()}
                                >
                                    <OpenLocationIcon size={13} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="cloud-footer">
                <span>{formatBytes(game.auditBytes)} / {quotaLabel(game.quotaBytes)}</span>
                <span>{remainingFileSlots(game, true)?.toLocaleString() ?? '?'} file slots left</span>
                <span>{game.disk ? `${formatBytes(game.disk.free)} free` : 'Free space unknown'}</span>
            </div>
        </section>
    );
}

function Modal({
    modal,
    close,
    refresh,
    reloadDirectory,
    confirmOpen
}: {
    modal: ModalState;
    close: () => void;
    refresh: () => Promise<AppStatus>;
    reloadDirectory: (id: GameId, directory: string) => Promise<void>;
    confirmOpen: (game: GameStatus) => Promise<void>;
}) {
    const [value, setValue] = useState('');
    const [visibleModal, setVisibleModal] = useState<ModalState>(modal);
    const [closing, setClosing] = useState(false);
    const [working, setWorking] = useState(false);

    useEffect(() => {
        if (modal) {
            setVisibleModal(modal);
            setClosing(false);
            setWorking(false);
            setValue('');
            return;
        }

        if (visibleModal) {
            setClosing(true);
            const timer = window.setTimeout(() => {
                setVisibleModal(null);
                setClosing(false);
            }, 150);
            return () => window.clearTimeout(timer);
        }
    }, [modal, visibleModal]);

    if (!visibleModal) return null;

    async function run(action: () => Promise<unknown>, game?: GameStatus, directory?: string) {
        if (working) return;
        setWorking(true);
        try {
            await action();
            close();
            await refresh();
            if (game && directory !== undefined) await reloadDirectory(game.id, directory);
        } catch (error) {
            setWorking(false);
            setValue('');
            alert(error instanceof Error ? error.message : String(error));
        }
    }

    const requestClose = () => {
        if (!working) close();
    };
    const active = visibleModal;
    let content: ReactNode;

    if (active.kind === 'open') {
        const game = active.game;
        const firstOpen = game.rememberedBytes === null;
        const required = firstOpen ? game.quotaBytes : game.rememberedBytes || 0;
        const available = game.disk?.free ?? null;
        const enough = game.running || (available !== null && available >= required);

        content = (
            <>
                <h3>Open {game.name}</h3>
                <p className="modal-copy">
                    Make sure enough local space is available. Steam restores the complete cloud set before the game starts.
                </p>
                <p className="modal-copy subtle">
                    {firstOpen
                        ? `Current usage is unknown. VaporStow checks against the full ${quotaLabel(game.quotaBytes)} quota.`
                        : `Last remembered usage: ${formatBytes(game.rememberedBytes || 0)} · ${remainingFileSlots(game, false)?.toLocaleString() ?? '?'} file slots left.`}
                </p>
                <div className="space-check">
                    <span>Required</span><strong>{formatBytes(required)}</strong>
                    <span>Available</span><strong>{available === null ? 'Unknown' : formatBytes(available)}</strong>
                </div>
                {!enough && (
                    <div className="space-warning">
                        {available === null ? 'Local free space could not be verified.' : 'Not enough free local space.'}
                    </div>
                )}
                <div className="modal-actions">
                    <button onClick={requestClose}>Cancel</button>
                    <button className="primary" disabled={!enough} onClick={() => void confirmOpen(game)}>Open</button>
                </div>
            </>
        );
    } else if (active.kind === 'import') {
        const remaining = remainingFileSlots(active.game, true);
        const noSlots = remaining !== null && remaining <= 0;
        content = (
            <>
                <h3>Import</h3>
                <p className="modal-copy subtle">Destination: /{normalizeRelative(active.directory)}</p>
                <div className="slot-check">
                    <span>File slots</span>
                    <strong>{remaining === null ? '?' : remaining.toLocaleString()} / {active.game.maxFiles.toLocaleString()} remaining</strong>
                </div>
                {noSlots && <p className="modal-copy warning-copy">No new file slots remain. Replacing an existing file is allowed, but any import that adds a new file will be blocked.</p>}
                <div className="choice-row">
                    <button disabled={working} onClick={() => void run(() => window.vaporApi.importFiles(active.game.id, active.directory), active.game, active.directory)}>
                        {working ? 'Importing…' : 'Files'}
                    </button>
                    <button disabled={working} onClick={() => void run(() => window.vaporApi.importFolder(active.game.id, active.directory), active.game, active.directory)}>
                        {working ? 'Importing…' : 'Folder'}
                    </button>
                </div>
                {working && <p className="modal-copy subtle">Copying locally. Large files can take several minutes.</p>}
                <div className="modal-actions"><button disabled={working} onClick={requestClose}>Cancel</button></div>
            </>
        );
    } else if (active.kind === 'folder') {
        const location = normalizeRelative(active.directory);
        content = (
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!value.trim()) return;
                    void run(
                        () => window.vaporApi.createFolder(active.game.id, active.directory, value),
                        active.game,
                        active.directory
                    );
                }}
            >
                <h3>New folder</h3>
                <p className="modal-copy subtle">Create in {location ? `Cloud / ${location}` : 'Cloud'}</p>
                <input
                    className="text-input"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    autoFocus
                    placeholder="Folder name"
                    maxLength={120}
                />
                <div className="modal-actions">
                    <button type="button" onClick={requestClose}>Cancel</button>
                    <button className="primary" type="submit" disabled={!value.trim()}>Create</button>
                </div>
            </form>
        );
    } else if (active.kind === 'delete') {
        const parent = parentDirectory(active.entry.path);
        const isFolder = active.entry.type === 'directory';
        content = (
            <>
                <h3>Delete {isFolder ? 'folder' : 'file'}?</h3>
                <div className="delete-target">
                    <span>{isFolder ? 'Folder' : 'File'}</span>
                    <strong>{active.entry.name}</strong>
                </div>
                <p className="modal-copy warning-copy">
                    {isFolder
                        ? 'The folder and everything inside it will be removed from the local cloud mirror.'
                        : 'This file will be removed from the local cloud mirror.'}
                </p>
                <p className="modal-copy subtle">The deletion is sent to Steam Cloud when you synchronize.</p>
                <div className="modal-actions">
                    <button onClick={requestClose}>Cancel</button>
                    <button
                        className="danger"
                        onClick={() => void run(() => window.vaporApi.deleteEntry(active.game.id, active.entry.path), active.game, parent)}
                    >
                        Delete
                    </button>
                </div>
            </>
        );
    } else {
        content = (
            <>
                <h3>{active.title}</h3>
                <p className="modal-copy">{active.body}</p>
                <div className="modal-actions"><button className="primary" onClick={requestClose}>Close</button></div>
            </>
        );
    }

    return (
        <div className={`modal-backdrop ${closing ? 'closing' : ''}`} onMouseDown={requestClose}>
            <div className={`modal ${closing ? 'closing' : ''}`} onMouseDown={(event) => event.stopPropagation()}>{content}</div>
        </div>
    );
}

// Orchestration de la session Steam Cloud.

export default function App() {
    const [status, setStatus] = useState<AppStatus | null>(null);
    const [modal, setModal] = useState<ModalState>(null);
    const [loading, setLoading] = useState(true);
    const [activeGameId, setActiveGameId] = useState<GameId | null>(null);
    const [phase, setPhase] = useState<Phase>('closed');
    const [listing, setListing] = useState<DirectoryListing>({ directory: '', entries: [] });
    const [selected, setSelected] = useState<AuditEntry | null>(null);
    const [navDirection, setNavDirection] = useState<NavDirection>('same');
    const [navKey, setNavKey] = useState(0);
    const [syncNotice, setSyncNotice] = useState<string | null>(null);
    const [operationDetail, setOperationDetail] = useState<string | null>(null);
    const [transferProgress, setTransferProgress] = useState<CloudTransferProgress | null>(null);

    const refresh = useCallback(async (): Promise<AppStatus> => {
        const next = await window.vaporApi.getStatus();
        setStatus(next);
        setLoading(false);
        return next;
    }, []);

    const reloadDirectory = useCallback(async (id: GameId, directory: string): Promise<void> => {
        const next = await window.vaporApi.listDirectory(id, normalizeRelative(directory));
        setListing({
            directory: normalizeRelative(next.directory),
            entries: next.entries.map((entry) => ({ ...entry, path: normalizeRelative(entry.path) }))
        });
        setSelected(null);
    }, []);

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), 4000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const activeGame = useMemo(
        () => status?.games.find((game) => game.id === activeGameId) ?? null,
        [status, activeGameId]
    );

    async function waitForSteamRunning(expected: boolean): Promise<AppStatus> {
        const started = Date.now();
        while (Date.now() - started < 10 * 60 * 1000) {
            const next = await window.vaporApi.getStatus();
            setStatus(next);
            if (next.steamRunning === expected) return next;
            await sleep(750);
        }
        throw new Error(`Steam did not ${expected ? 'start' : 'close'} in time.`);
    }

    async function waitForRunning(
        id: GameId,
        expected: boolean,
        cloudMarker?: number,
        direction: 'up' | 'down' | 'auto' = 'auto'
    ): Promise<GameStatus> {
        const started = Date.now();
        let nextLaunchRetry = started + 15_000;
        let launchRetryDelay = 15_000;

        while (Date.now() - started < 6 * 60 * 60 * 1000) {
            const [next, progress] = await Promise.all([
                window.vaporApi.getStatus(),
                cloudMarker === undefined
                    ? Promise.resolve<CloudTransferProgress | null>(null)
                    : window.vaporApi.getCloudProgress(id, cloudMarker, direction).catch(() => null)
            ]);
            setStatus(next);

            const game = next.games.find((item) => item.id === id);
            if (!game) throw new Error('Game status disappeared.');
            if (game.running === expected) return game;

            if (progress) {
                setTransferProgress(progress);
                if (progress.state !== 'waiting') {
                    const waitingLaunch = expected && progress.state === 'complete';
                    setOperationDetail(waitingLaunch
                        ? 'Steam Cloud synchronized. Waiting for Steam to launch the game…'
                        : progress.message);
                }
            }

            // Relancer avec backoff si une update Steam a consommé la demande.
            const now = Date.now();
            const retryReady = progress?.state === 'complete' || now - started >= 120_000;
            if (expected && retryReady && now >= nextLaunchRetry) {
                setOperationDetail('Waiting for Steam to launch the game…');
                await window.vaporApi.runGame(id);
                launchRetryDelay = Math.min(launchRetryDelay * 2, 120_000);
                nextLaunchRetry = Date.now() + launchRetryDelay;
            }

            await sleep(cloudMarker === undefined ? 1250 : 550);
        }
        throw new Error('Steam did not finish the operation in time.');
    }

    async function confirmOpen(game: GameStatus) {
        try {
            setModal(null);
            await sleep(120);
            setActiveGameId(game.id);
            setPhase('opening');
            setListing({ directory: '', entries: [] });
            setSelected(null);
            setNavDirection('same');
            setSyncNotice(null);
            setNavKey((value) => value + 1);

            // Sérialiser Steam, jeu, rebuild puis explorer sous la même animation.
            let openingStatus = await window.vaporApi.getStatus();
            setStatus(openingStatus);
            if (!openingStatus.steamInstalled) throw new Error('Steam is not installed.');

            setTransferProgress(null);
            if (!openingStatus.steamRunning) {
                setOperationDetail('Starting Steam…');
                await window.vaporApi.runSteam();
                openingStatus = await waitForSteamRunning(true);
            }

            // Réinitialiser le Cloud log et fallback sur un marker s'il reste verrouillé.
            setOperationDetail('Preparing Steam Cloud session…');
            const pullLog = await window.vaporApi.resetCloudLog();

            setOperationDetail('Starting the game and restoring Steam Cloud…');
            await window.vaporApi.startBackgroundGuard(game.id);
            const currentGame = openingStatus.games.find((item) => item.id === game.id) || game;
            let synced = currentGame;
            if (!currentGame.running) {
                await window.vaporApi.runGame(game.id);
                synced = await waitForRunning(game.id, true, pullLog.marker, 'down');
                const finalPull = await window.vaporApi.getCloudProgress(game.id, pullLog.marker, 'down').catch(() => null);
                if (finalPull) setTransferProgress(finalPull);
            }

            // Rebuild les payloads split après le pull et avant d'afficher l'explorer.
            setOperationDetail('Rebuilding split files…');
            setTransferProgress(null);

            let restoreFinished = false;
            const restorePromise = window.vaporApi.restoreSplitFiles(game.id);
            void restorePromise.then(
                () => { restoreFinished = true; },
                () => { restoreFinished = true; }
            );

            while (!restoreFinished) {
                const rebuild = await window.vaporApi.getRestoreProgress(game.id).catch(() => null);
                if (rebuild) {
                    const mapped: CloudTransferProgress = {
                        state: rebuild.state === 'complete'
                            ? 'complete'
                            : rebuild.state === 'waiting'
                                ? 'waiting'
                                : 'rebuilding',
                        direction: 'unknown',
                        percent: rebuild.percent,
                        transferredBytes: rebuild.processedBytes,
                        totalBytes: rebuild.totalBytes,
                        completedFiles: rebuild.completedFiles,
                        totalFiles: rebuild.totalFiles,
                        receivedParts: rebuild.receivedParts,
                        completedParts: rebuild.completedParts,
                        totalParts: rebuild.totalParts,
                        currentFileIndex: rebuild.currentFileIndex,
                        currentFileReceivedParts: rebuild.currentFileReceivedParts,
                        currentFileCompletedParts: rebuild.currentFileCompletedParts,
                        currentFileTotalParts: rebuild.currentFileTotalParts,
                        cachedPartsUsed: rebuild.cachedPartsUsed,
                        idleSeconds: rebuild.idleSeconds,
                        speedBytesPerSecond: rebuild.speedBytesPerSecond,
                        etaSeconds: rebuild.etaSeconds,
                        currentFile: rebuild.currentFile,
                        message: rebuild.message,
                        logPath: null
                    };
                    setTransferProgress(mapped);
                    setOperationDetail(rebuild.message);
                }
                if (!restoreFinished) await sleep(140);
            }

            await restorePromise;
            const finalRebuild: SplitRestoreProgress | null = await window.vaporApi.getRestoreProgress(game.id).catch(() => null);
            if (finalRebuild?.totalFiles) {
                setTransferProgress({
                    state: 'complete',
                    direction: 'unknown',
                    percent: 100,
                    transferredBytes: finalRebuild.totalBytes,
                    totalBytes: finalRebuild.totalBytes,
                    completedFiles: finalRebuild.totalFiles,
                    totalFiles: finalRebuild.totalFiles,
                    receivedParts: finalRebuild.totalParts,
                    completedParts: finalRebuild.totalParts,
                    totalParts: finalRebuild.totalParts,
                    currentFileIndex: null,
                    currentFileReceivedParts: 0,
                    currentFileCompletedParts: 0,
                    currentFileTotalParts: 0,
                    cachedPartsUsed: finalRebuild.cachedPartsUsed,
                    idleSeconds: null,
                    speedBytesPerSecond: finalRebuild.speedBytesPerSecond,
                    etaSeconds: 0,
                    currentFile: null,
                    message: 'Split files rebuilt.',
                    logPath: null
                });
                setOperationDetail('Split files rebuilt.');
                await sleep(180);
            }

            setOperationDetail('Preparing cloud…');
            const restoredStatus = await window.vaporApi.getStatus();
            setStatus(restoredStatus);
            const restoredGame = restoredStatus.games.find((item) => item.id === game.id) || synced;
            await window.vaporApi.rememberUsage(game.id, restoredGame.auditBytes, restoredGame.cloudFiles);
            await refresh();
            await reloadDirectory(game.id, '');
            await sleep(320);
            setOperationDetail(null);
            setTransferProgress(null);
            setPhase('open');
        } catch (error) {
            try { await window.vaporApi.stopBackgroundGuard(game.id); } catch {}
            setOperationDetail(null);
            setTransferProgress(null);
            setPhase('closed');
            setActiveGameId(null);
            setModal({
                kind: 'message',
                title: 'Unable to open cloud',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async function navigate(directory: string) {
        if (!activeGameId) return;
        const target = normalizeRelative(directory);
        const current = normalizeRelative(listing.directory);
        const direction: NavDirection = depth(target) > depth(current) ? 'forward' : depth(target) < depth(current) ? 'back' : 'same';

        try {
            setNavDirection(direction);
            await reloadDirectory(activeGameId, target);
            setNavKey((value) => value + 1);
        } catch (error) {
            setModal({
                kind: 'message',
                title: 'Unable to open folder',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }

    function closeCloudSession() {
        setActiveGameId(null);
        setSyncNotice(null);
        setOperationDetail(null);
        setTransferProgress(null);
        setPhase('closed');
        setListing({ directory: '', entries: [] });
        setNavDirection('same');
        setNavKey((value) => value + 1);
    }

    async function synchronize(game: GameStatus) {
        let stopStarted = false;

        try {
            setSelected(null);
            setSyncNotice(null);
            setOperationDetail('Preparing files…');
            setTransferProgress(null);
            setPhase('saving');

            // Préparer le split transactionnel avant la fermeture du jeu et la sync.
            const preparation = await window.vaporApi.prepareSync(game.id);
            if (preparation.splitFiles > 0 && preparation.reusedParts > 0) {
                setOperationDetail(
                    `Chunks ready · ${preparation.reusedParts} unchanged reused · ${preparation.rewrittenParts} changed`
                );
                await sleep(220);
            }
            setOperationDetail('Closing the game…');

            const beforeStop = await window.vaporApi.getStatus();
            setStatus(beforeStop);
            const current = beforeStop.games.find((item) => item.id === game.id) || game;
            if (!current.running) {
                throw new Error('The Steam session closed before VaporStow could start synchronization.');
            }

            let syncResult: Awaited<ReturnType<typeof window.vaporApi.waitForCloudSync>> | null = null;

            // Réinitialiser le Cloud log juste avant la fermeture pour isoler ce push.
            setOperationDetail('Preparing Steam Cloud upload…');
            await window.vaporApi.resetCloudLog();

            stopStarted = true;
            const stopped = await window.vaporApi.requestStop(game.id);
            await waitForRunning(game.id, false, stopped.cloudLogMarker, 'up');
            setOperationDetail('Waiting for Steam Cloud…');

            let syncFinished = false;
            const syncPromise = window.vaporApi.waitForCloudSync(game.id, stopped.cloudLogMarker)
                .finally(() => { syncFinished = true; });

            while (!syncFinished) {
                const progress = await window.vaporApi.getCloudProgress(game.id, stopped.cloudLogMarker, 'up').catch(() => null);
                if (progress) {
                    setTransferProgress(progress);
                    setOperationDetail(progress.message);
                }
                if (!syncFinished) await sleep(500);
            }

            syncResult = await syncPromise;
            const finalProgress = await window.vaporApi.getCloudProgress(game.id, stopped.cloudLogMarker, 'up').catch(() => null);
            if (finalProgress) {
                setTransferProgress(finalProgress.state === 'complete' ? { ...finalProgress, percent: 100 } : finalProgress);
                setOperationDetail(finalProgress.state === 'complete' ? 'Steam Cloud synchronized.' : finalProgress.message);
            }

            if (syncResult.state !== 'complete') {
                closeCloudSession();
                await refresh();
                setModal({
                    kind: 'message',
                    title: syncResult.state === 'failed' ? 'Steam Cloud sync failed' : 'Steam Cloud status unknown',
                    body: syncResult.message
                });
                return;
            }

            // Garder localement la représentation split qui vient d'être synchronisée.
            const afterSync = await window.vaporApi.getStatus();
            setStatus(afterSync);
            const syncedState = afterSync.games.find((item) => item.id === game.id) || current;
            await window.vaporApi.rememberUsage(game.id, syncedState.auditBytes, syncedState.cloudFiles);

            // Conserver le progress final pour l'animation puis vider le Cloud log.
            await window.vaporApi.resetCloudLog();

            setOperationDetail('Steam Cloud synchronized.');
            setPhase('saved');
            await sleep(syncResult.reason === 'no-changes' ? 850 : 1100);

            closeCloudSession();
            await refresh();
        } catch (error) {
            // Restaurer les originaux si l'échec arrive avant la fermeture du jeu.
            if (!stopStarted) {
                await restoreSplitFilesSafe(game.id);

                try {
                    await refresh();
                    await reloadDirectory(game.id, listing.directory);
                    setActiveGameId(game.id);
                    setPhase('open');
                } catch {
                    setActiveGameId(null);
                    setPhase('closed');
                    setListing({ directory: '', entries: [] });
                }
            } else {
                setActiveGameId(null);
                setPhase('closed');
                setListing({ directory: '', entries: [] });
                await refresh();
            }

            setSyncNotice(null);
            setOperationDetail(null);
            setTransferProgress(null);
            setModal({
                kind: 'message',
                title: 'Synchronization interrupted',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }

    if (loading || !status) return <main className="loading">VaporStow</main>;

    const stageKey = activeGameId ? `${activeGameId}-${phase}` : 'volumes';

    return (
        <>
            <main className={`shell ${activeGameId ? 'focused' : ''}`}>
                <header>
                    <div className="brand">VaporStow <span>v{status.appVersion}</span></div>
                    <button
                        className={`steam ${!status.steamInstalled ? 'missing' : status.steamRunning ? 'ok' : 'idle'}`}
                        title={!status.steamInstalled ? 'Steam is not installed' : status.steamRunning ? 'Steam is running' : 'Steam is installed but not running'}
                        onClick={() => !status.steamInstalled && void window.vaporApi.openSteamDownload()}
                    >
                        <i /> Steam
                    </button>
                </header>

                <div className="stage" key={stageKey}>
                    {!status.steamInstalled && !activeGameId && (
                        <button className="steam-required" onClick={() => void window.vaporApi.openSteamDownload()}>
                            Steam is required
                        </button>
                    )}

                    {!activeGameId ? (
                        <section className="volume-list">
                            {status.games.map((game, index) => {
                                const actionLabel = !game.platformSupported
                                    ? 'Store'
                                    : !game.installed
                                        ? 'Install'
                                        : !game.cloudRoot
                                            ? 'Unavailable'
                                            : 'Open';

                                return (
                                    <div className="volume-row" key={game.id} style={{ '--row-index': index } as CSSProperties}>
                                        <div className="volume-name">
                                            <span className={`status-dot ${statusTone(game)}`} />
                                            <strong>{game.name}</strong>
                                        </div>
                                        <span className="volume-usage">{usageLabel(game, false)}</span>
                                        <button
                                            disabled={actionLabel === 'Unavailable'}
                                            onClick={() => {
                                                if (!game.platformSupported) void window.vaporApi.openStore(game.id);
                                                else if (!game.installed) void window.vaporApi.installGame(game.id);
                                                else setModal({ kind: 'open', game });
                                            }}
                                        >
                                            {actionLabel}
                                        </button>
                                    </div>
                                );
                            })}
                        </section>
                    ) : activeGame ? (
                        phase === 'open' ? (
                            <Explorer
                                game={activeGame}
                                listing={listing}
                                selected={selected}
                                setSelected={setSelected}
                                navigate={navigate}
                                setModal={setModal}
                                synchronize={synchronize}
                                syncNotice={syncNotice}
                                navDirection={navDirection}
                                navKey={navKey}
                            />
                        ) : (
                            <Operation phase={phase} gameName={activeGame.name} detail={operationDetail} progress={transferProgress} />
                        )
                    ) : (
                        <div className="loading-inline">Loading volume…</div>
                    )}
                </div>
            </main>

            <Modal
                modal={modal}
                close={() => setModal(null)}
                refresh={refresh}
                reloadDirectory={reloadDirectory}
                confirmOpen={confirmOpen}
            />
        </>
    );
}
