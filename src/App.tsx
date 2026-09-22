import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppStatus, AuditEntry, CloudSearchEntry, CloudTransferProgress, DirectoryListing, GameStatus, SplitRestoreProgress } from './types';

type GameId = GameStatus['id'];
type Phase = 'closed' | 'opening' | 'open' | 'closing' | 'saving' | 'saved';
type NavDirection = 'forward' | 'back' | 'same';

type ModalState =
    | null
    | { kind: 'install'; game: GameStatus }
    | { kind: 'open'; game: GameStatus; target?: CloudSearchEntry }
    | { kind: 'import'; game: GameStatus; directory: string }
    | { kind: 'folder'; game: GameStatus; directory: string }
    | { kind: 'delete'; game: GameStatus; entry: AuditEntry }
    | { kind: 'empty-folders-sync'; game: GameStatus }
    | { kind: 'message'; title: string; body: string };

const GIB = 1024 ** 3;
const AFK_TIMEOUT_MS = 10 * 60 * 1000;

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

function requiredSpaceLabel(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
    if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`;
    return formatBytes(bytes);
}

function remainingFileSlots(game: GameStatus, open: boolean): number | null {
    const used = open ? game.cloudFiles : game.rememberedFiles;
    return used === null ? null : Math.max(0, game.maxFiles - used);
}

function usageLabel(game: GameStatus, open: boolean): string {
    const current = open ? game.auditBytes : game.rememberedBytes;
    const remaining = remainingFileSlots(game, open);

    // Before the first Cloud session there is no remembered usage yet.
    // Show the conservative limits instead of question marks.
    if (!open && current === null && remaining === null) {
        return `≤ ${quotaLabel(game.quotaBytes)} · ≤ ${game.maxFiles.toLocaleString()} files`;
    }

    const bytes = current === null ? 'Unknown' : `${formatBytes(current)} / ${quotaLabel(game.quotaBytes)}`;
    const files = remaining === null ? 'Unknown files left' : `${remaining.toLocaleString()} files left`;
    return `${bytes} · ${files}`;
}

function statusTone(game: GameStatus): 'missing' | 'installing' | 'idle' | 'running' {
    if (game.running) return 'running';
    if (game.installing) return 'installing';
    if (game.installed) return 'idle';
    return 'missing';
}

function operationTitle(phase: Phase, gameName: string): string {
    if (phase === 'opening') return `Opening ${gameName}`;
    if (phase === 'closing') return 'Closing cloud session';
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
    if (phase === 'closing') return 'Closing the hidden game and leaving the Cloud safely.';
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

function SearchIcon({ size = 12 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
        >
            <circle cx="11" cy="11" r="6" />
            <path d="M16 16l4 4" />
        </svg>
    );
}

function FolderIcon({ size = 24 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3.5 7.5h6l1.8 2H20.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
            <path d="M3.5 7.5V6A1.5 1.5 0 0 1 5 4.5h4l1.7 2H19" />
        </svg>
    );
}

function FileIcon({ size = 24 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M6 3.5h7l5 5V20.5H6z" />
            <path d="M13 3.5v5h5" />
        </svg>
    );
}


function ImportIcon({ size = 14 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3.5 8h6l1.8 2H20.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z" />
            <path d="M12 4v9" />
            <path d="m8.8 9.8 3.2 3.2 3.2-3.2" />
        </svg>
    );
}

function NewFolderIcon({ size = 15 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3.5 7.5h6l1.8 2H20.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
            <path d="M15 12v5" />
            <path d="M12.5 14.5h5" />
        </svg>
    );
}

function SynchronizeIcon({ size = 14 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M19 8a7.5 7.5 0 0 0-12.7-2.2L4 8" />
            <path d="M4 4v4h4" />
            <path d="M5 16a7.5 7.5 0 0 0 12.7 2.2L20 16" />
            <path d="M20 20v-4h-4" />
        </svg>
    );
}

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

function SearchModal({
    close,
    openEntry
}: {
    close: () => void;
    openEntry: (entry: CloudSearchEntry) => void;
}) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<CloudSearchEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [closing, setClosing] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const timer = window.setTimeout(() => {
            setLoading(true);
            void window.vaporApi.searchCloudIndex(query, 120)
                .then((entries) => {
                    if (!cancelled) setResults(entries);
                })
                .catch(() => {
                    if (!cancelled) setResults([]);
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
        }, query ? 70 : 0);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [query]);

    const requestClose = useCallback(() => {
        if (closing) return;
        setClosing(true);
        window.setTimeout(close, 150);
    }, [close, closing]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') requestClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [requestClose]);

    return (
        <div className={`modal-backdrop search-backdrop ${closing ? 'closing' : ''}`} onMouseDown={requestClose}>
            <section className={`search-modal ${closing ? 'closing' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
                <div className="search-modal-input-wrap">
                    <SearchIcon size={13} />
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search Cloud…"
                        aria-label="Search cached Steam Cloud files and folders"
                    />
                    <span>Esc</span>
                </div>

                <div className="search-results" aria-live="polite">
                    {loading ? (
                        <div className="search-state">Searching…</div>
                    ) : results.length === 0 ? (
                        <div className="search-state">
                            {query ? 'No cached item matches this search.' : 'No cached Cloud data yet. Open a supported Cloud once to index it.'}
                        </div>
                    ) : (
                        <div className="search-grid">
                            {results.map((entry) => (
                                <button
                                    key={`${entry.gameId}:${entry.path}`}
                                    className="search-result"
                                    title={`${entry.path}
${entry.gameName} · ${entry.volumeName}`}
                                    onClick={() => openEntry(entry)}
                                >
                                    <span className="search-result-icon">
                                        {entry.type === 'directory' ? <FolderIcon /> : <FileIcon />}
                                    </span>
                                    <strong>{entry.name}</strong>
                                    <small className="search-result-size">
                                        {entry.type === 'file' ? formatBytes(entry.size) : 'Folder'}
                                    </small>
                                    <span className="search-result-hover-meta" aria-hidden="true">
                                        <span className="search-result-cloud">{entry.gameName}</span>
                                        <span className="search-result-open"><OpenLocationIcon size={12} /></span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </section>
        </div>
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
                    {currentFile && (
                        <div className="transfer-current" title={progress?.currentFile || currentFile}>
                            {currentFile}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}

function TrashIcon({ size = 14 }: { size?: number }) {
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
            <path d="M4 7h16" />
            <path d="M9 7V4h6v3" />
            <path d="M7 7l1 13h8l1-13" />
            <path d="M10 11v5M14 11v5" />
        </svg>
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
    navKey,
    leaveSession,
    hasUnsynchronizedChanges
}: {
    game: GameStatus;
    listing: DirectoryListing;
    selected: AuditEntry | null;
    setSelected: (entry: AuditEntry | null) => void;
    navigate: (directory: string) => Promise<void>;
    setModal: (modal: ModalState) => void;
    synchronize: (game: GameStatus) => Promise<boolean>;
    syncNotice: string | null;
    navDirection: NavDirection;
    navKey: number;
    leaveSession: (game: GameStatus) => Promise<boolean>;
    hasUnsynchronizedChanges: boolean;
}) {
    const directory = normalizeRelative(listing.directory);
    const fileSlots = remainingFileSlots(game, true);

    async function goBack() {
        if (directory) {
            await navigate(parentDirectory(directory));
            return;
        }
        await leaveSession(game);
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
                <div className="cloud-topbar-main">
                    <button
                        className="icon-button cloud-back-button"
                        aria-label={directory ? 'Parent folder' : 'Back to games'}
                        title={directory ? 'Parent folder' : (hasUnsynchronizedChanges ? 'Synchronize your changes before going back' : 'Back to games')}
                        onClick={() => void goBack()}
                    >
                        ←
                    </button>
                    <div className="cloud-title">
                        <span className="status-dot running" />
                        <strong>{game.name}</strong>
                    </div>
                </div>

                <div className="cloud-topbar-actions">
                    <button
                        className="cloud-action-label"
                        title={fileSlots === 0 ? 'No new file slots remain; replacing existing files is still possible' : 'Import files or a folder'}
                        onClick={() => setModal({ kind: 'import', game, directory })}
                    >
                        <ImportIcon />
                        <span>Import</span>
                    </button>
                    <button
                        className="cloud-action-icon"
                        aria-label="New folder"
                        title="New folder"
                        onClick={() => setModal({ kind: 'folder', game, directory })}
                    >
                        <NewFolderIcon />
                    </button>
                    <button
                        className="cloud-action-icon"
                        aria-label="Delete selected item"
                        title={selected ? `Delete ${selected.name}` : 'Select a file or folder to delete'}
                        disabled={!selected}
                        onClick={() => selected && setModal({ kind: 'delete', game, entry: selected })}
                    >
                        <TrashIcon />
                    </button>
                    <button className="save-button cloud-action-label" onClick={() => void synchronize(game)}>
                        <SynchronizeIcon />
                        <span>Synchronize</span>
                    </button>
                </div>
            </div>

            {syncNotice && <div className="sync-notice" role="status">{syncNotice}</div>}

            <div className="file-table" role="listbox" aria-label={`${game.name} cloud files`}>
                <div key={`${listing.directory}-${navKey}`} className={`file-list-motion ${navDirection}`}>
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
    confirmOpen,
    confirmEmptyFoldersSync,
    onMutation
}: {
    modal: ModalState;
    close: () => void;
    refresh: () => Promise<AppStatus>;
    reloadDirectory: (id: GameId, directory: string) => Promise<void>;
    confirmOpen: (game: GameStatus, target?: CloudSearchEntry) => Promise<void>;
    confirmEmptyFoldersSync: (game: GameStatus) => Promise<boolean>;
    onMutation: () => void;
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

    async function run(
        action: () => Promise<unknown>,
        game?: GameStatus,
        directory?: string,
        marksSessionDirty = false
    ) {
        if (working) return;
        setWorking(true);
        try {
            const result = await action();
            const canceled = Boolean(
                result
                && typeof result === 'object'
                && 'canceled' in result
                && (result as { canceled?: boolean }).canceled
            );
            if (marksSessionDirty && !canceled) onMutation();
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

    if (active.kind === 'install') {
        const game = active.game;
        const cloudUnknown = game.rememberedBytes === null;
        const rememberedCloud = game.rememberedBytes ?? game.quotaBytes;
        const gameSize = Math.max(0, game.installSize);
        const totalRequired = gameSize + rememberedCloud;

        content = (
            <>
                <h3>Install {game.name}</h3>
                <p className="modal-copy">
                    Steam installs the game separately from its Cloud data. Keep enough local space for both before continuing.
                </p>
                <p className="modal-copy subtle">
                    {cloudUnknown
                        ? `Cloud usage is unknown. VaporStow reserves the full ${quotaLabel(game.quotaBytes)} quota.`
                        : `Last remembered Cloud usage: ${formatBytes(rememberedCloud)}.`}
                </p>
                <div className="space-check">
                    <span>Game size</span><strong>{requiredSpaceLabel(gameSize)}</strong>
                    <span>Cloud reserve</span><strong>{requiredSpaceLabel(rememberedCloud)}</strong>
                    <span>Total required</span><strong>{requiredSpaceLabel(totalRequired)}</strong>
                </div>
                <div className="modal-actions">
                    <button onClick={requestClose}>Cancel</button>
                    <button
                        className="primary"
                        disabled={working}
                        onClick={() => void run(() => window.vaporApi.installGame(game.id))}
                    >
                        {working ? 'Opening Steam…' : 'Install'}
                    </button>
                </div>
            </>
        );
    } else if (active.kind === 'open') {
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
                <p className="modal-copy warning-copy">
                    The game may open. Leave it running in the background and do not close it. VaporStow will close it automatically when you synchronize.
                </p>
                {!enough && (
                    <div className="space-warning">
                        {available === null ? 'Local free space could not be verified.' : 'Not enough free local space.'}
                    </div>
                )}
                <div className="modal-actions">
                    <button onClick={requestClose}>Cancel</button>
                    <button className="primary" disabled={!enough} onClick={() => void confirmOpen(game, active.target)}>Open</button>
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
                    <button disabled={working} onClick={() => void run(() => window.vaporApi.importFiles(active.game.id, active.directory), active.game, active.directory, true)}>
                        {working ? 'Importing…' : 'Files'}
                    </button>
                    <button disabled={working} onClick={() => void run(() => window.vaporApi.importFolder(active.game.id, active.directory), active.game, active.directory, true)}>
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
                        active.directory,
                        true
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
    } else if (active.kind === 'empty-folders-sync') {
        content = (
            <>
                <h3>Empty folders won’t be saved</h3>
                <p className="modal-copy">Steam Cloud only saves files. These empty folders will be removed locally after a successful synchronization.</p>
                <div className="modal-actions">
                    <button disabled={working} onClick={requestClose}>Cancel</button>
                    <button
                        className="primary"
                        disabled={working}
                        onClick={() => {
                            if (working) return;
                            setWorking(true);
                            void confirmEmptyFoldersSync(active.game).finally(() => setWorking(false));
                        }}
                    >
                        {working ? 'Synchronizing…' : 'Synchronize'}
                    </button>
                </div>
            </>
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
                        onClick={() => void run(() => window.vaporApi.deleteEntry(active.game.id, active.entry.path), active.game, parent, true)}
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
    const [sessionDirty, setSessionDirty] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const lastActivityAt = useRef(Date.now());
    const automaticSessionActionRunning = useRef(false);
    const windowCloseHandling = useRef(false);
    const activeGameIdRef = useRef<GameId | null>(activeGameId);
    const phaseRef = useRef<Phase>(phase);
    const statusRef = useRef<AppStatus | null>(status);
    const automaticSessionActionRef = useRef<() => Promise<boolean>>(async () => false);

    activeGameIdRef.current = activeGameId;
    phaseRef.current = phase;
    statusRef.current = status;

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

    async function confirmOpen(game: GameStatus, target?: CloudSearchEntry) {
        let backgroundSessionStarted = false;
        try {
            setModal(null);
            await sleep(120);
            setActiveGameId(game.id);
            setPhase('opening');
            setListing({ directory: '', entries: [] });
            setSelected(null);
            setNavDirection('same');
            setSyncNotice(null);
            setSessionDirty(false);
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
            backgroundSessionStarted = true;
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
            await window.vaporApi.rebuildCloudIndex(game.id).catch(() => 0);
            await refresh();

            const targetDirectory = target
                ? normalizeRelative(target.type === 'directory' ? target.path : target.parentPath)
                : '';

            if (target) {
                const targetListing = await window.vaporApi.listDirectory(game.id, targetDirectory);
                const normalizedDirectory = normalizeRelative(targetListing.directory);
                const normalizedEntries = targetListing.entries.map((entry) => ({
                    ...entry,
                    path: normalizeRelative(entry.path)
                }));
                const targetStillExists = target.type === 'directory'
                    ? normalizedDirectory === targetDirectory
                    : normalizedEntries.some((entry) => entry.type === 'file' && entry.path === normalizeRelative(target.path));

                if (targetStillExists) {
                    setListing({ directory: normalizedDirectory, entries: normalizedEntries });
                    if (target.type === 'file') {
                        const selectedEntry = normalizedEntries.find((entry) => entry.path === normalizeRelative(target.path));
                        setSelected(selectedEntry || null);
                    } else {
                        setSelected(null);
                    }
                    setNavDirection('forward');
                    setNavKey((value) => value + 1);
                } else {
                    await reloadDirectory(game.id, '');
                }
            } else {
                await reloadDirectory(game.id, '');
            }
            await sleep(320);
            setOperationDetail(null);
            setTransferProgress(null);
            setPhase('open');
        } catch (error) {
            try {
                if (backgroundSessionStarted) await window.vaporApi.requestStop(game.id);
                else await window.vaporApi.stopBackgroundGuard(game.id);
            } catch {}
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
        setSessionDirty(false);
        setPhase('closed');
        setListing({ directory: '', entries: [] });
        setNavDirection('same');
        setNavKey((value) => value + 1);
    }

    async function leaveCloudSession(game: GameStatus): Promise<boolean> {
        if (sessionDirty) {
            setModal({
                kind: 'message',
                title: 'Unsynchronized changes',
                body: 'Synchronize your Cloud changes before going back to the game list.'
            });
            return false;
        }

        let stopStarted = false;

        try {
            setSelected(null);
            setSyncNotice(null);
            setTransferProgress(null);
            setOperationDetail('Preparing the Cloud for a safe close…');
            setPhase('closing');

            // Opening the Cloud may reconstruct split files into their normal form.
            // Rebuild the exact Steam-facing representation before closing, even when
            // the user did not edit anything. This is a no-op for ordinary files.
            const preparation = await window.vaporApi.prepareSync(game.id);
            if (preparation.splitFiles > 0) {
                setOperationDetail(
                    preparation.reusedParts > 0
                        ? `Cloud representation restored · ${preparation.reusedParts} cached parts reused`
                        : 'Cloud representation restored.'
                );
                await sleep(180);
            }

            setOperationDetail('Closing the hidden game…');
            await window.vaporApi.requestStop(game.id);
            stopStarted = true;
            await waitForRunning(game.id, false);

            const afterClose = await window.vaporApi.getStatus();
            setStatus(afterClose);
            const closedState = afterClose.games.find((item) => item.id === game.id);
            if (closedState) {
                await window.vaporApi.rememberUsage(game.id, closedState.auditBytes, closedState.cloudFiles);
            }

            closeCloudSession();
            await refresh();
            return true;
        } catch (error) {
            if (!stopStarted) {
                await restoreSplitFilesSafe(game.id);
                try {
                    await refresh();
                    await reloadDirectory(game.id, listing.directory);
                    setActiveGameId(game.id);
                    setPhase('open');
                } catch {
                    closeCloudSession();
                }
            } else {
                closeCloudSession();
                await refresh();
            }

            setOperationDetail(null);
            setTransferProgress(null);
            setModal({
                kind: 'message',
                title: 'Unable to close cloud session',
                body: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    }

    async function synchronize(
        game: GameStatus,
        options: { skipEmptyFoldersWarning?: boolean } = {}
    ): Promise<boolean> {
        if (!options.skipEmptyFoldersWarning) {
            const summary = await window.vaporApi.getCloudContentSummary(game.id).catch(() => null);
            if (summary?.onlyEmptyDirectories) {
                setModal({ kind: 'empty-folders-sync', game });
                return false;
            }
        }

        let stopStarted = false;
        let indexStaged = false;

        try {
            setSelected(null);
            setSyncNotice(null);
            setOperationDetail('Preparing files…');
            setTransferProgress(null);
            setPhase('saving');

            // Capturer l'état user-facing avant que les gros fichiers soient replacés
            // par leur représentation split destinée à Steam. Le snapshot reste en RAM
            // et n'est commité dans SQLite qu'après confirmation de la sync.
            try {
                await window.vaporApi.stageCloudIndex(game.id);
                indexStaged = true;
            } catch {
                indexStaged = false;
            }

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
                if (indexStaged) await window.vaporApi.discardCloudIndex(game.id).catch(() => false);
                closeCloudSession();
                await refresh();
                setModal({
                    kind: 'message',
                    title: syncResult.state === 'failed' ? 'Steam Cloud sync failed' : 'Steam Cloud status unknown',
                    body: syncResult.message
                });
                return false;
            }

            // Steam Cloud ne conserve pas les dossiers vides. Les retirer seulement après
            // une synchronisation réussie pour garder le miroir local cohérent sans perdre
            // d'état local si l'upload échoue.
            await window.vaporApi.pruneEmptyDirectories(game.id);

            // Garder localement la représentation split qui vient d'être synchronisée.
            const afterSync = await window.vaporApi.getStatus();
            setStatus(afterSync);
            const syncedState = afterSync.games.find((item) => item.id === game.id) || current;
            await window.vaporApi.rememberUsage(game.id, syncedState.auditBytes, syncedState.cloudFiles);
            if (indexStaged) await window.vaporApi.commitCloudIndex(game.id).catch(() => 0);

            // Conserver le progress final pour l'animation puis vider le Cloud log.
            await window.vaporApi.resetCloudLog();

            setOperationDetail('Steam Cloud synchronized.');
            setPhase('saved');
            await sleep(syncResult.reason === 'no-changes' ? 850 : 1100);

            closeCloudSession();
            await refresh();
            return true;
        } catch (error) {
            if (indexStaged) await window.vaporApi.discardCloudIndex(game.id).catch(() => false);

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
            return false;
        }
    }

    // Auto-sync utilise exactement le même chemin que le bouton Synchronize.
    // Cela couvre aussi les modifications faites directement dans le dossier local
    // même si elles n'ont pas été créées depuis l'UI de VaporStow.
    automaticSessionActionRef.current = async () => {
        const id = activeGameIdRef.current;
        const currentStatus = statusRef.current;
        if (!id || phaseRef.current !== 'open' || !currentStatus) return false;

        const game = currentStatus.games.find((candidate) => candidate.id === id);
        if (!game) return false;

        setModal(null);
        setSearchOpen(false);
        return synchronize(game, { skipEmptyFoldersWarning: true });
    };

    useEffect(() => {
        if (phase === 'open' && activeGameId) lastActivityAt.current = Date.now();
    }, [phase, activeGameId]);

    useEffect(() => {
        const markActivity = () => {
            lastActivityAt.current = Date.now();
        };
        const activityEvents: Array<keyof WindowEventMap> = [
            'pointerdown',
            'pointermove',
            'keydown',
            'wheel',
            'touchstart'
        ];

        for (const eventName of activityEvents) {
            window.addEventListener(eventName, markActivity, { passive: true });
        }

        const timer = window.setInterval(() => {
            if (phaseRef.current !== 'open' || !activeGameIdRef.current) return;
            if (automaticSessionActionRunning.current || windowCloseHandling.current) return;
            if (Date.now() - lastActivityAt.current < AFK_TIMEOUT_MS) return;

            // Réarmer immédiatement pour qu'un échec ne déclenche pas une boucle serrée.
            lastActivityAt.current = Date.now();
            automaticSessionActionRunning.current = true;
            void automaticSessionActionRef.current().finally(() => {
                automaticSessionActionRunning.current = false;
                lastActivityAt.current = Date.now();
            });
        }, 1000);

        return () => {
            window.clearInterval(timer);
            for (const eventName of activityEvents) {
                window.removeEventListener(eventName, markActivity);
            }
        };
    }, []);

    useEffect(() => {
        return window.vaporApi.onWindowCloseRequested(() => {
            if (windowCloseHandling.current) return;
            windowCloseHandling.current = true;

            void (async () => {
                let canClose = false;
                try {
                    // Si une ouverture/sauvegarde est déjà en cours, attendre son état
                    // stable plutôt que de couper Steam au milieu d'une opération.
                    while (true) {
                        if (!activeGameIdRef.current && phaseRef.current === 'closed') {
                            canClose = true;
                            break;
                        }

                        if (phaseRef.current === 'open') {
                            canClose = await automaticSessionActionRef.current();
                            break;
                        }

                        await sleep(150);
                    }
                } catch {
                    canClose = false;
                }

                if (canClose) window.vaporApi.confirmWindowClose();
                else window.vaporApi.cancelWindowClose();
                windowCloseHandling.current = false;
            })();
        });
    }, []);

    if (loading || !status) return <main className="loading">VaporStow</main>;

    const stageKey = activeGameId ? `${activeGameId}-${phase}` : 'volumes';

    return (
        <>
            <main className={`shell ${activeGameId ? 'focused' : ''}`}>
                <header>
                    <div className="brand">VaporStow <span>v{status.appVersion}</span></div>
                    {!activeGameId && (
                        <button className="cloud-search-trigger" onClick={() => setSearchOpen(true)}>
                            <SearchIcon />
                            <span>Search Cloud…</span>
                        </button>
                    )}
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
                                    : game.installing
                                        ? 'Installing…'
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
                                            disabled={actionLabel === 'Unavailable' || game.installing}
                                            onClick={() => {
                                                if (!game.platformSupported) void window.vaporApi.openStore(game.id);
                                                else if (!game.installed) setModal({ kind: 'install', game });
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
                                leaveSession={leaveCloudSession}
                                hasUnsynchronizedChanges={sessionDirty}
                            />
                        ) : (
                            <Operation phase={phase} gameName={activeGame.name} detail={operationDetail} progress={transferProgress} />
                        )
                    ) : (
                        <div className="loading-inline">Loading volume…</div>
                    )}
                </div>
            </main>

            {searchOpen && !activeGameId && (
                <SearchModal
                    close={() => setSearchOpen(false)}
                    openEntry={(entry) => {
                        const game = status.games.find((candidate) => candidate.id === entry.gameId);
                        setSearchOpen(false);
                        if (!game) return;
                        if (!game.platformSupported) {
                            setModal({ kind: 'message', title: 'Cloud unavailable', body: `${game.name} is not supported on this platform.` });
                        } else if (!game.installed) {
                            setModal({ kind: 'install', game });
                        } else if (!game.cloudRoot) {
                            setModal({ kind: 'message', title: 'Cloud unavailable', body: 'No local Auto-Cloud path is available for this game on the current platform.' });
                        } else {
                            setModal({ kind: 'open', game, target: entry });
                        }
                    }}
                />
            )}

            <Modal
                modal={modal}
                close={() => setModal(null)}
                refresh={refresh}
                reloadDirectory={reloadDirectory}
                confirmOpen={confirmOpen}
                confirmEmptyFoldersSync={async (game) => {
                    setModal(null);
                    await sleep(120);
                    return synchronize(game, { skipEmptyFoldersWarning: true });
                }}
                onMutation={() => setSessionDirty(true)}
            />
        </>
    );
}
