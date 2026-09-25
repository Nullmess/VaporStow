import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type CSSProperties } from 'react';
import type { AppStatus, AuditEntry, CloudSearchEntry, CloudTransferProgress, DirectoryListing, GameStatus, SplitRestoreProgress } from './types';
import startupLogo from './assets/logo.png';

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
    | { kind: 'info' }
    | { kind: 'message'; title: string; body: string };

type ExplorerSelection = AuditEntry | {
    path: '__parent__';
    name: '..';
    type: 'directory';
    size: 0;
    virtualParent: true;
    parentTarget: string;
};

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

function compactStatusLine(value: string, maxLength = 34): string {
    const clean = value.replace(/^log>\s*/i, '').trim();
    if (clean.length <= maxLength) return clean;
    return `${clean.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function quotaLabel(bytes: number): string {
    return `${(bytes / GIB).toFixed(2)} GiB`;
}

function cloudSpaceLabel(bytes: number): string {
    return `${(bytes / GIB).toFixed(2)} GB`;
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

function InfoIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 10v6" />
            <path d="M12 7.2h.01" />
        </svg>
    );
}

function GithubIcon({ size = 15 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2C6.477 2 2 6.58 2 12.229c0 4.518 2.865 8.35 6.839 9.703.5.095.682-.22.682-.49 0-.242-.009-.883-.014-1.733-2.782.617-3.369-1.37-3.369-1.37-.455-1.18-1.11-1.494-1.11-1.494-.908-.635.069-.622.069-.622 1.004.072 1.532 1.054 1.532 1.054.892 1.562 2.341 1.111 2.91.85.091-.661.349-1.112.635-1.368-2.221-.259-4.555-1.136-4.555-5.056 0-1.117.39-2.031 1.029-2.747-.103-.259-.446-1.301.098-2.712 0 0 .84-.275 2.75 1.05A9.39 9.39 0 0 1 12 7.05a9.39 9.39 0 0 1 2.504.344c1.909-1.325 2.748-1.05 2.748-1.05.546 1.411.203 2.453.1 2.712.64.716 1.028 1.63 1.028 2.747 0 3.93-2.338 4.794-4.566 5.048.359.316.679.94.679 1.895 0 1.368-.012 2.472-.012 2.808 0 .272.18.59.688.49C19.14 20.575 22 16.746 22 12.229 22 6.58 17.523 2 12 2Z" />
        </svg>
    );
}

function FullscreenIcon({ active = false, size = 14 }: { active?: boolean; size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {active ? (
                <>
                    <path d="M9 4v5H4" /><path d="M15 4v5h5" /><path d="M9 20v-5H4" /><path d="M15 20v-5h5" />
                </>
            ) : (
                <>
                    <path d="M8 4H4v4" /><path d="M16 4h4v4" /><path d="M8 20H4v-4" /><path d="M16 20h4v-4" />
                </>
            )}
        </svg>
    );
}

function CloseIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12" /><path d="M18 6 6 18" />
        </svg>
    );
}

function BackIcon({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m14.5 5-7 7 7 7" />
            <path d="M8 12h10" />
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
    selected: ExplorerSelection | null;
    setSelected: (entry: ExplorerSelection | null) => void;
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
    const parentEntry: ExplorerSelection | null = directory
        ? {
            path: '__parent__',
            name: '..',
            type: 'directory',
            size: 0,
            virtualParent: true,
            parentTarget: parentDirectory(directory)
        }
        : null;
    const visibleEntries: ExplorerSelection[] = parentEntry
        ? [parentEntry, ...listing.entries.map((entry) => ({ ...entry, path: normalizeRelative(entry.path) }))]
        : listing.entries.map((entry) => ({ ...entry, path: normalizeRelative(entry.path) }));
    const selectedIsParent = Boolean(selected && 'virtualParent' in selected && selected.virtualParent);

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

    const breadcrumb = directory ? `CloudAudit / ${directory}` : 'CloudAudit';
    const artwork = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.appId}/library_600x900.jpg`;
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const searchRef = useRef<HTMLInputElement | null>(null);
    const cloudMeta = `${formatBytes(game.auditBytes)} / ${quotaLabel(game.quotaBytes)} • ${(remainingFileSlots(game, true)?.toLocaleString() ?? '?')} files`;
    const filteredEntries = useMemo(() => {
        const query = searchTerm.trim().toLowerCase();
        if (!query) return visibleEntries;
        return visibleEntries.filter((entry) => ('virtualParent' in entry && entry.virtualParent) || entry.name.toLowerCase().includes(query));
    }, [visibleEntries, searchTerm]);

    useEffect(() => {
        if (!searchOpen) return;
        const id = window.setTimeout(() => searchRef.current?.focus(), 120);
        return () => window.clearTimeout(id);
    }, [searchOpen]);

    useEffect(() => {
        const onFindShortcut = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
            event.preventDefault();
            event.stopPropagation();
            setSearchOpen(true);
            window.setTimeout(() => searchRef.current?.focus(), 0);
        };
        window.addEventListener('keydown', onFindShortcut, true);
        return () => window.removeEventListener('keydown', onFindShortcut, true);
    }, []);

    return (
        <section className="cloud-view">
            <div className="cloud-ambient-art" aria-hidden="true"><img src={artwork} alt="" draggable={false} /></div>

            <div className="cloud-topbar">
                <div className="cloud-topbar-main">
                    <button
                        className="icon-button cloud-back-button"
                        aria-label={directory ? 'Parent folder' : 'Back to games'}
                        title={directory ? 'Parent folder' : (hasUnsynchronizedChanges ? 'Synchronize your changes before going back' : 'Back to games')}
                        onClick={() => void goBack()}
                    >
                        <BackIcon />
                    </button>
                    <div className="cloud-game-art" aria-hidden="true">
                        <img src={artwork} alt="" draggable={false} />
                    </div>
                    <div className="cloud-title">
                        <div className="cloud-title-line">
                            <span className="status-dot running" />
                            <strong>{game.name}</strong>
                        </div>
                        <small title={cloudMeta}>{cloudMeta}</small>
                    </div>
                </div>

                <div className="cloud-topbar-actions">
                    <div className={`cloud-search-shell ${searchOpen ? 'open' : ''}`}>
                        <button
                            className="cloud-action-icon search-toggle"
                            aria-label={searchOpen ? 'Close search' : 'Open search'}
                            title={searchOpen ? 'Close search' : 'Search'}
                            onClick={() => {
                                if (searchOpen) {
                                    setSearchOpen(false);
                                    setSearchTerm('');
                                    return;
                                }
                                setSearchOpen(true);
                            }}
                        >
                            <SearchIcon />
                        </button>
                        <label className={`cloud-search-bar ${searchOpen ? 'open' : ''}`}>
                            <SearchIcon />
                            <input
                                ref={searchRef}
                                type="text"
                                value={searchTerm}
                                onChange={(event) => setSearchTerm(event.target.value)}
                                placeholder="Search files..."
                                aria-label="Search files"
                            />
                        </label>
                    </div>
                    <button
                        className="cloud-action-icon"
                        aria-label="Import files"
                        title={fileSlots === 0 ? 'No new file slots remain; replacing existing files is still possible' : 'Import files or a folder'}
                        onClick={() => setModal({ kind: 'import', game, directory })}
                    >
                        <ImportIcon />
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
                        className="cloud-action-icon danger-action"
                        aria-label="Delete selected item"
                        title={selectedIsParent ? 'The parent shortcut cannot be deleted' : selected ? `Delete ${selected.name}` : 'Select a file or folder to delete'}
                        disabled={!selected || selectedIsParent}
                        onClick={() => selected && !selectedIsParent && setModal({ kind: 'delete', game, entry: selected as AuditEntry })}
                    >
                        <TrashIcon />
                    </button>
                    <button className="cloud-action-icon" aria-label="Synchronize" title="Synchronize" onClick={() => void synchronize(game)}>
                        <SynchronizeIcon />
                    </button>
                </div>
            </div>

            {syncNotice && <div className="sync-notice" role="status">{syncNotice}</div>}

            <div className="cloud-content">
                <div className="file-table" role="listbox" aria-label={`${game.name} cloud files`}>
                    <div key={`${listing.directory}-${navKey}`} className={`file-list-motion ${navDirection}`}>
                        {filteredEntries.length === 0 ? (
                            <div className="empty-folder">
                                <span className="empty-folder-icon"><FolderIcon size={28} /></span>
                                <strong>This folder is empty</strong>
                                <small>Import files or create a folder to start.</small>
                            </div>
                        ) : filteredEntries.map((entry) => {
                            const isParentEntry = 'virtualParent' in entry && entry.virtualParent;
                            const cleanPath = isParentEntry ? entry.path : normalizeRelative(entry.path);
                            const isSelected = selected?.path === cleanPath;
                            return (
                                <div
                                    key={`${cleanPath}-${entry.name}`}
                                    className={`file-row ${entry.type} ${isSelected ? 'selected' : ''} ${isParentEntry ? 'parent-row' : ''}`}
                                    role="option"
                                    aria-selected={isSelected}
                                    tabIndex={0}
                                    onClick={() => setSelected(entry)}
                                    onDoubleClick={() => {
                                        if (isParentEntry) {
                                            void navigate(entry.parentTarget);
                                            return;
                                        }
                                        if (entry.type === 'directory') void navigate(cleanPath);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            if (isParentEntry) {
                                                void navigate(entry.parentTarget);
                                                return;
                                            }
                                            if (entry.type === 'directory') void navigate(cleanPath);
                                        }
                                        if (event.key === ' ') {
                                            event.preventDefault();
                                            setSelected(entry);
                                        }
                                    }}
                                >
                                    <span className="file-icon">{entry.type === 'directory' ? <FolderIcon size={16} /> : <FileIcon size={16} />}</span>
                                    <span className="file-name">{entry.name}</span>
                                    <span className="file-size">{isParentEntry ? 'Parent folder' : entry.type === 'file' ? formatBytes(entry.size) : 'Folder'}</span>
                                    <button
                                        className={`reveal-button ${isParentEntry ? 'disabled' : ''}`}
                                        aria-label={isParentEntry ? 'Parent folder shortcut' : `Show ${entry.name} in system folder`}
                                        title={isParentEntry ? 'Parent folder' : 'Show in folder'}
                                        disabled={isParentEntry}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            if (isParentEntry) return;
                                            setSelected(entry);
                                            void revealEntry(entry as AuditEntry);
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
                {cloudUnknown && (
                    <p className="modal-copy subtle">
                        Cloud usage is unknown. VaporStow reserves the full {quotaLabel(game.quotaBytes)} quota.
                    </p>
                )}
                <div className="space-calculation" aria-label="Required local space calculation">
                    <div className="space-calculation-row">
                        <span>Game size</span>
                        <strong><b>+</b>{requiredSpaceLabel(gameSize)}</strong>
                    </div>
                    <div className="space-calculation-row">
                        <span>Cloud reserve</span>
                        <strong><b>+</b>{requiredSpaceLabel(rememberedCloud)}</strong>
                    </div>
                    <div className="space-calculation-rule" aria-hidden="true" />
                    <div className="space-calculation-row total">
                        <span>Total required</span>
                        <strong><b>=</b>{requiredSpaceLabel(totalRequired)}</strong>
                    </div>
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
        const rememberedCloud = game.rememberedBytes ?? game.quotaBytes;
        const required = rememberedCloud;
        const available = game.disk?.free ?? null;
        const cloudFolderExists = game.cloudRootExists;
        const enough = cloudFolderExists || game.running || (available !== null && available >= required);

        content = (
            <>
                <h3>Open {game.name}</h3>
                {!cloudFolderExists && (
                    <>
                        <p className="modal-copy">
                            The local Cloud folder is missing. Steam will restore the Cloud files before the game starts.
                        </p>
                        <div className="space-check">
                            <span>Remembered Cloud quota</span><strong>{game.rememberedBytes === null ? cloudSpaceLabel(game.quotaBytes) : requiredSpaceLabel(rememberedCloud)}</strong>
                            <span>Total Cloud space</span><strong>{cloudSpaceLabel(game.quotaBytes)}</strong>
                        </div>
                    </>
                )}
                <p className="modal-copy warning-copy">
                    The game may open. Leave it running in the background and do not close it. VaporStow will close it automatically when you synchronize.
                </p>
                {!cloudFolderExists && !enough && (
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
    } else if (active.kind === 'info') {
        const contributors = [
            { name: 'Nullmess', username: 'nullmess' },
            { name: 'Ybucaille', username: 'Ybucaille' }
        ];

        content = (
            <div className="about-modal-content">
                <div className="about-heading">
                    <h3>VaporStow</h3>
                    <span>v1.0.0</span>
                </div>
                <div className="about-contributors">
                    {contributors.map((contributor) => (
                        <article className="about-contributor" key={contributor.username}>
                            <img
                                className="about-avatar"
                                src={`https://github.com/${contributor.username}.png?size=160`}
                                alt={`${contributor.name} GitHub avatar`}
                                draggable={false}
                            />
                            <strong>{contributor.name}</strong>
                            <button
                                className="github-profile-button"
                                onClick={() => void window.vaporApi.openGithubProfile(contributor.username)}
                            >
                                <GithubIcon />
                                <span>GitHub</span>
                            </button>
                        </article>
                    ))}
                </div>
                <div className="modal-actions about-close-row">
                    <button className="primary" onClick={requestClose}>Close</button>
                </div>
            </div>
        );
    } else if (active.kind === 'delete') {
        const parent = parentDirectory(active.entry.path);
        const isFolder = active.entry.type === 'directory';
        content = (
            <>
                <h3>Delete {active.entry.name}</h3>
                <p className="modal-copy warning-copy">
                    {isFolder
                        ? 'Are you sure you want to delete this folder and every file inside it?'
                        : 'Are you sure you want to delete this file?'}
                </p>
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


function gameInitials(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || '')
        .join('');
}

function GameArtwork({ game }: { game: GameStatus }) {
    const [failed, setFailed] = useState(false);
    const artwork = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.appId}/library_600x900.jpg`;

    return (
        <div className="cloud-card-art" aria-hidden="true">
            <span>{gameInitials(game.name)}</span>
            {!failed && <img src={artwork} alt="" draggable={false} onError={() => setFailed(true)} />}
        </div>
    );
}

type CloudCarouselProps = {
    games: GameStatus[];
    actionFor: (game: GameStatus) => string;
    onAction: (game: GameStatus) => void;
    introReveal?: boolean;
    operationGame?: GameStatus | null;
    operationPhase?: Phase;
    operationDetail?: string | null;
    operationProgress?: CloudTransferProgress | null;
};

function CloudCarousel({
    games,
    actionFor,
    onAction,
    introReveal = false,
    operationGame = null,
    operationPhase = 'closed',
    operationDetail = null,
    operationProgress = null
}: CloudCarouselProps) {
    const railRef = useRef<HTMLDivElement | null>(null);
    const frameRef = useRef<number | null>(null);
    const positionRef = useRef(0);
    const targetRef = useRef(0);
    const velocityRef = useRef(0);
    const dragRef = useRef({
        pointerId: -1,
        startX: 0,
        startPosition: 0,
        lastX: 0,
        lastTime: 0,
        velocity: 0,
        moved: false,
        clickedGameIndex: null as number | null,
        clickedTarget: null as number | null
    });
    const geometryRef = useRef({ cardWidth: 320, cardHeight: 360, artSize: 132, slot: 352 });
    const suppressClickRef = useRef(false);
    const [dragging, setDragging] = useState(false);
    const [animating, setAnimating] = useState(false);
    const [position, setPosition] = useState(0);
    const [geometry, setGeometry] = useState({ cardWidth: 320, cardHeight: 360, artSize: 132, slot: 352 });
    const [returningGameId, setReturningGameId] = useState<GameId | null>(null);
    const previousOperationGameIdRef = useRef<GameId | null>(operationGame?.id ?? null);
    const gameOrderKey = games.map((game) => game.id).join('|');

    const measure = useCallback(() => {
        const rail = railRef.current;
        if (!rail) return;
        const width = Math.max(320, rail.clientWidth);
        const height = Math.max(280, rail.clientHeight);
        const cardWidth = Math.max(230, Math.min(430, width * 0.285));
        const cardHeight = Math.max(270, Math.min(430, height * 0.82));
        const artSize = Math.max(92, Math.min(160, cardWidth * 0.40, cardHeight * 0.34));
        const gap = Math.max(18, Math.min(42, width * 0.03));
        const next = { cardWidth, cardHeight, artSize, slot: cardWidth + gap };
        geometryRef.current = next;
        setGeometry((current) => (
            Math.abs(current.slot - next.slot) < 0.5
            && Math.abs(current.cardWidth - next.cardWidth) < 0.5
            && Math.abs(current.cardHeight - next.cardHeight) < 0.5
            && Math.abs(current.artSize - next.artSize) < 0.5
        ) ? current : next);
        rail.style.setProperty('--carousel-card-width', `${cardWidth}px`);
        rail.style.setProperty('--carousel-card-height', `${cardHeight}px`);
        rail.style.setProperty('--carousel-art-size', `${artSize}px`);
        rail.style.setProperty('--carousel-slot', `${cardWidth + gap}px`);
    }, []);

    const commitPosition = useCallback((next: number) => {
        const count = games.length;
        if (count > 0 && Math.abs(next) > count * 1000) {
            const cycles = Math.trunc(next / count);
            next -= cycles * count;
            targetRef.current -= cycles * count;
        }
        positionRef.current = next;
        setPosition(next);
    }, [games.length]);

    const stopAnimation = useCallback(() => {
        if (frameRef.current !== null) {
            window.cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        velocityRef.current = 0;
        setAnimating(false);
    }, []);

    const animateTo = useCallback((target: number, initialVelocity = 0) => {
        stopAnimation();
        targetRef.current = target;
        velocityRef.current = initialVelocity;
        setAnimating(true);
        let previous = performance.now();

        const tick = (now: number) => {
            const dt = Math.min(32, Math.max(1, now - previous)) / 1000;
            previous = now;

            const current = positionRef.current;
            const displacement = targetRef.current - current;

            // Critically damped-ish spring: smooth like a console carousel, no late focus jump.
            const stiffness = 46;
            const damping = 11.5;
            const acceleration = displacement * stiffness - velocityRef.current * damping;
            velocityRef.current += acceleration * dt;
            const next = current + velocityRef.current * dt;
            commitPosition(next);

            if (Math.abs(displacement) < 0.0015 && Math.abs(velocityRef.current) < 0.008) {
                commitPosition(targetRef.current);
                velocityRef.current = 0;
                frameRef.current = null;
                setAnimating(false);
                return;
            }
            frameRef.current = window.requestAnimationFrame(tick);
        };

        frameRef.current = window.requestAnimationFrame(tick);
    }, [commitPosition, stopAnimation]);

    const visualTargetForGame = useCallback((gameIndex: number, around = positionRef.current) => {
        const count = games.length;
        if (count <= 0) return 0;

        let relative = gameIndex - around;
        relative -= Math.round(relative / count) * count;
        return around + relative;
    }, [games.length]);

    const focusGame = useCallback((gameIndex: number) => {
        // Aim for the exact visual instance that was clicked, not just the logical index.
        // This matters in the infinite carousel where the same game can be represented
        // on either side of the current virtual position.
        animateTo(visualTargetForGame(gameIndex));
    }, [animateTo, visualTargetForGame]);

    useLayoutEffect(() => {
        if (!operationGame) return;
        const index = games.findIndex((game) => game.id === operationGame.id);
        if (index < 0) return;

        // Lock the selected game to the exact viewport center before the loading morph is painted.
        stopAnimation();
        const centered = visualTargetForGame(index, positionRef.current);
        targetRef.current = centered;
        commitPosition(centered);
    }, [operationGame?.id, gameOrderKey, commitPosition, stopAnimation, visualTargetForGame]);

    useEffect(() => {
        const previousId = previousOperationGameIdRef.current;
        const currentId = operationGame?.id ?? null;

        if (currentId) {
            previousOperationGameIdRef.current = currentId;
            setReturningGameId(null);
            return;
        }

        if (!previousId) return;
        setReturningGameId(previousId);
        previousOperationGameIdRef.current = null;
        const timer = window.setTimeout(() => setReturningGameId(null), 640);
        return () => window.clearTimeout(timer);
    }, [operationGame?.id]);

    useLayoutEffect(() => {
        measure();
        commitPosition(0);
        targetRef.current = 0;
        const rail = railRef.current;
        if (!rail) return;
        const observer = new ResizeObserver(measure);
        observer.observe(rail);
        return () => observer.disconnect();
    }, [gameOrderKey, commitPosition, measure]);

    useEffect(() => () => stopAnimation(), [stopAnimation]);

    const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (operationGame || returningGameId || event.button !== 0 || !railRef.current) return;
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, [data-no-carousel-drag="true"]')) return;

        stopAnimation();
        const now = performance.now();
        const card = target.closest<HTMLElement>('[data-game-index]');
        const clickedGameIndex = card ? Number(card.dataset.gameIndex) : null;
        const clickedTarget = clickedGameIndex !== null && Number.isFinite(clickedGameIndex)
            ? visualTargetForGame(clickedGameIndex, positionRef.current)
            : null;

        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startPosition: positionRef.current,
            lastX: event.clientX,
            lastTime: now,
            velocity: 0,
            moved: false,
            clickedGameIndex,
            clickedTarget
        };
        railRef.current.setPointerCapture(event.pointerId);
        setDragging(true);
    };

    const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag.pointerId !== event.pointerId) return;

        const slot = Math.max(1, geometryRef.current.slot);
        const deltaPx = event.clientX - drag.startX;
        if (Math.abs(deltaPx) > 4) drag.moved = true;

        const now = performance.now();
        const dt = Math.max(1, now - drag.lastTime);
        const instantaneous = -(event.clientX - drag.lastX) / slot / (dt / 1000);
        drag.velocity = drag.velocity * 0.64 + instantaneous * 0.36;
        drag.lastX = event.clientX;
        drag.lastTime = now;

        commitPosition(drag.startPosition - deltaPx / slot);
    };

    const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rail = railRef.current;
        const drag = dragRef.current;
        if (drag.pointerId !== event.pointerId) return;
        if (rail?.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);

        suppressClickRef.current = drag.moved;
        dragRef.current.pointerId = -1;
        setDragging(false);

        if (drag.moved) {
            // Project the flick, then snap the spring to the nearest logical card.
            const projected = positionRef.current + Math.max(-8, Math.min(8, drag.velocity)) * 0.16;
            const target = Math.round(projected);
            animateTo(target, drag.velocity * 0.32);
        } else if (drag.clickedTarget !== null) {
            // A simple click always centers the exact card that was under the pointer.
            // Resolve it from pointer-down so the rail cannot snap elsewhere first.
            animateTo(drag.clickedTarget);
        } else {
            animateTo(Math.round(positionRef.current));
        }

        if (suppressClickRef.current) {
            window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        }
    };

    const operationMode = Boolean(operationGame && operationPhase !== 'closed' && operationPhase !== 'open');
    const returningMode = Boolean(!operationMode && returningGameId);
    const operationIsSplitRestore = Boolean(
        operationPhase === 'opening'
        && operationProgress
        && operationProgress.direction === 'unknown'
        && (operationProgress.totalParts ?? 0) > 0
    );
    const operationSubtitle = operationProgressSubtitle(operationPhase, operationProgress, operationIsSplitRestore)
        || operationDetail
        || operationFallbackSubtitle(operationPhase);
    const operationLogs = (() => {
        if (!operationMode) return [] as string[];
        const lines: string[] = [];
        if (operationSubtitle) lines.push(operationSubtitle);
        if (operationProgress?.currentFile) lines.push(displayFileName(operationProgress.currentFile));
        if (operationProgress?.totalFiles !== null && operationProgress?.totalFiles !== undefined && operationProgress.totalFiles > 1) {
            lines.push(`${operationProgress.completedFiles} / ${operationProgress.totalFiles} files`);
        }
        if (operationProgress?.percent !== null && operationProgress?.percent !== undefined) {
            lines.push(`${Math.round(operationProgress.percent)}% complete`);
        }
        if (operationProgress?.speedBytesPerSecond !== null && operationProgress?.speedBytesPerSecond !== undefined && operationProgress.speedBytesPerSecond > 0) {
            lines.push(`${formatBytes(operationProgress.speedBytesPerSecond)}/s`);
        }
        return lines.filter(Boolean);
    })();
    const operationCurrentLog = compactStatusLine(
        operationLogs.length > 0
            ? operationLogs[operationLogs.length - 1]
            : 'Preparing cloud session...'
    );

    const count = games.length;

    return (
        <div
            ref={railRef}
            className={`cloud-carousel ${dragging ? 'dragging' : ''} ${animating ? 'animating' : ''} ${introReveal ? 'intro-reveal' : ''} ${operationMode ? 'operation-mode' : ''} ${returningMode ? 'operation-returning' : ''}`}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onClickCapture={(event) => {
                if (!suppressClickRef.current) return;
                event.preventDefault();
                event.stopPropagation();
            }}
            onWheel={(event) => {
                if (operationGame || returningGameId || games.length === 0) return;
                event.preventDefault();
                stopAnimation();
                const dominant = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
                const direction = Math.sign(dominant);
                if (direction === 0) return;
                const base = Math.round(positionRef.current);
                animateTo(base + direction);
            }}
            tabIndex={0}
            onKeyDown={(event) => {
                if (operationGame || returningGameId || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
                event.preventDefault();
                const direction = event.key === 'ArrowRight' ? 1 : -1;
                animateTo(Math.round(positionRef.current) + direction);
            }}
        >
            {games.map((game, gameIndex) => {
                let relative = gameIndex - position;
                if (count > 0) relative -= Math.round(relative / count) * count;
                const distance = Math.abs(relative);
                const centerWeight = Math.max(0, 1 - Math.min(distance, 1));
                const sideWeight = Math.max(0, 1 - Math.abs(distance - 1));
                const opacity = Math.max(0.08, Math.min(1, 0.08 + centerWeight * 0.92 + sideWeight * 0.70));
                const scale = 0.82 + centerWeight * 0.28 + sideWeight * 0.10;
                const brightness = 0.58 + centerWeight * 0.42 + sideWeight * 0.24;
                const saturation = 0.62 + centerWeight * 0.38 + sideWeight * 0.22;
                const x = relative * geometry.slot;
                const focused = distance < 0.5;
                const actionLabel = actionFor(game);
                const current = game.rememberedBytes ?? 0;
                const currentFiles = game.rememberedFiles ?? 0;
                const remaining = game.rememberedFiles === null
                    ? game.maxFiles
                    : Math.max(0, game.maxFiles - game.rememberedFiles);

                return (
                    <article
                        className={`cloud-card ${focused ? 'focused' : ''} ${operationMode && operationGame?.id === game.id ? 'cloud-loading-card' : ''} ${returningMode && returningGameId === game.id ? 'cloud-returning-card' : ''}`}
                        key={game.id}
                        data-game-index={gameIndex}
                        style={{
                            '--card-x': `${x}px`,
                            '--card-opacity': (operationMode ? (operationGame?.id === game.id ? 1 : 0) : opacity).toFixed(3),
                            '--card-scale': (operationMode && operationGame?.id === game.id ? 1.10 : scale).toFixed(4),
                            '--card-saturation': (operationMode && operationGame?.id === game.id ? 1 : saturation).toFixed(3),
                            '--card-brightness': (operationMode && operationGame?.id === game.id ? 1 : brightness).toFixed(3),
                            '--intro-delay': `${relative < -0.5 && relative > -1.5 ? 0 : relative > 0.5 && relative < 1.5 ? 120 : distance < 0.5 ? 260 : 360}ms`,
                            zIndex: Math.max(1, 100 - Math.round(distance * 20))
                        } as CSSProperties}
                        onClick={() => {
                            if (suppressClickRef.current || dragging) return;
                            if (!focused) focusGame(gameIndex);
                        }}
                    >
                        <span
                            className={`cloud-card-status status-dot ${
                                operationMode && operationGame?.id === game.id
                                    ? `cloud-loading-status ${operationPhase === 'saving' || operationPhase === 'closing' || operationPhase === 'saved' ? 'syncing-out' : 'syncing-in'}`
                                    : statusTone(game)
                            }`}
                            title={game.running ? 'Running' : game.installed ? 'Installed' : 'Not installed'}
                        />
                        <GameArtwork game={game} />
                        <div className="cloud-card-content-stack">
                            <div className="cloud-card-normal-content">
                                <div className="cloud-card-title compact-title">
                                    <strong>{game.name}</strong>
                                </div>
                                <div className="cloud-card-usage">
                                    <span>{formatBytes(current)} / {quotaLabel(game.quotaBytes)}</span>
                                    <span>{currentFiles.toLocaleString()} / {game.maxFiles.toLocaleString()} files</span>
                                </div>
                                <button
                                    disabled={actionLabel === 'Unavailable' || game.installing}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        if (!focused) {
                                            focusGame(gameIndex);
                                            return;
                                        }
                                        onAction(game);
                                    }}
                                >
                                    {focused ? actionLabel : 'Select'}
                                </button>
                            </div>

                            <div className="cloud-card-loading-content" aria-live="polite">
                                <div className="cloud-card-title compact-title loading-slot-title">
                                    <strong>{game.name}</strong>
                                </div>
                                <div className="cloud-card-usage loading-slot-usage">
                                    <span>Cloud access.</span>
                                    {operationMode && operationGame?.id === game.id && (
                                        <span key={operationCurrentLog} className="cloud-loading-logtext" title={operationCurrentLog}>
                                            {operationCurrentLog}
                                        </span>
                                    )}
                                </div>
                                <div className="cloud-loading-action">
                                    <div className="cloud-loading-orbit" aria-hidden="true"><span /></div>
                                </div>
                            </div>
                        </div>
                    </article>
                );
            })}
        </div>
    );
}

export default function App() {
    const [status, setStatus] = useState<AppStatus | null>(null);
    const [modal, setModal] = useState<ModalState>(null);
    const [loading, setLoading] = useState(true);
    const [introReady, setIntroReady] = useState(false);
    const [introStage, setIntroStage] = useState<'show' | 'exit' | 'reveal' | 'done'>('show');
    const [fullscreen, setFullscreen] = useState(false);
    const [activeGameId, setActiveGameId] = useState<GameId | null>(null);
    const [phase, setPhase] = useState<Phase>('closed');
    const [listing, setListing] = useState<DirectoryListing>({ directory: '', entries: [] });
    const [selected, setSelected] = useState<ExplorerSelection | null>(null);
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

    useEffect(() => {
        const onFindShortcut = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
            if (activeGameIdRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            setSearchOpen(true);
        };
        window.addEventListener('keydown', onFindShortcut, true);
        return () => window.removeEventListener('keydown', onFindShortcut, true);
    }, []);

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
        const timer = window.setTimeout(() => setIntroReady(true), 1550);
        void window.vaporApi.isFullscreen().then(setFullscreen).catch(() => undefined);
        const removeFullscreenListener = window.vaporApi.onFullscreenChanged(setFullscreen);
        return () => {
            window.clearTimeout(timer);
            removeFullscreenListener();
        };
    }, []);

    useEffect(() => {
        if (!introReady || loading || !status || introStage !== 'show') return;
        setIntroStage('exit');
    }, [introReady, loading, status, introStage]);

    useEffect(() => {
        if (introStage !== 'exit') return;
        const finishSplash = window.setTimeout(() => setIntroStage('reveal'), 560);
        return () => window.clearTimeout(finishSplash);
    }, [introStage]);

    useEffect(() => {
        if (introStage !== 'reveal') return;
        const finishReveal = window.setTimeout(() => setIntroStage('done'), 1320);
        return () => window.clearTimeout(finishReveal);
    }, [introStage]);

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

            if (progress) {
                setTransferProgress(progress);
                if (progress.state === 'failed') {
                    throw new Error('Steam Cloud synchronization failed.');
                }
                if (progress.state !== 'waiting') {
                    const waitingLaunch = expected && progress.state === 'complete' && !game.running;
                    const waitingCloud = expected && game.running && progress.state !== 'complete';
                    setOperationDetail(waitingLaunch
                        ? 'Steam Cloud synchronized. Waiting for Steam to launch the game…'
                        : waitingCloud
                            ? 'Waiting for Steam Cloud to finish restoring files…'
                            : progress.message);
                }
            }

            // Pour une ouverture, ne jamais exposer CloudAudit tant que Steam n'a pas
            // confirmé la fin du pull Auto-Cloud. Le process du jeu peut démarrer avant
            // que les derniers fichiers soient réellement présents sur le disque.
            const cloudReady = cloudMarker === undefined || !expected || progress?.state === 'complete';
            if (game.running === expected && cloudReady) return game;

            // Relancer avec backoff si une update Steam a consommé la demande.
            const now = Date.now();
            const retryReady = progress?.state === 'complete' || now - started >= 120_000;
            if (expected && !game.running && retryReady && now >= nextLaunchRetry) {
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

                // Laisser les dernières écritures locales de Steam se stabiliser avant
                // de lire/reconstruire CloudAudit.
                await sleep(500);
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
        setSelected(null);
        setSearchOpen(false);
        setPhase('closed');

        // Toute nouvelle ouverture normale repart de la racine CloudAudit.
        // Ne jamais conserver le sous-dossier visité avant une synchronisation.
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

    if (loading || !status) {
        return (
            <main className="startup-splash" aria-label="VaporStow is starting">
                <div className="startup-glow" />
                <img className="startup-logo" src={startupLogo} alt="" />
                <div className="startup-wordmark">VaporStow</div>
                <div className="startup-loader"><span /></div>
            </main>
        );
    }

    const stageKey = activeGameId && phase === 'open' ? activeGameId : 'volumes';
    const showIntroOverlay = introStage === 'show' || introStage === 'exit';
    const introShellClass = introStage === 'show' || introStage === 'exit'
        ? 'intro-pending'
        : introStage === 'reveal'
            ? 'intro-revealing'
            : 'intro-ready';

    return (
        <>
            <main className={`shell ${activeGameId ? 'focused' : ''} ${status.platform === 'linux' ? 'linux-shell' : ''} ${introShellClass}`}>
                {status.platform === 'linux' && (
                    <div className="linux-window-controls" data-no-carousel-drag="true">
                        <button
                            className="info"
                            title="Information"
                            aria-label="Information"
                            onClick={() => setModal({ kind: 'info' })}
                        >
                            <InfoIcon />
                        </button>
                        <button
                            className={fullscreen ? 'active' : ''}
                            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                            onClick={() => void window.vaporApi.toggleFullscreen().then(setFullscreen)}
                        >
                            <FullscreenIcon active={fullscreen} />
                        </button>
                        <button className="close" title="Close" aria-label="Close" onClick={() => window.vaporApi.requestWindowClose()}>
                            <CloseIcon />
                        </button>
                    </div>
                )}
                <header>
                    <div className="brand">VaporStow</div>
                    <button
                        className={`steam ${!status.steamInstalled ? 'missing' : status.steamRunning ? 'ok' : 'idle'}`}
                        title={!status.steamInstalled ? 'Steam is not installed' : status.steamRunning ? 'Steam is running' : 'Steam is installed but not running'}
                        onClick={() => !status.steamInstalled && void window.vaporApi.openSteamDownload()}
                    >
                        Steam <i />
                    </button>
                </header>

                <div className="stage" key={stageKey}>
                    {!status.steamInstalled && !activeGameId && (
                        <button className="steam-required" onClick={() => void window.vaporApi.openSteamDownload()}>
                            Steam is required
                        </button>
                    )}

                    {(!activeGameId || (activeGame && phase !== 'open')) ? (
                        <section className={`home-clouds ${activeGame && phase !== 'open' ? 'cloud-operation-active' : ''}`}>
                            <CloudCarousel
                                games={[...status.games].sort((a, b) => a.installSize - b.installSize)}
                                actionFor={(game) => !game.platformSupported
                                    ? 'Store'
                                    : game.installing
                                        ? 'Installing…'
                                        : !game.installed
                                            ? 'Install'
                                            : !game.cloudRoot
                                                ? 'Unavailable'
                                                : 'Open'}
                                onAction={(game) => {
                                    if (!game.platformSupported) void window.vaporApi.openStore(game.id);
                                    else if (!game.installed) setModal({ kind: 'install', game });
                                    else setModal({ kind: 'open', game });
                                }}
                                introReveal={introStage === 'reveal'}
                                operationGame={activeGame && phase !== 'open' ? activeGame : null}
                                operationPhase={phase}
                                operationDetail={operationDetail}
                                operationProgress={transferProgress}
                            />
                            {!activeGameId && (introStage === 'reveal' || introStage === 'done') && (
                                <button className="home-search-trigger" onClick={() => setSearchOpen(true)}>
                                    <SearchIcon />
                                    <span>Search Cloud…</span>
                                </button>
                            )}
                            {activeGameId && phase !== 'open' && (
                                <div className="home-search-trigger home-search-placeholder" aria-hidden="true" />
                            )}
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
                        ) : null
                    ) : (
                        <div className="loading-inline">Loading volume…</div>
                    )}
                </div>
            </main>

            {showIntroOverlay && (
                <div className={`startup-splash startup-overlay ${introStage === 'exit' ? 'exiting' : ''}`} aria-label="VaporStow is starting">
                    <div className="startup-glow" />
                    <img className="startup-logo" src={startupLogo} alt="" />
                    <div className="startup-wordmark">VaporStow</div>
                    <div className="startup-loader"><span /></div>
                </div>
            )}

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
