import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type CSSProperties } from 'react';
import type { AppStatus, AuditEntry, CloudSearchEntry, CloudTransferProgress, DirectoryListing, GameStatus, GatherRepairPlan, ImportSelection, PendingProtectedDeletion, ProtectionInfo, ProtectedPoolSummary, ProtectedRepairIssue, SplitRestoreProgress } from './types';

type GameId = GameStatus['id'];
type Phase = 'closed' | 'opening' | 'open' | 'closing' | 'saving' | 'saved';
type NavDirection = 'forward' | 'back' | 'same';
type HomeCloudFilter = 'all' | 'favorites' | 'installed' | 'not-installed' | 'protected' | 'hidden' | 'advanced';

type AdvancedCloudFilters = {
    includeLocal: boolean;
    includeCatalog: boolean;
    includeInstalled: boolean;
    includeNotInstalled: boolean;
    minQuotaGiB: number;
    minFiles: number;
    maxAppSizeMiB: number;
    maxPriceUnits: number;
};

const MAX_CLOUD_QUOTA_GIB = 100_000_000_000 / (1024 ** 3);
const MAX_CLOUD_FILES_FILTER = 10_000;
const MAX_APP_SIZE_FILTER_MIB = 256 * 1024;
const MAX_GAME_PRICE_FILTER_UNITS = 101; // 101 = tous, 0 = gratuit.

function defaultAdvancedCloudFilters(): AdvancedCloudFilters {
    return {
        includeLocal: true,
        includeCatalog: true,
        includeInstalled: true,
        includeNotInstalled: true,
        minQuotaGiB: 0,
        minFiles: 0,
        maxAppSizeMiB: 0,
        maxPriceUnits: MAX_GAME_PRICE_FILTER_UNITS
    };
}

type AdvancedSourceMode = 'any' | 'local' | 'catalog';
type AdvancedInstallMode = 'any' | 'installed' | 'not-installed';

function advancedSourceMode(filters: AdvancedCloudFilters): AdvancedSourceMode {
    if (filters.includeLocal && !filters.includeCatalog) return 'local';
    if (!filters.includeLocal && filters.includeCatalog) return 'catalog';
    return 'any';
}

function withAdvancedSourceMode(filters: AdvancedCloudFilters, mode: AdvancedSourceMode): AdvancedCloudFilters {
    const leavingOutside = advancedSourceMode(filters) === 'catalog' && mode !== 'catalog';
    return {
        ...filters,
        includeLocal: mode !== 'catalog',
        includeCatalog: mode !== 'local',
        includeInstalled: mode === 'catalog' ? false : leavingOutside ? true : filters.includeInstalled,
        includeNotInstalled: mode === 'catalog' ? true : leavingOutside ? true : filters.includeNotInstalled
    };
}

function advancedInstallMode(filters: AdvancedCloudFilters): AdvancedInstallMode {
    if (filters.includeInstalled && !filters.includeNotInstalled) return 'installed';
    if (!filters.includeInstalled && filters.includeNotInstalled) return 'not-installed';
    return 'any';
}

function withAdvancedInstallMode(filters: AdvancedCloudFilters, mode: AdvancedInstallMode): AdvancedCloudFilters {
    return {
        ...filters,
        includeInstalled: mode !== 'not-installed',
        includeNotInstalled: mode !== 'installed'
    };
}

type ModalState =
    | null
    | { kind: 'install'; game: GameStatus }
    | { kind: 'open'; game: GameStatus; target?: CloudSearchEntry }
    | { kind: 'import'; game: GameStatus; directory: string; files: ImportSelection[] }
    | { kind: 'folder'; game: GameStatus; directory: string }
    | { kind: 'delete'; game: GameStatus; entry: AuditEntry }
    | { kind: 'empty-folders-sync'; game: GameStatus }
    | { kind: 'info' }
    | { kind: 'advanced-search' }
    | { kind: 'repair'; game: GameStatus; issue: ProtectedRepairIssue; targetWorked: boolean; target?: CloudSearchEntry }
    | { kind: 'message'; title: string; body: string };

type ExplorerSelection = AuditEntry | {
    path: '__parent__';
    name: '..';
    type: 'directory';
    size: 0;
    virtualParent: true;
    parentTarget: string;
};

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const AFK_TIMEOUT_MS = 10 * 60 * 1000;
const FAVORITE_CLOUDS_STORAGE_KEY = 'vaporstow.favorite-clouds.v1';
const HIDDEN_CLOUDS_STORAGE_KEY = 'vaporstow.hidden-clouds.v1';
const PROTECTED_LIBRARY_FOLDER = 'VaporStow Protected';
const PROTECTED_MIN_QUOTA_BYTES = 100_000_000_000;
const PROTECTED_MIN_FILE_SLOTS = 10_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function withUiTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return await Promise.race([
        promise,
        new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error('Search timed out.')), timeoutMs))
    ]);
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

function protectionLabel(info: ProtectionInfo): string {
    if (info.mode === 'mirror') return 'Mirror';
    if (info.dataShards && info.parityShards) return `RS ${info.dataShards}+${info.parityShards}`;
    return 'RS';
}

function protectionTooltip(info: ProtectionInfo): string {
    const title = info.mode === 'mirror'
        ? 'Mirror'
        : info.dataShards && info.parityShards
            ? `Reed–Solomon ${info.dataShards}+${info.parityShards}`
            : 'Reed–Solomon';
    const description = info.mode === 'mirror'
        ? 'Full copies stored across multiple Clouds.'
        : 'Data and parity split across multiple Clouds.';
    const members = info.memberNames.length > 0 ? info.memberNames.join('\n') : info.memberGameIds.join('\n');
    return `${title}\n${description}\n\n${members}`;
}

function ProtectionBadge({ info }: { info: ProtectionInfo }) {
    return (
        <span
            className={`protection-badge ${info.mode} ${info.state}`}
            title={protectionTooltip(info)}
            aria-label={`${protectionLabel(info)} protected storage`}
        >
            {protectionLabel(info)}
        </span>
    );
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
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < GIB) return formatBytes(bytes);
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

function reedSolomonLayout(count: number): { dataShards: number; parityShards: number } | null {
    if (count < 3) return null;
    if (count === 3) return { dataShards: 2, parityShards: 1 };
    if (count === 4) return { dataShards: 3, parityShards: 1 };
    if (count === 5) return { dataShards: 3, parityShards: 2 };
    if (count === 6) return { dataShards: 4, parityShards: 2 };
    if (count === 7) return { dataShards: 4, parityShards: 3 };
    const parityShards = Math.max(2, Math.floor(count / 3));
    return { dataShards: count - parityShards, parityShards };
}

function remainingFileSlots(game: GameStatus, open: boolean): number | null {
    const used = open ? game.cloudFiles : game.rememberedFiles;
    return used === null ? null : Math.max(0, game.maxFiles - used);
}

function usageLabel(game: GameStatus, open: boolean): string {
    const current = open ? game.auditBytes : game.rememberedBytes;
    const remaining = remainingFileSlots(game, open);

    if (!open && current === null && remaining === null) {
        return `≤ ${quotaLabel(game.quotaBytes)} · ≤ ${game.maxFiles.toLocaleString()} files`;
    }

    const bytes = current === null ? 'Unknown' : `${formatBytes(current)} / ${quotaLabel(game.quotaBytes)}`;
    const files = remaining === null ? 'Unknown files left' : `${remaining.toLocaleString()} files left`;
    return `${bytes} · ${files}`;
}

function appInstallSizeSummary(game: GameStatus): string {
    if (game.installSize <= 0) return 'App size · Unknown';
    const prefix = game.installed ? '' : '~';
    return `App size · ${prefix}${formatBytes(game.installSize)}`;
}

const APP_SIZE_FILTER_STEPS_MIB = [
    1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
    1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, MAX_APP_SIZE_FILTER_MIB
] as const;

function appSizeFilterLabel(maxMiB: number): string {
    if (maxMiB <= 0) return 'Any';
    if (maxMiB < 1024) return `≤ ${maxMiB.toLocaleString()} MiB`;
    const gib = maxMiB / 1024;
    return `≤ ${Number.isInteger(gib) ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
}

function appSizeSliderIndex(maxMiB: number): number {
    if (maxMiB <= 0) return APP_SIZE_FILTER_STEPS_MIB.length;
    const exact = APP_SIZE_FILTER_STEPS_MIB.indexOf(maxMiB as typeof APP_SIZE_FILTER_STEPS_MIB[number]);
    if (exact >= 0) return exact;
    let best = 0;
    for (let index = 0; index < APP_SIZE_FILTER_STEPS_MIB.length; index += 1) {
        if (APP_SIZE_FILTER_STEPS_MIB[index] <= maxMiB) best = index;
    }
    return best;
}


function compactGameName(name: string, maxChars = 25): string {
    const clean = name.trim();
    if (clean.length <= maxChars) return clean;
    return `${clean.slice(0, maxChars).trimEnd()}…`;
}

function matchesAdvancedFilters(game: GameStatus, filters: AdvancedCloudFilters): boolean {
    const sourceMode = advancedSourceMode(filters);
    if (sourceMode === 'catalog' && (game.inLibrary || game.installed)) return false;
    if (sourceMode === 'local' && !game.inLibrary && !game.installed) return false;
    if (sourceMode === 'any') {
        const sourceAllowed = game.inLibrary || game.installed ? filters.includeLocal : filters.includeCatalog;
        if (!sourceAllowed) return false;
    }
    if (game.installed ? !filters.includeInstalled : !filters.includeNotInstalled) return false;

    const quotaGiB = game.quotaBytes / GIB;
    if (quotaGiB + 1e-6 < filters.minQuotaGiB) return false;
    if (game.maxFiles < filters.minFiles) return false;

    const appSizeUnlimited = filters.maxAppSizeMiB <= 0;
    if (game.installSize > 0) {
        const appSizeMiB = game.installSize / MIB;
        if (!appSizeUnlimited && appSizeMiB > filters.maxAppSizeMiB) return false;
    }

    const priceUnlimited = filters.maxPriceUnits >= MAX_GAME_PRICE_FILTER_UNITS;
    if (!game.inLibrary && !priceUnlimited) {
        if (game.storePriceCents === null) return false;
        if (game.storePriceCents > filters.maxPriceUnits * 100) return false;
    }
    return true;
}

function advancedFilterCount(filters: AdvancedCloudFilters): number {
    let count = 0;
    if (!filters.includeLocal || !filters.includeCatalog) count += 1;
    if (!filters.includeInstalled || !filters.includeNotInstalled) count += 1;
    if (filters.minQuotaGiB > 0) count += 1;
    if (filters.minFiles > 0) count += 1;
    if (filters.maxAppSizeMiB > 0) count += 1;
    if (filters.maxPriceUnits < MAX_GAME_PRICE_FILTER_UNITS) count += 1;
    return count;
}

function compareHomeGames(left: GameStatus, right: GameStatus): number {
    return Number(right.installed) - Number(left.installed)
        || right.quotaBytes - left.quotaBytes
        || right.maxFiles - left.maxFiles
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
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
    }
}


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

function SlidersIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4" />
            <circle cx="16" cy="6" r="2" />
            <circle cx="9" cy="12" r="2" />
            <circle cx="14" cy="18" r="2" />
        </svg>
    );
}

function FavoriteIcon({ active = false, size = 15 }: { active?: boolean; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill={active ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z" />
        </svg>
    );
}

function VisibilityIcon({ hidden = false, size = 15 }: { hidden?: boolean; size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
            <circle cx="12" cy="12" r="2.6" />
            {hidden && <path d="M4 4l16 16" />}
        </svg>
    );
}

function ShieldIcon({ size = 15 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l7 3v5c0 4.7-2.8 8.1-7 10-4.2-1.9-7-5.3-7-10V6l7-3Z" />
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

    const visibleResults = useMemo(
        () => results.filter((entry) => !(entry.type === 'directory' && normalizeRelative(entry.path) === PROTECTED_LIBRARY_FOLDER)),
        [results]
    );

    const searchDisplayPath = (entry: CloudSearchEntry): string => {
        const normalized = normalizeRelative(entry.path);
        const prefix = `${PROTECTED_LIBRARY_FOLDER}/`;
        return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    };

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
                        placeholder="Search files..."
                        aria-label="Search cached Steam Cloud files and folders"
                    />
                    <span>Esc</span>
                </div>

                <div className="search-results" aria-live="polite">
                    {loading ? (
                        <div className="search-state">Searching…</div>
                    ) : visibleResults.length === 0 ? (
                        <div className="search-state">
                            {query ? 'No cached item matches this search.' : 'No cached Cloud data yet. Open a supported Cloud once to index it.'}
                        </div>
                    ) : (
                        <div className="search-grid">
                            {visibleResults.map((entry) => (
                                <button
                                    key={`${entry.gameId}:${entry.path}`}
                                    className="search-result"
                                    title={`${searchDisplayPath(entry)}
${entry.gameName} · ${entry.volumeName}`}
                                    onClick={() => openEntry(entry)}
                                >
                                    <span className="search-result-icon">
                                        {entry.type === 'directory' ? <FolderIcon /> : <FileIcon />}
                                    </span>
                                    <strong>{entry.name}</strong>
                                    {entry.protection && <ProtectionBadge info={entry.protection} />}
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
    beginImport,
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
    beginImport: (game: GameStatus, directory: string, droppedPaths?: string[]) => Promise<void>;
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
            <div className="cloud-ambient-art" aria-hidden="true"><SteamArtworkImage game={game} /></div>

            <div className="cloud-topbar">
                <div className="cloud-topbar-main">
                    <button
                        className="icon-button cloud-back-button"
                        aria-label={directory ? 'Parent folder' : 'Back to Clouds'}
                        title={directory ? 'Parent folder' : (hasUnsynchronizedChanges ? 'Synchronize your changes before going back' : 'Back to Clouds')}
                        onClick={() => void goBack()}
                    >
                        <BackIcon />
                    </button>
                    <div className="cloud-game-art" aria-hidden="true">
                        <span className="cloud-game-art-loader"><span /></span>
                        <SteamArtworkImage game={game} />
                    </div>
                    <div className="cloud-title">
                        <div className="cloud-title-line">
                            <span className="status-dot running" />
                            <strong title={game.name}>{game.name}</strong>
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
                        onClick={() => void beginImport(game, directory)}
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
                        title={selectedIsParent
                            ? 'The parent shortcut cannot be deleted'
                            : selected && selected.type === 'directory' && normalizeRelative(selected.path) === PROTECTED_LIBRARY_FOLDER
                                ? 'This folder is managed automatically by VaporStow'
                                : selected && 'protection' in selected && selected.protection
                                    ? `Delete ${selected.name} from every Cloud in its protected pool`
                                    : selected ? `Delete ${selected.name}` : 'Select a file or folder to delete'}
                        disabled={!selected || selectedIsParent || Boolean(selected && selected.type === 'directory' && normalizeRelative(selected.path) === PROTECTED_LIBRARY_FOLDER)}
                        onClick={() => {
                            if (!selected || selectedIsParent) return;
                            if (selected.type === 'directory' && normalizeRelative(selected.path) === PROTECTED_LIBRARY_FOLDER) return;
                            setModal({ kind: 'delete', game, entry: selected as AuditEntry });
                        }}
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
                                    <span className="file-name-cell">
                                        <span className="file-name">{entry.name}</span>
                                        {!isParentEntry && 'protection' in entry && entry.protection && <ProtectionBadge info={entry.protection} />}
                                    </span>
                                    <span className="file-size">{isParentEntry ? 'Parent folder' : entry.type === 'file' ? formatBytes(entry.size) : 'Folder'}</span>
                                    <button
                                        className={`reveal-button ${isParentEntry || (!isParentEntry && 'virtualProtected' in entry && entry.virtualProtected) ? 'disabled' : ''}`}
                                        aria-label={isParentEntry ? 'Parent folder shortcut' : `Show ${entry.name} in system folder`}
                                        title={isParentEntry
                                            ? 'Parent folder'
                                            : (!isParentEntry && 'virtualProtected' in entry && entry.virtualProtected)
                                                ? 'This file is distributed across a protected pool'
                                                : 'Show in folder'}
                                        disabled={isParentEntry || Boolean(!isParentEntry && 'virtualProtected' in entry && entry.virtualProtected)}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            if (isParentEntry || ('virtualProtected' in entry && entry.virtualProtected)) return;
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

const ABOUT_CONTRIBUTORS = [
    {
        name: 'Nullmess',
        username: 'nullmess',
        avatarUrl: 'https://avatars.githubusercontent.com/u/326523721?s=160&v=4'
    },
    {
        name: 'Ybucaille',
        username: 'Ybucaille',
        avatarUrl: 'https://avatars.githubusercontent.com/u/83926195?s=160&v=4'
    }
] as const;

function Modal({
    modal,
    close,
    refresh,
    reloadDirectory,
    confirmOpen,
    confirmEmptyFoldersSync,
    onMutation,
    advancedFilters,
    setAdvancedFilters,
    activateAdvancedFilter,
    resetAdvancedSearch,
    setAdvancedSearchRunning,
    applyStatus,
    steamRunning,
    games,
    confirmProtectedImport,
    confirmProtectedDelete,
    confirmProtectedRepair
}: {
    modal: ModalState;
    close: () => void;
    refresh: () => Promise<AppStatus>;
    reloadDirectory: (id: GameId, directory: string) => Promise<void>;
    confirmOpen: (game: GameStatus, target?: CloudSearchEntry) => Promise<void>;
    confirmEmptyFoldersSync: (game: GameStatus) => Promise<boolean>;
    onMutation: () => void;
    advancedFilters: AdvancedCloudFilters;
    setAdvancedFilters: (filters: AdvancedCloudFilters) => void;
    activateAdvancedFilter: () => void;
    resetAdvancedSearch: () => void;
    setAdvancedSearchRunning: (running: boolean) => void;
    applyStatus: (status: AppStatus) => void;
    steamRunning: boolean;
    games: GameStatus[];
    confirmProtectedImport: (mode: 'mirror' | 'reed-solomon', origin: GameStatus, memberIds: GameId[], directory: string, files: ImportSelection[]) => Promise<void>;
    confirmProtectedDelete: (origin: GameStatus, entry: AuditEntry) => Promise<void>;
    confirmProtectedRepair: (modal: Extract<ModalState, { kind: 'repair' }>, choice: 'replacement' | 'gather', destinationId: GameId) => Promise<void>;
}) {
    const [value, setValue] = useState('');
    const [visibleModal, setVisibleModal] = useState<ModalState>(modal);
    const [closing, setClosing] = useState(false);
    const [working, setWorking] = useState(false);
    const [advancedDraft, setAdvancedDraft] = useState<AdvancedCloudFilters>(() => ({ ...advancedFilters }));
    const [advancedSearching, setAdvancedSearching] = useState(false);
    const [advancedSearchMessage, setAdvancedSearchMessage] = useState<string | null>(null);
    const [importMode, setImportMode] = useState<'normal' | 'mirror' | 'reed-solomon'>('normal');
    const [importCloudIds, setImportCloudIds] = useState<Set<GameId>>(new Set());
    const [repairChoice, setRepairChoice] = useState<'replacement' | 'gather'>('replacement');
    const [repairCloudId, setRepairCloudId] = useState<GameId | null>(null);

    useEffect(() => {
        if (modal) {
            if (modal.kind === 'advanced-search') {
                setAdvancedDraft({ ...advancedFilters });
                setAdvancedSearchMessage(null);
            }
            if (modal.kind === 'import') {
                setImportMode('normal');
                setImportCloudIds(new Set([modal.game.id]));
            }
            if (modal.kind === 'repair') {
                setRepairChoice('replacement');
                setRepairCloudId(null);
            }
            setVisibleModal(modal);
            setClosing(false);
            setWorking(false);
            setValue('');
            return;
        }

        if (visibleModal) {
            setClosing(true);
            const closeDelay = visibleModal.kind === 'advanced-search' ? 240 : 150;
            const timer = window.setTimeout(() => {
                setVisibleModal(null);
                setClosing(false);
            }, closeDelay);
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
        if (working || advancedSearching) return;
        setAdvancedSearchRunning(false);
        close();
    };
    const updateAdvancedDraft = (update: (current: AdvancedCloudFilters) => AdvancedCloudFilters) => {
        setAdvancedDraft((current) => update(current));
        setAdvancedSearchMessage(null);
    };

    const runAdvancedSearch = async () => {
        if (advancedSearching) return;
        const criteria = advancedSourceMode(advancedDraft) === 'catalog'
            ? {
                ...advancedDraft,
                includeInstalled: false,
                includeNotInstalled: true,
                maxPriceUnits: 0
            }
            : { ...advancedDraft };

        setAdvancedSearchRunning(true);
        setAdvancedSearching(true);
        setAdvancedSearchMessage(null);
        const loadingStartedAt = Date.now();
        try {
            const shouldSearchCatalog = criteria.includeCatalog && criteria.includeNotInstalled;
            if (shouldSearchCatalog) {
                const appSizeUnlimited = criteria.maxAppSizeMiB <= 0;
                const nextStatus = await withUiTimeout(window.vaporApi.searchExternalCatalog({
                    minQuotaBytes: Math.max(0, Math.round(criteria.minQuotaGiB * GIB)),
                    minFiles: Math.max(0, Math.floor(criteria.minFiles)),
                    maxAppSizeBytes: appSizeUnlimited ? null : Math.max(1, Math.round(criteria.maxAppSizeMiB * MIB)),
                    targetResults: 36
                }), 46_000);

                const previewGames = nextStatus.games
                    .filter((game) => game.quotaBytes > 0 && game.maxFiles > 0 && matchesAdvancedFilters(game, criteria))
                    .sort(compareHomeGames)
                    .slice(0, 5);
                await Promise.allSettled(previewGames.map((game) => preloadGameArtwork(game)));
                applyStatus(nextStatus);
            }

            const remainingLoadingMs = 520 - (Date.now() - loadingStartedAt);
            if (remainingLoadingMs > 0) await sleep(remainingLoadingMs);

            setAdvancedFilters(criteria);
            activateAdvancedFilter();
            close();
        } catch {
            setAdvancedFilters(criteria);
            activateAdvancedFilter();
            setAdvancedSearchMessage('Search unavailable. Try again.');
        } finally {
            setAdvancedSearching(false);
            setAdvancedSearchRunning(false);
        }
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
                        <span>App size</span>
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
                        disabled={working || !steamRunning}
                        title={!steamRunning ? 'Steam is not running' : undefined}
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
        const enough = cloudFolderExists || game.running || available === null || available >= required;

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
                        Not enough free local space.
                    </div>
                )}
                <div className="modal-actions">
                    <button onClick={requestClose}>Cancel</button>
                    <button
                        className="primary"
                        disabled={!enough || !steamRunning}
                        title={!steamRunning ? 'Steam is not running' : undefined}
                        onClick={() => void confirmOpen(game, active.target)}
                    >
                        Open
                    </button>
                </div>
            </>
        );
    } else if (active.kind === 'import') {
        const totalBytes = active.files.reduce((sum, file) => sum + file.size, 0);
        const protectedOriginEligible = active.game.quotaBytes >= PROTECTED_MIN_QUOTA_BYTES
            && active.game.maxFiles >= PROTECTED_MIN_FILE_SLOTS;
        const location = importMode === 'normal'
            ? [active.game.name, normalizeRelative(active.directory)].filter(Boolean).join('/')
            : PROTECTED_LIBRARY_FOLDER;
        const compatibleGames = games
            .filter((game) => game.id === active.game.id || (
                game.quotaBytes >= PROTECTED_MIN_QUOTA_BYTES
                && game.maxFiles >= PROTECTED_MIN_FILE_SLOTS
            ));
        const protectedReadiness = (game: GameStatus): { ready: boolean; reason: string | null } => {
            if (game.id === active.game.id) return { ready: true, reason: null };
            if (!game.platformSupported) return { ready: false, reason: 'Not supported on this platform' };
            if (game.installing) return { ready: false, reason: 'Installation in progress' };
            if (!game.installed) return { ready: false, reason: 'Install required' };
            if (!game.cloudRoot || (!game.cloudRootExists && game.rememberedBytes === null)) {
                return { ready: false, reason: 'Open this Cloud once first' };
            }
            return { ready: true, reason: null };
        };
        const selectedIds = importMode === 'normal' ? new Set<GameId>([active.game.id]) : importCloudIds;
        const minimum = importMode === 'normal' ? 1 : importMode === 'mirror' ? 2 : 3;
        const selectedCount = selectedIds.size;
        const rsLayout = importMode === 'reed-solomon' ? reedSolomonLayout(selectedCount) : null;
        const perCloudBytes = importMode === 'reed-solomon' && rsLayout
            ? active.files.reduce((sum, file) => sum + Math.ceil(file.size / rsLayout.dataShards), 0)
            : totalBytes;
        const perCloudFiles = active.files.length + (importMode === 'normal' ? 0 : 1);
        const protectedCloudAvailable = (game: GameStatus): boolean => {
            if (game.id === active.game.id) return true;
            const readiness = protectedReadiness(game);
            const usedBytes = game.rememberedBytes ?? 0;
            const usedFiles = game.rememberedFiles ?? 0;
            const fits = usedBytes + perCloudBytes <= game.quotaBytes && usedFiles + perCloudFiles <= game.maxFiles;
            return readiness.ready && !game.running && fits;
        };
        const displayedGames = [...compatibleGames].sort((left, right) => {
            if (left.id === active.game.id) return -1;
            if (right.id === active.game.id) return 1;
            const leftAvailable = protectedCloudAvailable(left);
            const rightAvailable = protectedCloudAvailable(right);
            if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
            return left.name.localeCompare(right.name);
        });
        const selectedGames = compatibleGames.filter((game) => selectedIds.has(game.id));
        const targetRunningBlocked = selectedGames.some((game) => game.id !== active.game.id && game.running);
        const capacityBlocked = importMode !== 'normal' && selectedGames.some((game) => {
            const usedBytes = game.id === active.game.id ? game.auditBytes : (game.rememberedBytes ?? 0);
            const usedFiles = game.id === active.game.id ? game.auditFiles : (game.rememberedFiles ?? 0);
            return usedBytes + perCloudBytes > game.quotaBytes || usedFiles + perCloudFiles > game.maxFiles;
        });
        const enoughClouds = selectedCount >= minimum;
        const canImport = enoughClouds
            && (importMode === 'normal' || protectedOriginEligible)
            && !capacityBlocked
            && !targetRunningBlocked
            && !working;

        const chooseMode = (mode: 'normal' | 'mirror' | 'reed-solomon') => {
            if (mode !== 'normal' && !protectedOriginEligible) return;
            setImportMode(mode);
            if (mode === 'normal') setImportCloudIds(new Set([active.game.id]));
            else setImportCloudIds((current) => {
                const next = new Set([...current].filter((id) => {
                    const game = games.find((candidate) => candidate.id === id);
                    return Boolean(game
                        && game.quotaBytes >= PROTECTED_MIN_QUOTA_BYTES
                        && game.maxFiles >= PROTECTED_MIN_FILE_SLOTS
                        && protectedReadiness(game).ready);
                }));
                next.add(active.game.id);
                return next;
            });
        };
        const toggleCloud = (game: GameStatus) => {
            if (importMode === 'normal' || game.id === active.game.id) return;
            setImportCloudIds((current) => {
                const next = new Set(current);
                if (next.has(game.id)) next.delete(game.id);
                else next.add(game.id);
                next.add(active.game.id);
                return next;
            });
        };

        content = (
            <div className="import-storage-modal">
                <div className="import-heading-row">
                    <div>
                        <h3>Import</h3>
                        <p className="modal-copy subtle import-location">Location: /{location}/</p>
                    </div>
                    <div className="import-selection-summary">
                        <strong>{active.files.length.toLocaleString()} File{active.files.length === 1 ? '' : 's'}</strong>
                        <small>{formatBytes(totalBytes)}</small>
                    </div>
                </div>

                <div className="import-storage-layout">
                    <div className="import-mode-list" role="radiogroup" aria-label="Storage mode">
                        <button type="button" className={`import-mode-option ${importMode === 'normal' ? 'selected' : ''}`} onClick={() => chooseMode('normal')}>
                            <span className="import-mode-radio" aria-hidden="true" />
                            <span><strong>Normal</strong></span>
                        </button>
                        <button
                            type="button"
                            className={`import-mode-option ${importMode === 'mirror' ? 'selected' : ''}`}
                            disabled={!protectedOriginEligible}
                            title={protectedOriginEligible
                                ? 'Keep a full copy on multiple Clouds.'
                                : 'Keep a full copy on multiple Clouds. Requires at least 93 GiB and 10,000 file slots.'}
                            onClick={() => chooseMode('mirror')}
                        >
                            <span className="import-mode-radio" aria-hidden="true" />
                            <span><strong>Mirror</strong><small>2 minimum</small></span>
                        </button>
                        <button
                            type="button"
                            className={`import-mode-option ${importMode === 'reed-solomon' ? 'selected' : ''}`}
                            disabled={!protectedOriginEligible}
                            title={protectedOriginEligible
                                ? 'Split data and parity across multiple Clouds.'
                                : 'Split data and parity across multiple Clouds. Requires at least 93 GiB and 10,000 file slots.'}
                            onClick={() => chooseMode('reed-solomon')}
                        >
                            <span className="import-mode-radio" aria-hidden="true" />
                            <span><strong>Reed–Solomon</strong><small>3 minimum</small></span>
                        </button>
                    </div>

                    <div className="import-cloud-list" aria-label="Cloud selection">
                        {displayedGames.map((game) => {
                            const selected = selectedIds.has(game.id);
                            const locked = game.id === active.game.id;
                            const normalDisabled = importMode === 'normal' && !locked;
                            const readiness = protectedReadiness(game);
                            const usedBytes = game.id === active.game.id ? game.auditBytes : (game.rememberedBytes ?? 0);
                            const usedFiles = game.id === active.game.id ? game.auditFiles : (game.rememberedFiles ?? 0);
                            const fits = importMode === 'normal' || (usedBytes + perCloudBytes <= game.quotaBytes && usedFiles + perCloudFiles <= game.maxFiles);
                            const targetRunning = game.id !== active.game.id && game.running;
                            const unavailable = importMode !== 'normal' && (!readiness.ready || targetRunning || !fits);
                            const disabled = normalDisabled || unavailable;
                            const title = locked && !fits
                                ? 'Current Cloud does not have enough capacity for this protected import'
                                : locked
                                    ? 'Current Cloud · always included'
                                    : normalDisabled
                                        ? 'Select Mirror or Reed–Solomon to use additional Clouds'
                                        : readiness.reason
                                            ?? (targetRunning
                                                ? 'This app is already running'
                                                : !fits
                                                    ? 'Not enough Cloud capacity for this import'
                                                    : selected
                                                        ? 'Remove from protected storage'
                                                        : 'Add to protected storage');
                            return (
                                <button
                                    type="button"
                                    key={game.id}
                                    className={`import-cloud-card ${selected ? 'selected' : ''} ${locked ? 'locked' : ''} ${disabled ? 'disabled' : ''}`}
                                    aria-disabled={disabled}
                                    tabIndex={disabled ? -1 : 0}
                                    onClick={() => { if (!disabled) toggleCloud(game); }}
                                    title={title}
                                >
                                    <span className="import-cloud-art" aria-hidden="true">
                                        <span className="cloud-card-art-loader"><span /></span>
                                        <SteamArtworkImage game={game} />
                                    </span>
                                    <span className="import-cloud-copy">
                                        <strong>{compactGameName(game.name, 28)}</strong>
                                        <small>{formatBytes(usedBytes)} / {quotaLabel(game.quotaBytes)} · {usedFiles.toLocaleString()} / {game.maxFiles.toLocaleString()} files</small>
                                        {importMode !== 'normal' && !locked && (readiness.reason || targetRunning || !fits) && (
                                            <small className="import-cloud-status">{readiness.reason ?? (targetRunning ? 'Already running' : 'Not enough capacity')}</small>
                                        )}
                                    </span>
                                    <span className="import-cloud-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {!enoughClouds && importMode !== 'normal' && (
                    <p className="import-validation">Select at least {minimum} Clouds.</p>
                )}
                {capacityBlocked && <p className="import-validation">One selected Cloud does not have enough capacity.</p>}
                {targetRunningBlocked && <p className="import-validation">Close other selected Steam apps before importing.</p>}

                <div className="modal-actions import-actions">
                    <button disabled={working} onClick={requestClose}>Cancel</button>
                    <button
                        className="primary"
                        disabled={!canImport}
                        onClick={() => {
                            if (!canImport) return;
                            if (importMode === 'normal') {
                                void run(
                                    () => window.vaporApi.importSelectedFiles(active.game.id, active.directory, active.files),
                                    active.game,
                                    active.directory,
                                    true
                                );
                                return;
                            }
                            setWorking(true);
                            const memberIds = [...selectedIds];
                            close();
                            void (async () => {
                                await sleep(120);
                                try {
                                    await confirmProtectedImport(importMode, active.game, memberIds, active.directory, active.files);
                                } catch (error) {
                                    alert(error instanceof Error ? error.message : String(error));
                                }
                            })();
                        }}
                    >
                        {working ? 'Preparing…' : 'Import'}
                    </button>
                </div>
            </div>
        );
    } else if (active.kind === 'repair') {
        const corruptGames = active.issue.corruptGameIds
            .map((id) => games.find((game) => game.id === id))
            .filter((game): game is GameStatus => Boolean(game));
        const replacementSingleCorrupt = active.issue.corruptGameIds.length === 1;
        const requiredBytes = active.issue.totalBytes;
        const requiredFiles = active.issue.fileCount;
        const readiness = (game: GameStatus): { ready: boolean; reason: string | null } => {
            if (game.protectedCorrupt) return { ready: false, reason: 'Corrupt Cloud' };
            if (!game.platformSupported) return { ready: false, reason: 'Not supported on this platform' };
            if (game.installing) return { ready: false, reason: 'Installation in progress' };
            if (!game.installed) return { ready: false, reason: 'Install required' };
            if (!game.cloudRoot || (!game.cloudRootExists && game.rememberedBytes === null)) return { ready: false, reason: 'Open this Cloud once first' };
            return { ready: true, reason: null };
        };
        const candidateGames = games.filter((game) => {
            if (active.issue.corruptGameIds.includes(game.id)) return false;
            if (repairChoice === 'replacement') {
                if (!replacementSingleCorrupt) return false;
                if (active.targetWorked && game.id === active.game.id) return false;
                if (active.issue.memberGameIds.includes(game.id)) return false;
                return game.quotaBytes >= PROTECTED_MIN_QUOTA_BYTES && game.maxFiles >= PROTECTED_MIN_FILE_SLOTS;
            }
            const usedBytes = game.id === active.game.id && active.targetWorked ? game.auditBytes : (game.rememberedBytes ?? 0);
            const usedFiles = game.id === active.game.id && active.targetWorked ? game.auditFiles : (game.rememberedFiles ?? 0);
            return game.quotaBytes - usedBytes >= requiredBytes && game.maxFiles - usedFiles >= requiredFiles;
        }).sort((left, right) => {
            const leftReady = readiness(left).ready && (!left.running || (active.targetWorked && left.id === active.game.id));
            const rightReady = readiness(right).ready && (!right.running || (active.targetWorked && right.id === active.game.id));
            if (leftReady !== rightReady) return leftReady ? -1 : 1;
            return left.name.localeCompare(right.name);
        });
        const selectedCandidate = repairCloudId ? candidateGames.find((game) => game.id === repairCloudId) ?? null : null;
        const selectedReadiness = selectedCandidate ? readiness(selectedCandidate) : null;
        const selectedRunningBlocked = Boolean(selectedCandidate?.running && !(active.targetWorked && selectedCandidate.id === active.game.id));
        const canRepair = Boolean(
            selectedCandidate
            && selectedReadiness?.ready
            && !selectedRunningBlocked
            && (repairChoice === 'gather' || replacementSingleCorrupt)
            && !working
        );
        const chooseRepair = (choice: 'replacement' | 'gather') => {
            setRepairChoice(choice);
            setRepairCloudId(null);
        };
        content = (
            <div className="repair-storage-modal">
                <div className="import-heading-row repair-heading-row">
                    <div>
                        <h3>Repair File(s)</h3>
                    </div>
                    <div className="import-selection-summary">
                        <strong>{active.issue.fileCount.toLocaleString()} corrupt file{active.issue.fileCount === 1 ? '' : '(s)'}</strong>
                        <small>{formatBytes(active.issue.totalBytes)}</small>
                    </div>
                </div>

                <div className="repair-storage-layout">
                    <div className="repair-left-column">
                        <section className="repair-corrupt-section">
                            <strong>Corrupt Game(s)</strong>
                            <div className="repair-corrupt-list">
                                {corruptGames.map((game) => (
                                    <div className="import-cloud-card repair-corrupt-card" key={game.id}>
                                        <span className="import-cloud-art" aria-hidden="true">
                                            <span className="cloud-card-art-loader"><span /></span>
                                            <SteamArtworkImage game={game} />
                                        </span>
                                        <span className="import-cloud-copy">
                                            <strong>{compactGameName(game.name, 26)}</strong>
                                            <small>{formatBytes(game.rememberedBytes ?? 0)} / {quotaLabel(game.quotaBytes)} · {(game.rememberedFiles ?? 0).toLocaleString()} / {game.maxFiles.toLocaleString()} files</small>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </section>
                        <section className="repair-choice-section">
                            <strong>Repair Choice</strong>
                            <button type="button" className={`import-mode-option ${repairChoice === 'replacement' ? 'selected' : ''}`} disabled={!replacementSingleCorrupt} title={replacementSingleCorrupt ? 'Replace the unavailable Cloud.' : 'Replacement repairs one unavailable Cloud at a time.'} onClick={() => chooseRepair('replacement')}>
                                <span className="import-mode-radio" aria-hidden="true" />
                                <span><strong>Replacement</strong></span>
                            </button>
                            <button type="button" className={`import-mode-option ${repairChoice === 'gather' ? 'selected' : ''}`} title="Recover the files into one Cloud and remove protected storage." onClick={() => chooseRepair('gather')}>
                                <span className="import-mode-radio" aria-hidden="true" />
                                <span><strong>Gather in one place</strong></span>
                            </button>
                        </section>
                    </div>

                    <div className="import-cloud-list repair-cloud-list" aria-label="Repair destination Cloud">
                        {candidateGames.map((game) => {
                            const state = readiness(game);
                            const runningBlocked = game.running && !(active.targetWorked && game.id === active.game.id);
                            const disabled = !state.ready || runningBlocked;
                            const selected = game.id === repairCloudId;
                            const title = state.reason ?? (runningBlocked ? 'This app is already running' : selected ? 'Selected repair destination' : 'Use this Cloud');
                            return (
                                <button
                                    type="button"
                                    key={game.id}
                                    className={`import-cloud-card ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
                                    aria-disabled={disabled}
                                    tabIndex={disabled ? -1 : 0}
                                    title={title}
                                    onClick={() => { if (!disabled) setRepairCloudId(game.id); }}
                                >
                                    <span className="import-cloud-art" aria-hidden="true">
                                        <span className="cloud-card-art-loader"><span /></span>
                                        <SteamArtworkImage game={game} />
                                    </span>
                                    <span className="import-cloud-copy">
                                        <strong>{compactGameName(game.name, 28)}</strong>
                                        <small>{formatBytes(game.id === active.game.id && active.targetWorked ? game.auditBytes : (game.rememberedBytes ?? 0))} / {quotaLabel(game.quotaBytes)} · {(game.id === active.game.id && active.targetWorked ? game.auditFiles : (game.rememberedFiles ?? 0)).toLocaleString()} / {game.maxFiles.toLocaleString()} files</small>
                                        {(state.reason || runningBlocked) && <small className="import-cloud-status">{state.reason ?? 'Already running'}</small>}
                                    </span>
                                    <span className="import-cloud-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                                </button>
                            );
                        })}
                        {candidateGames.length === 0 && <p className="import-validation">No compatible repair destination is available.</p>}
                    </div>
                </div>

                <div className="modal-actions import-actions">
                    <button disabled={working} onClick={requestClose}>Cancel</button>
                    <button
                        className="primary"
                        disabled={!canRepair}
                        onClick={() => {
                            if (!canRepair || !repairCloudId) return;
                            setWorking(true);
                            const snapshot = active;
                            const choice = repairChoice;
                            const destinationId = repairCloudId;
                            close();
                            void confirmProtectedRepair(snapshot, choice, destinationId);
                        }}
                    >
                        {working ? 'Repairing…' : 'Repair'}
                    </button>
                </div>
            </div>
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
    } else if (active.kind === 'advanced-search') {
        const appSizeIndex = appSizeSliderIndex(advancedDraft.maxAppSizeMiB);
        const sourceMode = advancedSourceMode(advancedDraft);
        const externalOnly = sourceMode === 'catalog';
        const installMode: AdvancedInstallMode = externalOnly ? 'not-installed' : advancedInstallMode(advancedDraft);
        content = (
            <div className="advanced-search-panel-content">
                <div className="advanced-search-heading">
                    <div>
                        <h3>Advanced search</h3>
                    </div>
                    <div className="advanced-search-heading-actions">
                        <button type="button" className="advanced-drawer-close" aria-label="Close advanced search" title="Close" onClick={requestClose}>×</button>
                    </div>
                </div>

                <section className="advanced-filter-section advanced-choice-section">
                    <div className="advanced-filter-section-title"><strong>Source</strong></div>
                    <div className="advanced-segmented" role="radiogroup" aria-label="Cloud source">
                        {([
                            ['any', 'Any'],
                            ['local', 'Library'],
                            ['catalog', 'Outside']
                        ] as Array<[AdvancedSourceMode, string]>).map(([mode, label]) => (
                            <button
                                key={mode}
                                type="button"
                                role="radio"
                                aria-checked={sourceMode === mode}
                                className={sourceMode === mode ? 'active' : ''}
                                onClick={() => updateAdvancedDraft((current) => withAdvancedSourceMode(current, mode))}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </section>

                <section className="advanced-filter-section advanced-choice-section">
                    <div className="advanced-filter-section-title"><strong>Install state</strong></div>
                    <div className="advanced-segmented" role="radiogroup" aria-label="Install state">
                        {([
                            ['any', 'Any'],
                            ['installed', 'Installed'],
                            ['not-installed', 'Not installed']
                        ] as Array<[AdvancedInstallMode, string]>).map(([mode, label]) => {
                            const disabled = externalOnly && mode !== 'not-installed';
                            return (
                                <button
                                    key={mode}
                                    type="button"
                                    role="radio"
                                    aria-checked={installMode === mode}
                                    className={installMode === mode ? 'active' : ''}
                                    disabled={disabled}
                                    title={disabled ? 'Outside apps are necessarily not installed.' : undefined}
                                    onClick={() => updateAdvancedDraft((current) => withAdvancedInstallMode(current, mode))}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                </section>

                <section className="advanced-filter-section advanced-range-group">
                    <div className="advanced-filter-section-title"><strong>Cloud</strong></div>
                    <div className="advanced-range-list">
                        <div className="advanced-range-item">
                            <div className="advanced-range-label"><span>Minimum quota</span><strong>{advancedDraft.minQuotaGiB <= 0 ? 'Any' : `≥ ${advancedDraft.minQuotaGiB.toFixed(2)} GiB`}</strong></div>
                            <input type="range" min="0" max={MAX_CLOUD_QUOTA_GIB.toFixed(2)} step="0.01" value={advancedDraft.minQuotaGiB} onChange={(event) => updateAdvancedDraft((current) => ({ ...current, minQuotaGiB: Number(event.target.value) }))} />
                            <div className="advanced-range-scale"><span>Any</span><span>93.13 GiB</span></div>
                        </div>

                        <div className="advanced-range-item">
                            <div className="advanced-range-label"><span>Minimum files</span><strong>{advancedDraft.minFiles <= 0 ? 'Any' : `≥ ${advancedDraft.minFiles.toLocaleString()}`}</strong></div>
                            <input type="range" min="0" max={MAX_CLOUD_FILES_FILTER} step="100" value={advancedDraft.minFiles} onChange={(event) => updateAdvancedDraft((current) => ({ ...current, minFiles: Number(event.target.value) }))} />
                            <div className="advanced-range-scale"><span>Any</span><span>10,000</span></div>
                        </div>
                    </div>
                </section>

                <section className="advanced-filter-section advanced-range-group">
                    <div className="advanced-filter-section-title"><strong>App</strong></div>
                    <div className="advanced-range-list">
                        <div className="advanced-range-item">
                            <div className="advanced-range-label"><span>Maximum size</span><strong>{appSizeFilterLabel(advancedDraft.maxAppSizeMiB)}</strong></div>
                            <input
                                type="range"
                                min="0"
                                max={APP_SIZE_FILTER_STEPS_MIB.length}
                                step="1"
                                value={appSizeIndex}
                                onChange={(event) => {
                                    const index = Number(event.target.value);
                                    const maxAppSizeMiB = index >= APP_SIZE_FILTER_STEPS_MIB.length ? 0 : APP_SIZE_FILTER_STEPS_MIB[index];
                                    updateAdvancedDraft((current) => ({ ...current, maxAppSizeMiB }));
                                }}
                            />
                            <div className="advanced-range-scale"><span>1 MiB</span><span>Any</span></div>
                        </div>

                        <div className={`advanced-range-item ${externalOnly ? 'locked-filter' : ''}`}>
                            <div className="advanced-range-label"><span>Maximum price</span><strong>{externalOnly ? 'Free' : advancedDraft.maxPriceUnits >= MAX_GAME_PRICE_FILTER_UNITS ? 'Any' : advancedDraft.maxPriceUnits <= 0 ? 'Free' : `≤ ${advancedDraft.maxPriceUnits.toFixed(0)}`}</strong></div>
                            <input
                                type="range"
                                min="0"
                                max={MAX_GAME_PRICE_FILTER_UNITS}
                                step="1"
                                value={externalOnly ? 0 : advancedDraft.maxPriceUnits}
                                disabled={externalOnly}
                                onChange={(event) => updateAdvancedDraft((current) => ({ ...current, maxPriceUnits: Number(event.target.value) }))}
                            />
                            <div className="advanced-range-scale"><span>Free</span><span>{externalOnly ? 'Free only' : 'Any'}</span></div>
                        </div>
                    </div>
                </section>

                {advancedSearchMessage && <div className="advanced-search-status" role="status">{advancedSearchMessage}</div>}
                <div className="advanced-drawer-footer">
                    <button type="button" className="advanced-reset" disabled={advancedSearching} onClick={() => { const reset = defaultAdvancedCloudFilters(); setAdvancedDraft(reset); setAdvancedSearchMessage(null); }}>Reset all</button>
                    <button type="button" className="primary advanced-search-submit" disabled={advancedSearching} onClick={() => void runAdvancedSearch()}>{advancedSearching ? 'Searching…' : 'Search'}</button>
                </div>
            </div>
        );
    } else if (active.kind === 'info') {
        content = (
            <div className="about-modal-content">
                <div className="about-heading">
                    <h3>VaporStow</h3>
                    <span>v1.0.2</span>
                </div>
                <div className="about-contributors">
                    {ABOUT_CONTRIBUTORS.map((contributor) => (
                        <article className="about-contributor" key={contributor.username}>
                            <img
                                className="about-avatar"
                                src={contributor.avatarUrl}
                                alt={`${contributor.name} GitHub avatar`}
                                draggable={false}
                                loading="eager"
                                decoding="sync"
                                fetchPriority="high"
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
        const protection = active.entry.protection;
        const protectedCloudCount = protection?.memberGameIds.length ?? 0;
        content = (
            <>
                <h3>Delete {active.entry.name}</h3>
                <p className="modal-copy warning-copy">
                    {protection
                        ? `This protected ${isFolder ? 'folder' : 'file'} will be removed from all ${protectedCloudCount} Clouds.`
                        : isFolder
                            ? 'Are you sure you want to delete this folder and every file inside it?'
                            : 'Are you sure you want to delete this file?'}
                </p>
                <div className="modal-actions">
                    <button onClick={requestClose}>Cancel</button>
                    <button
                        className="danger"
                        disabled={working}
                        onClick={() => {
                            if (protection) void confirmProtectedDelete(active.game, active.entry);
                            else void run(() => window.vaporApi.deleteEntry(active.game.id, active.entry.path), active.game, parent, true);
                        }}
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

    if (active.kind === 'advanced-search') {
        return (
            <div className={`advanced-drawer-layer ${closing ? 'closing' : ''}`} onMouseDown={requestClose}>
                <aside
                    className={`advanced-search-drawer ${closing ? 'closing' : ''}`}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Advanced Cloud search"
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    {content}
                </aside>
            </div>
        );
    }

    return (
        <div className={`modal-backdrop ${closing ? 'closing' : ''}`} onMouseDown={requestClose}>
            <div className={`modal ${active.kind === 'import' ? 'import-modal-shell' : ''} ${closing ? 'closing' : ''}`} onMouseDown={(event) => event.stopPropagation()}>{content}</div>
        </div>
    );
}



function gameArtworkPriority(value: string): number {
    const lower = value.toLowerCase();
    if (lower.includes('library_600x900_2x')) return 0;
    if (lower.includes('library_600x900')) return 1;
    if (lower.includes('library_capsule')) return 2;
    if (lower.includes('hero_capsule')) return 3;
    if (lower.includes('capsule_616x353')) return 4;
    if (lower.includes('capsule_467x181')) return 5;
    if (lower.includes('header')) return 6;
    if (lower.includes('capsule_231x87')) return 7;
    return 20;
}

function gameArtworkCandidates(game: GameStatus): string[] {
    const base = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.appId}`;
    const fallback = [
        `${base}/library_600x900_2x.jpg`,
        `${base}/library_600x900.jpg`,
        `${base}/capsule_616x353.jpg`,
        `${base}/header.jpg`,
        `${base}/capsule_231x87.jpg`,
        `https://cdn.akamai.steamstatic.com/steam/apps/${game.appId}/header.jpg`,
        `https://cdn.akamai.steamstatic.com/steam/apps/${game.appId}/capsule_231x87.jpg`
    ];
    const discovered = Array.isArray(game.artworkUrls) ? game.artworkUrls : [];
    return [...new Set([...discovered, ...fallback])]
        .filter((url) => /^https?:\/\//i.test(url))
        .sort((left, right) => gameArtworkPriority(left) - gameArtworkPriority(right));
}

type SteamArtworkImageProps = {
    game: GameStatus;
    className?: string;
    onNaturalSize?: (width: number, height: number) => void;
};

function SteamArtworkImage({ game, className, onNaturalSize }: SteamArtworkImageProps) {
    const candidateKey = `${game.appId}\n${(Array.isArray(game.artworkUrls) ? game.artworkUrls : []).join('\n')}`;
    const candidates = useMemo(() => gameArtworkCandidates(game), [candidateKey]);
    const [index, setIndex] = useState(0);
    const [loadedSource, setLoadedSource] = useState<string | null>(null);

    useEffect(() => setIndex(0), [candidateKey]);

    const source = candidates[index];
    if (!source) return null;
    const loaded = loadedSource === source;
    return (
        <img
            key={`${game.appId}-${index}-${source}`}
            className={`steam-artwork-image ${loaded ? 'artwork-loaded' : 'artwork-pending'}${className ? ` ${className}` : ''}`}
            src={source}
            alt=""
            loading="eager"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth > 0 && naturalHeight > 0) {
                    setLoadedSource(source);
                    onNaturalSize?.(naturalWidth, naturalHeight);
                }
            }}
            onError={() => {
                setLoadedSource(null);
                setIndex((current) => Math.min(current + 1, candidates.length));
            }}
        />
    );
}

async function preloadGameArtwork(game: GameStatus, budgetMs = 650): Promise<void> {
    const started = Date.now();
    for (const source of gameArtworkCandidates(game).slice(0, 5)) {
        const remaining = budgetMs - (Date.now() - started);
        if (remaining <= 0) return;
        const loaded = await new Promise<boolean>((resolve) => {
            const image = new Image();
            let settled = false;
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve(value);
            };
            const timer = window.setTimeout(() => finish(false), Math.min(260, remaining));
            image.onload = () => finish(true);
            image.onerror = () => finish(false);
            image.referrerPolicy = 'no-referrer';
            image.src = source;
        });
        if (loaded) return;
    }
}

function GameArtwork({ game }: { game: GameStatus }) {
    return (
        <div className="cloud-card-art" aria-hidden="true">
            <span className="cloud-card-art-loader"><span /></span>
            <SteamArtworkImage game={game} />
        </div>
    );
}

type CloudCarouselProps = {
    games: GameStatus[];
    actionFor: (game: GameStatus) => string;
    onAction: (game: GameStatus) => void;
    isFavorite: (id: GameId) => boolean;
    onToggleFavorite: (id: GameId) => void;
    isHidden: (id: GameId) => boolean;
    onToggleHidden: (id: GameId) => void;
    steamRunning: boolean;
    operationGame?: GameStatus | null;
    operationPhase?: Phase;
    operationDetail?: string | null;
    operationProgress?: CloudTransferProgress | null;
};

function CloudCarousel({
    games,
    actionFor,
    onAction,
    isFavorite,
    onToggleFavorite,
    isHidden,
    onToggleHidden,
    steamRunning,
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
    const geometryRef = useRef({ cardWidth: 300, cardHeight: 375, artSize: 128, slot: 334 });
    const suppressClickRef = useRef(false);
    const [dragging, setDragging] = useState(false);
    const [animating, setAnimating] = useState(false);
    const [position, setPosition] = useState(0);
    const [geometry, setGeometry] = useState({ cardWidth: 300, cardHeight: 375, artSize: 128, slot: 334 });
    const [returningGameId, setReturningGameId] = useState<GameId | null>(null);
    const previousOperationGameIdRef = useRef<GameId | null>(operationGame?.id ?? null);
    const carouselInitializedRef = useRef(false);
    const previousGameIdsRef = useRef<GameId[]>(games.map((game) => game.id));
    const gameOrderKey = useMemo(() => games.map((game) => game.id).join('|'), [games]);

    const measure = useCallback(() => {
        const rail = railRef.current;
        if (!rail) return;
        const width = Math.max(280, rail.clientWidth);
        const height = Math.max(180, rail.clientHeight);

        const cardAspect = 0.80; // Ratio largeur/hauteur.
        const availableHeight = Math.max(150, height - 16);
        const preferredHeight = 425;
        const cardHeight = Math.round(Math.min(preferredHeight, availableHeight));
        const cardWidth = Math.round(cardHeight * cardAspect);
        const compactness = Math.max(0, Math.min(1, (360 - cardHeight) / 150));
        const artSize = Math.round(Math.max(82, Math.min(184, cardHeight * (0.43 - compactness * 0.05))));
        const gap = Math.round(Math.max(18, Math.min(42, cardWidth * 0.10)));
        const detailScale = Math.max(0, Math.min(1, (cardHeight - 220) / 205));
        const titleSize = 14 + detailScale * 5;
        const metaSize = 10.5 + detailScale * 1.8;
        const actionSize = 11 + detailScale * 2;
        const actionHeight = 34 + detailScale * 12;
        const cardPadding = 11 + detailScale * 9;
        const cardBottomPadding = Math.max(7, cardPadding * 0.55);
        const cardGap = 6 + detailScale * 6;
        const artTopOffset = 11 + detailScale * 11;
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
        rail.style.setProperty('--carousel-title-size', `${titleSize.toFixed(2)}px`);
        rail.style.setProperty('--carousel-meta-size', `${metaSize.toFixed(2)}px`);
        rail.style.setProperty('--carousel-action-size', `${actionSize.toFixed(2)}px`);
        rail.style.setProperty('--carousel-action-height', `${actionHeight.toFixed(2)}px`);
        rail.style.setProperty('--carousel-card-padding', `${cardPadding.toFixed(2)}px`);
        rail.style.setProperty('--carousel-card-bottom-padding', `${cardBottomPadding.toFixed(2)}px`);
        rail.style.setProperty('--carousel-card-gap', `${cardGap.toFixed(2)}px`);
        rail.style.setProperty('--carousel-art-top-offset', `${artTopOffset.toFixed(2)}px`);

        const controls = document.querySelector<HTMLElement>('.home-cloud-controls');
        if (controls && window.innerHeight > 620) {
            const controlsBottom = controls.getBoundingClientRect().bottom;
            const safeGap = Math.max(16, Math.min(28, window.innerHeight * 0.024));
            const halfCard = cardHeight / 2;
            const desiredCenter = window.innerHeight / 2;
            const minimumCenter = controlsBottom + safeGap + halfCard;
            const maximumCenter = window.innerHeight - safeGap - halfCard;
            const constrainedCenter = Math.min(maximumCenter, Math.max(desiredCenter, minimumCenter));
            rail.style.setProperty('--home-carousel-center-y', `${Math.round(constrainedCenter)}px`);
        } else {
            rail.style.removeProperty('--home-carousel-center-y');
        }
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

            const stiffness = 64;
            const damping = 14.5;
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

    useLayoutEffect(() => {
        if (!operationGame) return;
        const index = games.findIndex((game) => game.id === operationGame.id);
        if (index < 0) return;

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
        const previousIds = previousGameIdsRef.current;
        const previousCount = previousIds.length;
        const previousIndex = previousCount > 0
            ? ((Math.round(positionRef.current) % previousCount) + previousCount) % previousCount
            : 0;
        const previousFocusedId = previousIds[previousIndex] ?? null;

        measure();
        if (!carouselInitializedRef.current) {
            carouselInitializedRef.current = true;
            commitPosition(0);
            targetRef.current = 0;
        } else if (previousFocusedId) {
            const nextIndex = games.findIndex((game) => game.id === previousFocusedId);
            if (nextIndex >= 0) {
                const preserved = visualTargetForGame(nextIndex, positionRef.current);
                commitPosition(preserved);
                targetRef.current = preserved;
            }
        }
        previousGameIdsRef.current = games.map((game) => game.id);

        const rail = railRef.current;
        if (!rail) return;
        const observer = new ResizeObserver(measure);
        observer.observe(rail);
        window.addEventListener('resize', measure);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [gameOrderKey, games, commitPosition, measure, visualTargetForGame]);

    useEffect(() => () => stopAnimation(), [stopAnimation]);

    const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (operationGame || returningGameId || event.button !== 0 || !railRef.current) return;
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, [data-no-carousel-drag="true"]')) return;

        stopAnimation();
        const now = performance.now();
        const card = target.closest<HTMLElement>('[data-game-index]');
        const clickedGameIndex = card ? Number(card.dataset.gameIndex) : null;
        const explicitTarget = card ? Number(card.dataset.carouselTarget) : Number.NaN;
        const clickedTarget = Number.isFinite(explicitTarget)
            ? explicitTarget
            : clickedGameIndex !== null && Number.isFinite(clickedGameIndex)
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
            const projected = positionRef.current + Math.max(-8, Math.min(8, drag.velocity)) * 0.16;
            const target = Math.round(projected);
            animateTo(target, drag.velocity * 0.32);
        } else if (drag.clickedTarget !== null) {
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
            className={`cloud-carousel ${dragging ? 'dragging' : ''} ${animating ? 'animating' : ''} ${operationMode ? 'operation-mode' : ''} ${returningMode ? 'operation-returning' : ''}`}
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
            {(() => {
                if (count === 0) return null;

                const renderCenter = Math.round(position);
                const renderRadius = operationMode || returningMode
                    ? 0
                    : count <= 3
                        ? 1
                        : 2;
                const targets = Array.from(
                    { length: renderRadius * 2 + 1 },
                    (_, offset) => renderCenter + offset - renderRadius
                );

                return targets.map((carouselTarget) => {
                    const gameIndex = ((carouselTarget % count) + count) % count;
                    const game = games[gameIndex];
                    const relative = carouselTarget - position;
                    const distance = Math.abs(relative);
                    const centerWeight = Math.max(0, 1 - Math.min(distance, 1));
                    const sideWeight = Math.max(0, 1 - Math.abs(distance - 1));
                    const opacity = Math.max(0.08, Math.min(1, 0.08 + centerWeight * 0.92 + sideWeight * 0.70));
                    const scale = 0.80 + centerWeight * 0.20 + sideWeight * 0.08;
                    const brightness = 0.58 + centerWeight * 0.42 + sideWeight * 0.24;
                    const saturation = 0.62 + centerWeight * 0.38 + sideWeight * 0.22;
                    const x = relative * geometry.slot;
                    const focused = distance < 0.5;
                    const actionLabel = actionFor(game);
                    const steamActionBlocked = focused && !steamRunning && (actionLabel === 'Open' || actionLabel === 'Add to library' || actionLabel === 'Install' || actionLabel === 'Repair');
                    const actionDisabled = (focused && actionLabel === 'Unavailable') || game.installing || steamActionBlocked;
                    const actionDisabledReason = steamActionBlocked ? 'Steam is not running' : actionLabel === 'Repair' ? 'Repair this protected Cloud' : undefined;
                    const current = game.rememberedBytes ?? 0;
                    const currentFiles = game.rememberedFiles ?? 0;

                    return (
                        <article
                            className={`cloud-card ${focused ? 'focused' : ''} ${game.protectedCorrupt ? 'protected-corrupt' : ''} ${operationMode && operationGame?.id === game.id ? 'cloud-loading-card' : ''} ${returningMode && returningGameId === game.id ? 'cloud-returning-card' : ''}`}
                            key={`${game.id}:${carouselTarget}`}
                            data-game-index={gameIndex}
                            data-carousel-target={carouselTarget}
                            style={{
                                '--card-x': `${x}px`,
                                '--card-opacity': (operationMode ? (operationGame?.id === game.id ? 1 : 0) : opacity).toFixed(3),
                                '--card-scale': (operationMode && operationGame?.id === game.id ? 1 : scale).toFixed(4),
                                '--card-saturation': (operationMode && operationGame?.id === game.id ? 1 : saturation).toFixed(3),
                                '--card-brightness': (operationMode && operationGame?.id === game.id ? 1 : brightness).toFixed(3),
                                '--intro-delay': `${relative < -0.5 && relative > -1.5 ? 0 : relative > 0.5 && relative < 1.5 ? 120 : distance < 0.5 ? 260 : 360}ms`,
                                zIndex: Math.max(1, 100 - Math.round(distance * 20))
                            } as CSSProperties}
                            onClick={() => {
                                if (suppressClickRef.current || dragging) return;
                                if (!focused) animateTo(carouselTarget);
                            }}
                        >
                            <button
                                type="button"
                                className={`cloud-card-favorite ${isFavorite(game.id) ? 'active' : ''}`}
                                aria-label={isFavorite(game.id) ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`}
                                data-no-carousel-drag="true"
                                disabled={operationMode || game.protectedCorrupt}
                                title={game.protectedCorrupt ? 'Unavailable until protected storage is repaired' : (isFavorite(game.id) ? 'Remove from favorites' : 'Add to favorites')}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (game.protectedCorrupt) return;
                                    onToggleFavorite(game.id);
                                }}
                            >
                                <FavoriteIcon active={isFavorite(game.id)} />
                            </button>
                            <button
                                type="button"
                                className={`cloud-card-visibility ${isHidden(game.id) ? 'active' : ''}`}
                                aria-label={isHidden(game.id) ? `Show ${game.name}` : `Hide ${game.name}`}
                                title={game.protectedCorrupt ? 'Unavailable until protected storage is repaired' : (isHidden(game.id) ? 'Show Cloud' : 'Hide Cloud')}
                                data-no-carousel-drag="true"
                                disabled={operationMode || game.protectedCorrupt}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (game.protectedCorrupt) return;
                                    onToggleHidden(game.id);
                                }}
                            >
                                <VisibilityIcon hidden={isHidden(game.id)} />
                            </button>
                            {game.hasProtectedFiles && (
                                <span
                                    className="cloud-card-protected-indicator"
                                    title="Contains Mirror / Reed–Solomon files"
                                    aria-label="Contains Mirror or Reed–Solomon files"
                                    data-no-carousel-drag="true"
                                >
                                    <ShieldIcon />
                                </span>
                            )}
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
                                <div className="cloud-card-persistent-details">
                                    <div className="cloud-card-title compact-title">
                                        <strong title={game.name}>{compactGameName(game.name)}</strong>
                                    </div>
                                    <div className="cloud-card-summary">
                                        <span>{appInstallSizeSummary(game)}</span>
                                    </div>
                                </div>

                                <div className="cloud-card-normal-content">
                                    <div className="cloud-card-usage">
                                        <span>{formatBytes(current)} / {quotaLabel(game.quotaBytes)}</span>
                                        <span>{currentFiles.toLocaleString()} / {game.maxFiles.toLocaleString()} files</span>
                                    </div>
                                    <div
                                        className={`cloud-card-action-wrap ${steamActionBlocked ? 'steam-offline' : ''}`}
                                        title={actionDisabledReason}
                                    >
                                        <button
                                            disabled={actionDisabled}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                if (actionDisabled) return;
                                                if (!focused) {
                                                    animateTo(carouselTarget);
                                                    return;
                                                }
                                                onAction(game);
                                            }}
                                        >
                                            {focused ? actionLabel : 'Select'}
                                        </button>
                                    </div>
                                </div>

                                <div className="cloud-card-loading-content" aria-live="polite">
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
                });
            })()}

        </div>
    );
}

export default function App() {
    const [status, setStatus] = useState<AppStatus | null>(null);
    const [modal, setModal] = useState<ModalState>(null);
    const [loading, setLoading] = useState(true);
    const [introReady, setIntroReady] = useState(false);
    const [introStage, setIntroStage] = useState<'show' | 'exit' | 'done'>('show');
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
    const [homeFilter, setHomeFilter] = useState<HomeCloudFilter>('all');
    const [homeQuery, setHomeQuery] = useState('');
    const [homeSearchExpanded, setHomeSearchExpanded] = useState(false);
    const [advancedFilters, setAdvancedFilters] = useState<AdvancedCloudFilters>(() => defaultAdvancedCloudFilters());
    const [advancedSearchRunning, setAdvancedSearchRunning] = useState(false);
    const [favoriteGameIds, setFavoriteGameIds] = useState<Set<GameId>>(() => {
        try {
            const stored = JSON.parse(window.localStorage.getItem(FAVORITE_CLOUDS_STORAGE_KEY) || '[]');
            return new Set(Array.isArray(stored) ? stored.filter((value): value is GameId => typeof value === 'string') : []);
        } catch {
            return new Set<GameId>();
        }
    });
    const [hiddenGameIds, setHiddenGameIds] = useState<Set<GameId>>(() => {
        try {
            const stored = JSON.parse(window.localStorage.getItem(HIDDEN_CLOUDS_STORAGE_KEY) || '[]');
            return new Set(Array.isArray(stored) ? stored.filter((value): value is GameId => typeof value === 'string') : []);
        } catch {
            return new Set<GameId>();
        }
    });
    const homeSearchInputRef = useRef<HTMLInputElement | null>(null);
    const lastActivityAt = useRef(Date.now());
    const automaticSessionActionRunning = useRef(false);
    const externalGameCloseHandling = useRef(false);
    const externalGameCloseMisses = useRef(0);
    const sessionCloudLogMarkerRef = useRef<number | null>(null);
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

    useEffect(() => {
        try {
            window.localStorage.setItem(FAVORITE_CLOUDS_STORAGE_KEY, JSON.stringify([...favoriteGameIds]));
        } catch {
        }
    }, [favoriteGameIds]);

    useEffect(() => {
        try {
            window.localStorage.setItem(HIDDEN_CLOUDS_STORAGE_KEY, JSON.stringify([...hiddenGameIds]));
        } catch {
        }
    }, [hiddenGameIds]);

    const toggleFavorite = useCallback((id: GameId) => {
        if (statusRef.current?.games.find((game) => game.id === id)?.protectedCorrupt) return;
        setFavoriteGameIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleHidden = useCallback((id: GameId) => {
        if (statusRef.current?.games.find((game) => game.id === id)?.protectedCorrupt) return;
        setHiddenGameIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
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


    const beginImport = useCallback(async (game: GameStatus, directory: string, droppedPaths?: string[]): Promise<void> => {
        try {
            const files = droppedPaths
                ? await window.vaporApi.describeImportPaths(droppedPaths)
                : (await window.vaporApi.selectImportFiles(game.id)).files;
            if (!files.length) return;
            setModal({ kind: 'import', game, directory: normalizeRelative(directory), files });
        } catch (error) {
            setModal({
                kind: 'message',
                title: 'Unable to import files',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => setIntroReady(true), 1250);
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
        const finishIntro = window.setTimeout(() => setIntroStage('done'), 680);
        return () => window.clearTimeout(finishIntro);
    }, [introStage]);

    useEffect(() => {
        if (introStage !== 'done') return;
        void window.vaporApi.startCatalogBackground().catch(() => undefined);
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


    useEffect(() => {
        return window.vaporApi.onFilesDropped((paths) => {
            if (modal || phaseRef.current !== 'open') return;
            const id = activeGameIdRef.current;
            const currentStatus = statusRef.current;
            if (!id || !currentStatus) return;
            const game = currentStatus.games.find((candidate) => candidate.id === id);
            if (!game) return;
            void beginImport(game, listing.directory, paths);
        });
    }, [beginImport, listing.directory, modal]);

    const filteredHomeGames = useMemo(() => {
        const query = homeQuery.trim().toLocaleLowerCase();
        const detected = [...(status?.games ?? [])]
            .sort(compareHomeGames);

        return detected.filter((game) => {
            if (game.quotaBytes <= 0 || game.maxFiles <= 0) return false;
            const hidden = hiddenGameIds.has(game.id) || game.protectedCorrupt;
            if (homeFilter === 'hidden') {
                if (!hidden) return false;
            } else if (hidden) {
                return false;
            }
            if (homeFilter === 'advanced' && !matchesAdvancedFilters(game, advancedFilters)) return false;
            if (homeFilter === 'favorites' && !favoriteGameIds.has(game.id)) return false;
            if (homeFilter === 'installed' && !game.installed) return false;
            if (homeFilter === 'not-installed' && game.installed) return false;
            if (homeFilter === 'protected' && !game.hasProtectedFiles) return false;
            if (!query) return true;

            const haystack = [game.name, game.volumeName, game.appId, game.cloudPattern]
                .join(' ')
                .toLocaleLowerCase();
            return haystack.includes(query);
        });
    }, [status, homeFilter, homeQuery, favoriteGameIds, hiddenGameIds, advancedFilters]);

    const activeAdvancedFilterCount = useMemo(() => advancedFilterCount(advancedFilters), [advancedFilters]);

    const homeCarouselGames = useMemo(() => {
        if (!activeGame || phase === 'open' || filteredHomeGames.some((game) => game.id === activeGame.id)) {
            return filteredHomeGames;
        }
        return [...filteredHomeGames, activeGame];
    }, [filteredHomeGames, activeGame, phase]);

    const homeEmptyMessage = useMemo(() => {
        if (homeQuery.trim()) return `No Steam Clouds match “${homeQuery.trim()}”.`;
        if (homeFilter === 'favorites') return 'No favorite Steam Clouds yet.';
        if (homeFilter === 'installed') return 'No installed Steam Clouds detected.';
        if (homeFilter === 'not-installed') return 'Every detected Steam Cloud is installed.';
        if (homeFilter === 'protected') return 'No Clouds currently store Mirror or Reed–Solomon files.';
        if (homeFilter === 'hidden') return 'No hidden Steam Clouds.';
        if (homeFilter === 'advanced') return 'No results match your filters.';
        return 'No Steam Clouds detected.';
    }, [homeFilter, homeQuery]);

    async function waitForRunning(
        id: GameId,
        expected: boolean,
        cloudMarker?: number,
        direction: 'up' | 'down' | 'auto' = 'auto'
    ): Promise<GameStatus> {
        const started = Date.now();
        let nextLaunchRetry = started + 15_000;
        let launchRetryDelay = 15_000;
        let stableRunningSince: number | null = null;
        const stableRunningMs = 2_500;

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

            const cloudReady = cloudMarker === undefined || !expected || progress?.state === 'complete';
            const now = Date.now();
            if (game.running === expected && cloudReady) {
                if (!expected) return game;
                if (stableRunningSince === null) stableRunningSince = now;
                if (now - stableRunningSince >= stableRunningMs) return game;
            } else if (expected) {
                stableRunningSince = null;
            }

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

    async function waitForProbeState(
        id: GameId,
        expected: boolean,
        timeoutMs = 120_000,
        stableMs = expected ? 2_500 : 0
    ): Promise<GameStatus | null> {
        const started = Date.now();
        let matchingSince: number | null = null;
        while (Date.now() - started < timeoutMs) {
            const next = await window.vaporApi.getStatus();
            setStatus(next);
            const game = next.games.find((item) => item.id === id);
            if (!game) return null;
            if (game.running === expected) {
                if (stableMs <= 0) return game;
                if (matchingSince === null) matchingSince = Date.now();
                if (Date.now() - matchingSince >= stableMs) return game;
            } else {
                matchingSince = null;
            }
            await sleep(500);
        }
        return null;
    }

    async function probeProtectedMember(game: GameStatus): Promise<boolean> {
        const latest = await window.vaporApi.getStatus();
        setStatus(latest);
        const current = latest.games.find((item) => item.id === game.id) || game;
        if (!current.platformSupported || current.installing || !current.installed || !current.cloudRoot) {
            await window.vaporApi.markProtectedGameInaccessible(game.id);
            return false;
        }
        if (current.running) {
            await window.vaporApi.markProtectedGameAccessible(game.id);
            return true;
        }

        let launched = false;
        try {
            setOperationDetail(`Checking ${game.name}…`);
            await window.vaporApi.startBackgroundGuard(game.id);
            await window.vaporApi.runGame(game.id);
            const running = await waitForProbeState(game.id, true);
            if (!running) {
                await window.vaporApi.stopBackgroundGuard(game.id).catch(() => false);
                await window.vaporApi.markProtectedGameInaccessible(game.id);
                return false;
            }
            launched = true;
            await window.vaporApi.markProtectedGameAccessible(game.id);
        } catch {
            await window.vaporApi.stopBackgroundGuard(game.id).catch(() => false);
            await window.vaporApi.markProtectedGameInaccessible(game.id).catch(() => 0);
            return false;
        }

        try {
            await window.vaporApi.restoreSplitFiles(game.id);
            await window.vaporApi.prepareSync(game.id);
            const stopped = await window.vaporApi.requestStop(game.id);
            launched = false;
            await waitForProbeState(game.id, false, 120_000);
            await window.vaporApi.waitForCloudSync(game.id, stopped.cloudLogMarker).catch(() => undefined);
            return true;
        } catch (error) {
            if (launched) await window.vaporApi.requestStop(game.id).catch(() => undefined);
            throw error;
        }
    }

    async function syncProtectedMember(
        pool: ProtectedPoolSummary,
        game: GameStatus,
        ordinal: number,
        total: number,
        alreadyOpen: boolean
    ): Promise<void> {
        let indexStaged = false;
        let runningSession = alreadyOpen;
        const globalProgress = (localPercent: number | null, message: string, base?: CloudTransferProgress): CloudTransferProgress => {
            const normalizedLocal = localPercent === null ? 0 : Math.max(0, Math.min(100, localPercent));
            const percent = Math.max(0, Math.min(100, ((ordinal - 1) + normalizedLocal / 100) / total * 100));
            return {
                state: base?.state ?? 'evaluating',
                direction: base?.direction ?? 'unknown',
                percent,
                transferredBytes: base?.transferredBytes ?? 0,
                totalBytes: base?.totalBytes ?? null,
                completedFiles: base?.completedFiles ?? 0,
                totalFiles: base?.totalFiles ?? null,
                receivedParts: base?.receivedParts,
                completedParts: base?.completedParts,
                totalParts: base?.totalParts,
                currentFileIndex: base?.currentFileIndex,
                currentFileReceivedParts: base?.currentFileReceivedParts,
                currentFileCompletedParts: base?.currentFileCompletedParts,
                currentFileTotalParts: base?.currentFileTotalParts,
                cachedPartsUsed: base?.cachedPartsUsed,
                idleSeconds: base?.idleSeconds,
                speedBytesPerSecond: base?.speedBytesPerSecond ?? null,
                etaSeconds: base?.etaSeconds ?? null,
                currentFile: base?.currentFile ?? null,
                message,
                logPath: base?.logPath ?? null
            };
        };

        try {
            if (!alreadyOpen) {
                setOperationDetail(`${game.name} · ${ordinal}/${total} · Restoring Steam Cloud…`);
                setTransferProgress(globalProgress(0, `Opening ${game.name}…`));
                const pullLog = await window.vaporApi.resetCloudLog();
                await window.vaporApi.startBackgroundGuard(game.id);
                const beforeLaunch = await window.vaporApi.getStatus();
                setStatus(beforeLaunch);
                const current = beforeLaunch.games.find((candidate) => candidate.id === game.id) || game;
                if (!current.running) {
                    await window.vaporApi.runGame(game.id);
                    runningSession = true;
                    await waitForRunning(game.id, true, pullLog.marker, 'down');
                } else {
                    runningSession = true;
                }
                setOperationDetail(`${game.name} · ${ordinal}/${total} · Preparing local Cloud…`);
                await window.vaporApi.restoreSplitFiles(game.id);
            }

            setOperationDetail(`${game.name} · ${ordinal}/${total} · Writing protected data…`);
            setTransferProgress(globalProgress(16, `Writing ${game.name}…`));
            await window.vaporApi.deployProtectedPool(pool.id, game.id);

            const logicalUsage = await window.vaporApi.getAuditUsage(game.id);
            try {
                await window.vaporApi.stageCloudIndex(game.id);
                indexStaged = true;
            } catch {
                indexStaged = false;
            }

            setOperationDetail(`${game.name} · ${ordinal}/${total} · Preparing Steam Cloud…`);
            setTransferProgress(globalProgress(28, `Preparing ${game.name}…`));
            await window.vaporApi.prepareSync(game.id);
            await window.vaporApi.resetCloudLog();

            setOperationDetail(`${game.name} · ${ordinal}/${total} · Closing app…`);
            const stopped = await window.vaporApi.requestStop(game.id);
            runningSession = false;
            await waitForRunning(game.id, false, stopped.cloudLogMarker, 'up');

            setOperationDetail(`${game.name} · ${ordinal}/${total} · Uploading to Steam Cloud…`);
            let syncFinished = false;
            const syncPromise = window.vaporApi.waitForCloudSync(game.id, stopped.cloudLogMarker)
                .finally(() => { syncFinished = true; });

            while (!syncFinished) {
                const progress = await window.vaporApi.getCloudProgress(game.id, stopped.cloudLogMarker, 'up').catch(() => null);
                if (progress) {
                    const message = `${game.name} · ${ordinal}/${total} · ${progress.message}`;
                    setTransferProgress(globalProgress(progress.percent, message, progress));
                    setOperationDetail(message);
                }
                if (!syncFinished) await sleep(450);
            }

            const syncResult = await syncPromise;
            if (syncResult.state !== 'complete') throw new Error(`${game.name}: ${syncResult.message}`);
            await window.vaporApi.pruneEmptyDirectories(game.id).catch(() => ({ removed: 0 }));
            await window.vaporApi.rememberUsage(game.id, logicalUsage.bytes, logicalUsage.files);
            if (indexStaged) await window.vaporApi.commitCloudIndex(game.id).catch(() => 0);
            setTransferProgress(globalProgress(100, `${game.name} synchronized.`));
        } catch (error) {
            if (indexStaged) await window.vaporApi.discardCloudIndex(game.id).catch(() => false);
            if (runningSession) await window.vaporApi.requestStop(game.id).catch(() => undefined);
            throw error;
        }
    }

    async function syncProtectedDeletionMember(
        deletions: PendingProtectedDeletion[],
        game: GameStatus,
        ordinal: number,
        total: number,
        alreadyOpen: boolean
    ): Promise<void> {
        let indexStaged = false;
        let runningSession = alreadyOpen;
        const applicable = deletions.filter((item) => item.memberGameIds.includes(game.id));
        if (applicable.length === 0) return;

        const globalProgress = (localPercent: number | null, message: string, base?: CloudTransferProgress): CloudTransferProgress => {
            const normalizedLocal = localPercent === null ? 0 : Math.max(0, Math.min(100, localPercent));
            const percent = Math.max(0, Math.min(100, ((ordinal - 1) + normalizedLocal / 100) / total * 100));
            return {
                state: base?.state ?? 'evaluating',
                direction: base?.direction ?? 'unknown',
                percent,
                transferredBytes: base?.transferredBytes ?? 0,
                totalBytes: base?.totalBytes ?? null,
                completedFiles: base?.completedFiles ?? 0,
                totalFiles: base?.totalFiles ?? null,
                receivedParts: base?.receivedParts,
                completedParts: base?.completedParts,
                totalParts: base?.totalParts,
                currentFileIndex: base?.currentFileIndex,
                currentFileReceivedParts: base?.currentFileReceivedParts,
                currentFileCompletedParts: base?.currentFileCompletedParts,
                currentFileTotalParts: base?.currentFileTotalParts,
                cachedPartsUsed: base?.cachedPartsUsed,
                idleSeconds: base?.idleSeconds,
                speedBytesPerSecond: base?.speedBytesPerSecond ?? null,
                etaSeconds: base?.etaSeconds ?? null,
                currentFile: base?.currentFile ?? null,
                message,
                logPath: base?.logPath ?? null
            };
        };

        try {
            if (!alreadyOpen) {
                setOperationDetail(`${game.name} · ${ordinal}/${total} · Restoring Steam Cloud…`);
                setTransferProgress(globalProgress(0, `Opening ${game.name}…`));
                const pullLog = await window.vaporApi.resetCloudLog();
                await window.vaporApi.startBackgroundGuard(game.id);
                const beforeLaunch = await window.vaporApi.getStatus();
                setStatus(beforeLaunch);
                const current = beforeLaunch.games.find((candidate) => candidate.id === game.id) || game;
                if (!current.running) {
                    await window.vaporApi.runGame(game.id);
                    runningSession = true;
                    await waitForRunning(game.id, true, pullLog.marker, 'down');
                } else {
                    runningSession = true;
                }
                setOperationDetail(`${game.name} · ${ordinal}/${total} · Preparing local Cloud…`);
                await window.vaporApi.restoreSplitFiles(game.id);
            }

            setOperationDetail(`${game.name} · ${ordinal}/${total} · Applying queued deletions…`);
            setTransferProgress(globalProgress(16, `Updating ${game.name}…`));
            for (const deletion of applicable) {
                await window.vaporApi.deleteProtectedEntry(deletion.poolId, game.id, deletion.logicalPath);
            }

            const logicalUsage = await window.vaporApi.getAuditUsage(game.id);
            try {
                await window.vaporApi.stageCloudIndex(game.id);
                indexStaged = true;
            } catch {
                indexStaged = false;
            }

            setOperationDetail(`${game.name} · ${ordinal}/${total} · Preparing Steam Cloud…`);
            setTransferProgress(globalProgress(28, `Preparing ${game.name}…`));
            await window.vaporApi.prepareSync(game.id);
            await window.vaporApi.resetCloudLog();

            setOperationDetail(`${game.name} · ${ordinal}/${total} · Closing app…`);
            const stopped = await window.vaporApi.requestStop(game.id);
            runningSession = false;
            await waitForRunning(game.id, false, stopped.cloudLogMarker, 'up');

            setOperationDetail(`${game.name} · ${ordinal}/${total} · Updating Steam Cloud…`);
            let syncFinished = false;
            const syncPromise = window.vaporApi.waitForCloudSync(game.id, stopped.cloudLogMarker)
                .finally(() => { syncFinished = true; });

            while (!syncFinished) {
                const progress = await window.vaporApi.getCloudProgress(game.id, stopped.cloudLogMarker, 'up').catch(() => null);
                if (progress) {
                    const message = `${game.name} · ${ordinal}/${total} · ${progress.message}`;
                    setTransferProgress(globalProgress(progress.percent, message, progress));
                    setOperationDetail(message);
                }
                if (!syncFinished) await sleep(450);
            }

            const syncResult = await syncPromise;
            if (syncResult.state !== 'complete') throw new Error(`${game.name}: ${syncResult.message}`);
            await window.vaporApi.pruneEmptyDirectories(game.id).catch(() => ({ removed: 0 }));
            await window.vaporApi.rememberUsage(game.id, logicalUsage.bytes, logicalUsage.files);
            if (indexStaged) await window.vaporApi.commitCloudIndex(game.id).catch(() => 0);
            setTransferProgress(globalProgress(100, `${game.name} synchronized.`));
        } catch (error) {
            if (indexStaged) await window.vaporApi.discardCloudIndex(game.id).catch(() => false);
            if (runningSession) await window.vaporApi.requestStop(game.id).catch(() => undefined);
            throw error;
        }
    }

    async function syncPendingProtectedDeletions(
        origin: GameStatus,
        deletions: PendingProtectedDeletion[],
        options: { originAlreadyOpen?: boolean } = {}
    ): Promise<boolean> {
        if (deletions.length === 0) return false;
        const uniqueDeletions = [...new Map(deletions.map((item) => [`${item.poolId}:${normalizeRelative(item.logicalPath)}`, item])).values()];
        const affectedPoolIds = [...new Set(uniqueDeletions.map((item) => item.poolId))];
        let operationStarted = false;

        try {
            const latest = await window.vaporApi.getStatus();
            setStatus(latest);
            if (!latest.steamRunning) throw new Error('Steam is not running.');

            const orderedMemberIds = [
                origin.id,
                ...[...new Set(uniqueDeletions.flatMap((item) => item.memberGameIds))].filter((id) => id !== origin.id)
            ];
            const memberGames = orderedMemberIds.map((id) => {
                const game = latest.games.find((candidate) => candidate.id === id);
                if (!game) throw new Error('A protected Cloud is no longer available.');
                if (!game.platformSupported) throw new Error(`${game.name} is not supported on this platform.`);
                if (!game.installed) throw new Error(`${game.name} must be installed before protected changes can be synchronized.`);
                if (!game.cloudRoot) throw new Error(`${game.name} must be opened and synchronized once before protected changes can be synchronized.`);
                if (game.id !== origin.id && game.running) throw new Error(`Close ${game.name} before synchronizing protected changes.`);
                return game;
            });

            setModal(null);
            operationStarted = true;
            setSelected(null);
            setSyncNotice(null);
            setSessionDirty(false);
            setPhase('saving');
            setOperationDetail('Preparing protected changes…');
            setTransferProgress({
                state: 'evaluating',
                direction: 'unknown',
                percent: 0,
                transferredBytes: 0,
                totalBytes: null,
                completedFiles: 0,
                totalFiles: uniqueDeletions.length,
                speedBytesPerSecond: null,
                etaSeconds: null,
                currentFile: null,
                message: 'Synchronizing queued protected changes…',
                logPath: null
            });

            for (let index = 0; index < memberGames.length; index += 1) {
                await syncProtectedDeletionMember(
                    uniqueDeletions,
                    memberGames[index],
                    index + 1,
                    memberGames.length,
                    index === 0 && options.originAlreadyOpen !== false
                );
            }

            for (const deletion of uniqueDeletions) {
                await window.vaporApi.finalizeProtectedDelete(deletion.poolId, deletion.logicalPath);
            }
            setOperationDetail('Protected changes synchronized.');
            setTransferProgress((current) => current ? { ...current, state: 'complete', percent: 100, message: 'Protected changes synchronized.' } : current);
            setPhase('saved');
            await sleep(900);
            closeCloudSession();
            await refresh();
            return true;
        } catch (error) {
            if (operationStarted) {
                for (const poolId of affectedPoolIds) {
                    await window.vaporApi.markProtectedPoolDegraded(poolId).catch(() => false);
                }
                closeCloudSession();
                await refresh().catch(() => undefined);
            }
            setModal({
                kind: 'message',
                title: 'Protected synchronization interrupted',
                body: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    }

    async function confirmProtectedDelete(origin: GameStatus, entry: AuditEntry): Promise<void> {
        const protection = entry.protection;
        if (!protection) return;
        try {
            await window.vaporApi.stageProtectedDelete(protection.poolId, entry.path);
            setModal(null);
            setSelected(null);
            setSessionDirty(true);
            setSyncNotice(null);
            await refresh();
            await reloadDirectory(origin.id, parentDirectory(entry.path));
        } catch (error) {
            setModal({
                kind: 'message',
                title: 'Unable to queue deletion',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async function confirmProtectedImport(
        mode: 'mirror' | 'reed-solomon',
        origin: GameStatus,
        memberIds: GameId[],
        directory: string,
        files: ImportSelection[]
    ): Promise<void> {
        let pool: ProtectedPoolSummary | null = null;
        try {
            const orderedMemberIds = [origin.id, ...memberIds.filter((id) => id !== origin.id)];
            setSelected(null);
            setSyncNotice(null);
            setSessionDirty(false);
            setPhase('saving');
            setOperationDetail(mode === 'mirror' ? 'Preparing mirrored files…' : 'Generating Reed–Solomon shards…');
            setTransferProgress({
                state: 'evaluating',
                direction: 'unknown',
                percent: 0,
                transferredBytes: 0,
                totalBytes: files.reduce((sum, file) => sum + file.size, 0),
                completedFiles: 0,
                totalFiles: files.length,
                speedBytesPerSecond: null,
                etaSeconds: null,
                currentFile: null,
                message: mode === 'mirror' ? 'Preparing Mirror pool…' : 'Preparing Reed–Solomon pool…',
                logPath: null
            });

            pool = await window.vaporApi.createProtectedPool(mode, origin.id, orderedMemberIds, directory, files);
            const latest = await window.vaporApi.getStatus();
            setStatus(latest);
            const memberGames = orderedMemberIds.map((id) => {
                const game = latest.games.find((candidate) => candidate.id === id);
                if (!game) throw new Error('A selected Cloud is no longer available.');
                return game;
            });

            for (let index = 0; index < memberGames.length; index += 1) {
                await syncProtectedMember(pool, memberGames[index], index + 1, memberGames.length, index === 0);
            }

            await window.vaporApi.finalizeProtectedPool(pool.id);
            setOperationDetail(mode === 'mirror' ? 'Mirror synchronized.' : 'Reed–Solomon pool synchronized.');
            setTransferProgress((current) => current ? { ...current, state: 'complete', percent: 100, message: 'Protected storage synchronized.' } : current);
            setPhase('saved');
            await sleep(950);
            closeCloudSession();
            await refresh();
        } catch (error) {
            if (pool) await window.vaporApi.markProtectedPoolDegraded(pool.id).catch(() => false);
            closeCloudSession();
            await refresh().catch(() => undefined);
            setModal({
                kind: 'message',
                title: 'Protected import interrupted',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async function syncRepairMutation(
        game: GameStatus,
        ordinal: number,
        total: number,
        mutate: () => Promise<unknown>
    ): Promise<void> {
        let runningSession = false;
        const globalPercent = (local: number) => Math.max(0, Math.min(100, ((ordinal - 1) + local / 100) / total * 100));
        try {
            const before = await window.vaporApi.getStatus();
            setStatus(before);
            const current = before.games.find((item) => item.id === game.id) || game;
            if (!current.running) {
                setOperationDetail(`${game.name} · ${ordinal}/${total} · Opening Cloud…`);
                const pull = await window.vaporApi.resetCloudLog();
                await window.vaporApi.startBackgroundGuard(game.id);
                await window.vaporApi.runGame(game.id);
                const launched = await waitForProbeState(game.id, true);
                if (!launched) throw new Error(`${game.name} is no longer launchable through Steam.`);
                runningSession = true;
                await waitForRunning(game.id, true, pull.marker, 'down');
            } else {
                runningSession = true;
            }

            await window.vaporApi.restoreSplitFiles(game.id).catch(() => undefined);
            setTransferProgress({
                state: 'evaluating', direction: 'unknown', percent: globalPercent(35), transferredBytes: 0,
                totalBytes: null, completedFiles: 0, totalFiles: null, speedBytesPerSecond: null,
                etaSeconds: null, currentFile: null, message: `${game.name} · Repairing…`, logPath: null
            });
            await mutate();
            const usage = await window.vaporApi.getAuditUsage(game.id);
            await window.vaporApi.prepareSync(game.id);
            await window.vaporApi.resetCloudLog();
            setOperationDetail(`${game.name} · ${ordinal}/${total} · Synchronizing repair…`);
            const stopped = await window.vaporApi.requestStop(game.id);
            runningSession = false;
            await waitForRunning(game.id, false, stopped.cloudLogMarker, 'up');
            const result = await window.vaporApi.waitForCloudSync(game.id, stopped.cloudLogMarker);
            if (result.state !== 'complete') throw new Error(`${game.name}: ${result.message}`);
            await window.vaporApi.pruneEmptyDirectories(game.id).catch(() => ({ removed: 0 }));
            await window.vaporApi.rememberUsage(game.id, usage.bytes, usage.files);
            await window.vaporApi.rebuildCloudIndex(game.id).catch(() => 0);
            setTransferProgress((currentProgress) => currentProgress ? { ...currentProgress, state: 'complete', percent: globalPercent(100), message: `${game.name} repaired.` } : currentProgress);
        } catch (error) {
            if (runningSession) await window.vaporApi.requestStop(game.id).catch(() => undefined);
            throw error;
        }
    }

    async function confirmProtectedRepair(
        repairModal: Extract<ModalState, { kind: 'repair' }>,
        choice: 'replacement' | 'gather',
        destinationId: GameId
    ): Promise<void> {
        try {
            setSelected(null);
            setSyncNotice(null);
            if (!repairModal.targetWorked) setActiveGameId(destinationId);
            setPhase('saving');
            setOperationDetail('Preparing protected repair…');
            setTransferProgress({
                state: 'rebuilding', direction: 'unknown', percent: 0, transferredBytes: 0,
                totalBytes: repairModal.issue.totalBytes, completedFiles: 0, totalFiles: repairModal.issue.fileCount,
                speedBytesPerSecond: null, etaSeconds: null, currentFile: null,
                message: 'Recovering protected files…', logPath: null
            });

            if (choice === 'replacement') {
                if (repairModal.issue.corruptGameIds.length !== 1) {
                    throw new Error('Replacement can repair one unavailable Cloud at a time.');
                }
                const corruptId = repairModal.issue.corruptGameIds[0];
                const pools = await window.vaporApi.prepareProtectedReplacement(repairModal.game.id, corruptId, destinationId);
                const latest = await window.vaporApi.getStatus();
                setStatus(latest);
                for (const pool of pools) {
                    const orderedIds = [...pool.memberGameIds].sort((left, right) => {
                        if (left === repairModal.game.id) return 1;
                        if (right === repairModal.game.id) return -1;
                        return 0;
                    });
                    for (let index = 0; index < orderedIds.length; index += 1) {
                        const member = latest.games.find((candidate) => candidate.id === orderedIds[index]);
                        if (!member) throw new Error('A repair Cloud is no longer available.');
                        const currentStatus = await window.vaporApi.getStatus();
                        const current = currentStatus.games.find((candidate) => candidate.id === member.id) || member;
                        await syncProtectedMember(pool, current, index + 1, orderedIds.length, current.running);
                    }
                    await window.vaporApi.finalizeProtectedPool(pool.id);
                }
            } else {
                const plan = await window.vaporApi.prepareProtectedGather(repairModal.game.id, destinationId);
                const latest = await window.vaporApi.getStatus();
                setStatus(latest);
                const corrupt = new Set(repairModal.issue.corruptGameIds);
                const operationIds = [...new Set([...plan.sourceGameIds.filter((id) => !corrupt.has(id)), destinationId])]
                    .sort((left, right) => {
                        if (left === repairModal.game.id) return 1;
                        if (right === repairModal.game.id) return -1;
                        return 0;
                    });
                for (let index = 0; index < operationIds.length; index += 1) {
                    const id = operationIds[index];
                    const member = latest.games.find((candidate) => candidate.id === id);
                    if (!member) throw new Error('A repair Cloud is no longer available.');
                    await syncRepairMutation(member, index + 1, operationIds.length, async () => {
                        if (plan.sourceGameIds.includes(id)) await window.vaporApi.cleanupProtectedGather(plan.id, id);
                        if (id === destinationId) await window.vaporApi.applyProtectedGather(plan.id, id);
                    });
                }
                await window.vaporApi.finalizeProtectedGather(plan.id);
            }

            setTransferProgress((current) => current ? { ...current, state: 'complete', percent: 100, message: 'Repair complete.' } : current);
            setOperationDetail('Repair complete.');
            await sleep(650);
            closeCloudSession();
            const refreshed = await refresh();
            if (repairModal.targetWorked) {
                const targetGame = refreshed.games.find((item) => item.id === repairModal.game.id) || repairModal.game;
                await confirmOpen(targetGame, repairModal.target, { skipProtectedProbe: true });
            }
        } catch (error) {
            closeCloudSession();
            await refresh().catch(() => undefined);
            setModal({
                kind: 'message',
                title: 'Repair interrupted',
                body: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async function confirmOpen(game: GameStatus, target?: CloudSearchEntry, options: { skipProtectedProbe?: boolean } = {}) {
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

            let openingStatus = await window.vaporApi.getStatus();
            setStatus(openingStatus);
            if (!openingStatus.steamInstalled) throw new Error('Steam is not installed.');

            setTransferProgress(null);
            if (!openingStatus.steamRunning) {
                throw new Error('Steam is not running. Start Steam before opening a Cloud.');
            }

            const protectedMemberIds = options.skipProtectedProbe ? [] : await window.vaporApi.getProtectedRepairMembers(game.id).catch(() => [] as GameId[]);
            if (protectedMemberIds.length > 0) {
                const otherMembers = protectedMemberIds.filter((id) => id !== game.id);
                for (let index = 0; index < otherMembers.length; index += 1) {
                    const memberId = otherMembers[index];
                    const member = openingStatus.games.find((item) => item.id === memberId);
                    if (!member) {
                        await window.vaporApi.markProtectedGameInaccessible(memberId).catch(() => 0);
                        continue;
                    }
                    setOperationDetail(`Checking protected Cloud ${index + 1}/${otherMembers.length} · ${member.name}…`);
                    await probeProtectedMember(member);
                    openingStatus = await window.vaporApi.getStatus();
                    setStatus(openingStatus);
                }
            }

            setOperationDetail('Preparing Steam Cloud session…');
            const pullLog = await window.vaporApi.resetCloudLog();

            setOperationDetail('Starting the game and restoring Steam Cloud…');
            await window.vaporApi.startBackgroundGuard(game.id);
            backgroundSessionStarted = true;
            const currentGame = openingStatus.games.find((item) => item.id === game.id) || game;
            let synced = currentGame;
            if (!currentGame.running) {
                await window.vaporApi.runGame(game.id);
                const launched = await waitForProbeState(game.id, true);
                if (!launched) {
                    await window.vaporApi.stopBackgroundGuard(game.id).catch(() => false);
                    backgroundSessionStarted = false;
                    if (protectedMemberIds.includes(game.id)) {
                        await window.vaporApi.markProtectedGameInaccessible(game.id).catch(() => 0);
                        const issue = await window.vaporApi.getProtectedRepairIssue(game.id).catch(() => null);
                        setOperationDetail(null);
                        setTransferProgress(null);
                        setPhase('closed');
                        setActiveGameId(null);
                        const repairedStatus = await refresh().catch(() => openingStatus);
                        if (issue) {
                            const repairGame = repairedStatus.games.find((item) => item.id === game.id) || game;
                            setModal({ kind: 'repair', game: repairGame, issue, targetWorked: false, target });
                        } else {
                            setModal({ kind: 'message', title: 'Unable to open cloud', body: 'Steam could not launch this protected Cloud.' });
                        }
                        return;
                    }
                    throw new Error(`Steam could not successfully launch ${game.name}.`);
                }
                if (protectedMemberIds.includes(game.id)) {
                    await window.vaporApi.markProtectedGameAccessible(game.id).catch(() => 0);
                }
                synced = await waitForRunning(game.id, true, pullLog.marker, 'down');
                const finalPull = await window.vaporApi.getCloudProgress(game.id, pullLog.marker, 'down').catch(() => null);
                if (finalPull) setTransferProgress(finalPull);

                await sleep(500);
            } else if (protectedMemberIds.includes(game.id)) {
                await window.vaporApi.markProtectedGameAccessible(game.id).catch(() => 0);
            }

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
            // A previously unavailable Cloud may still contain shards from a
            // protected pool that was dissolved with “Gather in one place”.
            // Retired Pool IDs make this cleanup safe and repeatable.
            const retiredCleanup = await window.vaporApi.cleanupRetiredProtectedPools(game.id).catch(() => ({ removed: 0 }));
            const restoredStatus = await window.vaporApi.getStatus();
            setStatus(restoredStatus);
            const restoredGame = restoredStatus.games.find((item) => item.id === game.id) || synced;
            await window.vaporApi.rememberUsage(game.id, restoredGame.auditBytes, restoredGame.auditFiles);
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
            const pendingProtectedDeletions = await window.vaporApi.getPendingProtectedDeletions(game.id).catch(() => []);
            setSessionDirty(pendingProtectedDeletions.length > 0 || retiredCleanup.removed > 0);

            // Do not expose the Cloud explorer if the app only appeared
            // briefly and then exited/crashed during Cloud preparation.
            setOperationDetail('Confirming the game is still running…');
            const stillRunning = await waitForProbeState(game.id, true, 6_000, 1_500);
            if (!stillRunning) {
                if (protectedMemberIds.includes(game.id)) {
                    await window.vaporApi.markProtectedGameInaccessible(game.id).catch(() => 0);
                }
                throw new Error(`${game.name} stopped before the Cloud could be opened.`);
            }

            await sleep(180);
            sessionCloudLogMarkerRef.current = await window.vaporApi.getCloudLogMarker().catch(() => null);
            externalGameCloseMisses.current = 0;
            setOperationDetail(null);
            setTransferProgress(null);
            setPhase('open');
            if (protectedMemberIds.length > 0) {
                const issue = await window.vaporApi.getProtectedRepairIssue(game.id).catch(() => null);
                if (issue) {
                    const latestRepairStatus = await window.vaporApi.getStatus().catch(() => restoredStatus);
                    setStatus(latestRepairStatus);
                    const repairGame = latestRepairStatus.games.find((item) => item.id === game.id) || restoredGame;
                    setModal({ kind: 'repair', game: repairGame, issue, targetWorked: true, target });
                }
            }
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
        sessionCloudLogMarkerRef.current = null;
        externalGameCloseMisses.current = 0;
        setActiveGameId(null);
        setSyncNotice(null);
        setOperationDetail(null);
        setTransferProgress(null);
        setSessionDirty(false);
        setSelected(null);
        setSearchOpen(false);
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

            const logicalUsage = await window.vaporApi.getAuditUsage(game.id);

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
            await window.vaporApi.rememberUsage(game.id, logicalUsage.bytes, logicalUsage.files);

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
        options: { skipEmptyFoldersWarning?: boolean; externallyClosed?: boolean } = {}
    ): Promise<boolean> {
        if (!options.skipEmptyFoldersWarning) {
            const summary = await window.vaporApi.getCloudContentSummary(game.id).catch(() => null);
            if (summary?.onlyEmptyDirectories) {
                setModal({ kind: 'empty-folders-sync', game });
                return false;
            }
        }

        const pendingProtectedDeletions = await window.vaporApi.getPendingProtectedDeletions(game.id).catch(() => []);
        if (pendingProtectedDeletions.length > 0) {
            return syncPendingProtectedDeletions(game, pendingProtectedDeletions, {
                originAlreadyOpen: !options.externallyClosed
            });
        }

        let stopStarted = false;
        let indexStaged = false;

        try {
            setSelected(null);
            setSyncNotice(null);
            setOperationDetail('Preparing files…');
            setTransferProgress(null);
            setPhase('saving');

            const logicalUsage = await window.vaporApi.getAuditUsage(game.id);

            try {
                await window.vaporApi.stageCloudIndex(game.id);
                indexStaged = true;
            } catch {
                indexStaged = false;
            }

            const waitForUpload = async (marker: number) => {
                let syncFinished = false;
                const syncPromise = window.vaporApi.waitForCloudSync(game.id, marker)
                    .finally(() => { syncFinished = true; });

                while (!syncFinished) {
                    const progress = await window.vaporApi.getCloudProgress(game.id, marker, 'up').catch(() => null);
                    if (progress) {
                        setTransferProgress(progress);
                        setOperationDetail(progress.message);
                    }
                    if (!syncFinished) await sleep(500);
                }

                const result = await syncPromise;
                const finalProgress = await window.vaporApi.getCloudProgress(game.id, marker, 'up').catch(() => null);
                if (finalProgress) {
                    setTransferProgress(finalProgress.state === 'complete' ? { ...finalProgress, percent: 100 } : finalProgress);
                    setOperationDetail(finalProgress.state === 'complete' ? 'Steam Cloud synchronized.' : finalProgress.message);
                }
                return result;
            };

            let syncResult: Awaited<ReturnType<typeof window.vaporApi.waitForCloudSync>> | null = null;

            if (options.externallyClosed) {
                // The game has already exited outside VaporStow. Stop the window guard,
                // convert the logical workspace back to its Steam-safe representation,
                // then follow the post-exit Steam Cloud upload instead of leaving the
                // explorer open against a Cloud that is no longer controllable.
                await window.vaporApi.stopBackgroundGuard(game.id).catch(() => false);
                setOperationDetail('Game closed. Preparing files for Steam Cloud…');
                const preparation = await window.vaporApi.prepareSyncOffline(game.id);
                if (preparation.splitFiles > 0 && preparation.reusedParts > 0) {
                    setOperationDetail(
                        `Chunks ready · ${preparation.reusedParts} unchanged reused · ${preparation.rewrittenParts} changed`
                    );
                    await sleep(220);
                }

                const externalMarker = sessionCloudLogMarkerRef.current
                    ?? await window.vaporApi.getCloudLogMarker().catch(() => 0);
                setOperationDetail('Game closed. Waiting for Steam Cloud…');
                syncResult = await waitForUpload(externalMarker);

                // Carrier storage and split-file representation can be prepared only
                // after the unexpected exit was noticed. Run one hidden verification
                // cycle so Steam is guaranteed to see the final prepared representation.
                const needsVerificationCycle = game.storageMode === 'carrier' || preparation.splitFiles > 0;
                if (needsVerificationCycle || syncResult.state !== 'complete') {
                    setOperationDetail('Finalizing automatic synchronization…');
                    const pullLog = await window.vaporApi.resetCloudLog();
                    await window.vaporApi.startBackgroundGuard(game.id);
                    await window.vaporApi.runGame(game.id);
                    const relaunched = await waitForProbeState(game.id, true, 120_000, 2_500);
                    if (!relaunched) throw new Error(`${game.name} could not be reopened to finish automatic synchronization.`);
                    await waitForRunning(game.id, true, pullLog.marker, 'down');
                    await window.vaporApi.prepareSync(game.id);
                    await window.vaporApi.resetCloudLog();
                    stopStarted = true;
                    const stopped = await window.vaporApi.requestStop(game.id);
                    await waitForRunning(game.id, false, stopped.cloudLogMarker, 'up');
                    setOperationDetail('Waiting for Steam Cloud…');
                    syncResult = await waitForUpload(stopped.cloudLogMarker);
                }
            } else {
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

                setOperationDetail('Preparing Steam Cloud upload…');
                await window.vaporApi.resetCloudLog();

                stopStarted = true;
                const stopped = await window.vaporApi.requestStop(game.id);
                await waitForRunning(game.id, false, stopped.cloudLogMarker, 'up');
                setOperationDetail('Waiting for Steam Cloud…');
                syncResult = await waitForUpload(stopped.cloudLogMarker);
            }

            if (!syncResult || syncResult.state !== 'complete') {
                if (indexStaged) await window.vaporApi.discardCloudIndex(game.id).catch(() => false);
                closeCloudSession();
                await refresh();
                setModal({
                    kind: 'message',
                    title: syncResult?.state === 'failed' ? 'Steam Cloud sync failed' : 'Steam Cloud status unknown',
                    body: syncResult?.message || 'Steam Cloud synchronization did not complete.'
                });
                return false;
            }

            await window.vaporApi.pruneEmptyDirectories(game.id);

            const afterSync = await window.vaporApi.getStatus();
            setStatus(afterSync);
            await window.vaporApi.rememberUsage(game.id, logicalUsage.bytes, logicalUsage.files);
            if (indexStaged) await window.vaporApi.commitCloudIndex(game.id).catch(() => 0);

            await window.vaporApi.resetCloudLog();

            setOperationDetail('Steam Cloud synchronized.');
            setPhase('saved');
            await sleep(syncResult.reason === 'no-changes' ? 850 : 1100);

            closeCloudSession();
            await refresh();
            return true;
        } catch (error) {
            if (indexStaged) await window.vaporApi.discardCloudIndex(game.id).catch(() => false);

            if (options.externallyClosed) {
                await window.vaporApi.stopBackgroundGuard(game.id).catch(() => false);
                closeCloudSession();
                await refresh().catch(() => undefined);
            } else if (!stopStarted) {
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
        let probeBusy = false;
        const timer = window.setInterval(() => {
            const id = activeGameIdRef.current;
            if (!id || phaseRef.current !== 'open') {
                externalGameCloseMisses.current = 0;
                return;
            }
            if (probeBusy || externalGameCloseHandling.current || automaticSessionActionRunning.current || windowCloseHandling.current) return;

            probeBusy = true;
            void window.vaporApi.isGameRunning(id)
                .then((running) => {
                    if (id !== activeGameIdRef.current || phaseRef.current !== 'open') {
                        externalGameCloseMisses.current = 0;
                        return;
                    }
                    if (running) {
                        externalGameCloseMisses.current = 0;
                        return;
                    }

                    externalGameCloseMisses.current += 1;
                    if (externalGameCloseMisses.current < 3) return;
                    externalGameCloseMisses.current = 0;

                    const currentStatus = statusRef.current;
                    const game = currentStatus?.games.find((candidate) => candidate.id === id);
                    if (!game || externalGameCloseHandling.current) return;

                    externalGameCloseHandling.current = true;
                    automaticSessionActionRunning.current = true;
                    setModal(null);
                    setSearchOpen(false);
                    setSelected(null);
                    setOperationDetail('Game closed. Starting automatic synchronization…');
                    setPhase('saving');

                    void synchronize(game, {
                        skipEmptyFoldersWarning: true,
                        externallyClosed: true
                    }).finally(() => {
                        externalGameCloseHandling.current = false;
                        automaticSessionActionRunning.current = false;
                        externalGameCloseMisses.current = 0;
                        lastActivityAt.current = Date.now();
                    });
                })
                .catch(() => {
                    // A failed process probe must never close an otherwise valid session.
                    externalGameCloseMisses.current = 0;
                })
                .finally(() => {
                    probeBusy = false;
                });
        }, 650);

        return () => window.clearInterval(timer);
    }, []);

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

    const stageKey = activeGameId && phase === 'open' ? activeGameId : 'volumes';
    const showIntroOverlay = introStage !== 'done';
    const introShellClass = introStage === 'show'
        ? 'intro-pending'
        : introStage === 'exit'
            ? 'intro-revealing'
            : 'intro-ready';
    const appReady = !loading && Boolean(status);

    return (
        <>
            {showIntroOverlay && (
                <div className={`startup-splash startup-overlay ${introStage === 'exit' ? 'exiting' : ''}`} aria-label="Application is starting">
                    <div className="startup-wordmark">VaporStow</div>
                    <div className="startup-loader" aria-label="Loading local Steam Clouds"><span /></div>
                </div>
            )}

            {appReady && status && (
            <main className={`shell ${activeGameId ? 'focused' : ''} ${activeGameId && phase === 'open' ? 'cloud-open-shell' : ''} ${status.platform === 'linux' ? 'linux-shell' : ''} ${introShellClass}`}>
                {status.platform === 'linux' && (
                    <div className="linux-window-controls" data-no-carousel-drag="true">
                        <button
                            className={`steam window-steam ${!status.steamInstalled ? 'missing' : status.steamRunning ? 'ok' : 'idle'}`}
                            title={!status.steamInstalled ? 'Steam is not installed' : status.steamRunning ? 'Steam is running' : 'Steam is installed but not running'}
                            onClick={() => !status.steamInstalled && void window.vaporApi.openSteamDownload()}
                        >
                            Steam <i />
                        </button>
                        <button
                            className="info"
                            title={modal?.kind === 'advanced-search'
                                ? 'Unavailable while Advanced Search is open'
                                : phase === 'opening' || phase === 'closing'
                                    ? 'Unavailable while Cloud is opening or closing'
                                    : 'Information'}
                            aria-label="Information"
                            disabled={modal?.kind === 'advanced-search' || phase === 'opening' || phase === 'closing'}
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
                    {status.platform !== 'linux' && (
                        <button
                            className={`steam ${!status.steamInstalled ? 'missing' : status.steamRunning ? 'ok' : 'idle'}`}
                            title={!status.steamInstalled ? 'Steam is not installed' : status.steamRunning ? 'Steam is running' : 'Steam is installed but not running'}
                            onClick={() => !status.steamInstalled && void window.vaporApi.openSteamDownload()}
                        >
                            Steam <i />
                        </button>
                    )}
                </header>

                <div className="stage" key={stageKey}>
                    {!status.steamInstalled && !activeGameId && (
                        <button className="steam-required" onClick={() => void window.vaporApi.openSteamDownload()}>
                            Steam is required
                        </button>
                    )}

                    {(!activeGameId || (activeGame && phase !== 'open')) ? (
                        <section className={`home-clouds ${activeGame && phase !== 'open' ? 'cloud-operation-active' : ''}`}>
                            <div className={`home-cloud-controls ${activeGame && phase !== 'open' ? 'operation-hidden' : ''}`}>
                                <div className="home-cloud-controls-row">
                                    <div className="home-cloud-filters" role="group" aria-label="Filter Steam Clouds">
                                        {([
                                            ['all', 'All'],
                                            ['favorites', 'Favorites'],
                                            ['installed', 'Installed'],
                                            ['not-installed', 'Not installed']
                                        ] as Array<[HomeCloudFilter, string]>).map(([value, label]) => (
                                            <button
                                                key={value}
                                                type="button"
                                                className={homeFilter === value && modal?.kind !== 'advanced-search' ? 'active' : ''}
                                                aria-pressed={homeFilter === value && modal?.kind !== 'advanced-search'}
                                                disabled={Boolean(activeGame && phase !== 'open')}
                                                onClick={() => {
                                                    setHomeFilter(value);
                                                    if (modal?.kind === 'advanced-search') setModal(null);
                                                }}
                                            >
                                                <span>{label}</span>
                                            </button>
                                        ))}
                                    </div>

                                    <button
                                        type="button"
                                        className={`home-special-filter ${homeFilter === 'protected' ? 'active' : ''}`}
                                        title="Protected Clouds"
                                        aria-label="Show Clouds used by Mirror or Reed–Solomon"
                                        aria-pressed={homeFilter === 'protected'}
                                        disabled={Boolean(activeGame && phase !== 'open')}
                                        onClick={() => {
                                            setHomeFilter('protected');
                                            if (modal?.kind === 'advanced-search') setModal(null);
                                        }}
                                    >
                                        <ShieldIcon size={15} />
                                    </button>

                                    <button
                                        type="button"
                                        className={`home-special-filter ${homeFilter === 'hidden' ? 'active' : ''}`}
                                        title="Hidden Clouds"
                                        aria-label="Show hidden Clouds"
                                        aria-pressed={homeFilter === 'hidden'}
                                        disabled={Boolean(activeGame && phase !== 'open')}
                                        onClick={() => {
                                            setHomeFilter('hidden');
                                            if (modal?.kind === 'advanced-search') setModal(null);
                                        }}
                                    >
                                        <VisibilityIcon hidden size={15} />
                                    </button>

                                    <button
                                        type="button"
                                        className={`home-advanced-filter ${modal?.kind === 'advanced-search' ? 'drawer-open' : ''} ${homeFilter === 'advanced' ? 'active' : ''}`}
                                        title="Advanced Cloud search"
                                        aria-label="Advanced Cloud search"
                                        aria-pressed={homeFilter === 'advanced' || modal?.kind === 'advanced-search'}
                                        aria-expanded={modal?.kind === 'advanced-search'}
                                        disabled={Boolean(activeGame && phase !== 'open')}
                                        onClick={() => {
                                            setHomeQuery('');
                                            setHomeSearchExpanded(false);
                                            setModal({ kind: 'advanced-search' });
                                        }}
                                    >
                                        <SlidersIcon size={15} />
                                        {activeAdvancedFilterCount > 0 && <span>{activeAdvancedFilterCount}</span>}
                                    </button>

                                    <div className={`home-cloud-search ${homeSearchExpanded ? 'expanded' : ''}`}>
                                        <button
                                            type="button"
                                            className="home-cloud-search-toggle"
                                            title="Search Clouds"
                                            aria-label="Search Clouds"
                                            aria-expanded={homeSearchExpanded}
                                            disabled={Boolean(activeGame && phase !== 'open')}
                                            onClick={() => {
                                                setHomeSearchExpanded(true);
                                                window.requestAnimationFrame(() => {
                                                    homeSearchInputRef.current?.focus();
                                                    homeSearchInputRef.current?.select();
                                                });
                                            }}
                                        >
                                            <SearchIcon size={14} />
                                        </button>
                                        <input
                                            ref={homeSearchInputRef}
                                            value={homeQuery}
                                            disabled={Boolean(activeGame && phase !== 'open')}
                                            tabIndex={homeSearchExpanded ? 0 : -1}
                                            placeholder="Search cloud..."
                                            aria-label="Search detected Steam Clouds"
                                            onChange={(event) => setHomeQuery(event.target.value)}
                                            onBlur={() => {
                                                if (!homeQuery.trim()) setHomeSearchExpanded(false);
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Escape') {
                                                    setHomeQuery('');
                                                    setHomeSearchExpanded(false);
                                                    event.currentTarget.blur();
                                                }
                                            }}
                                        />
                                    </div>
                                </div>
                            </div>

                            {advancedSearchRunning ? (
                                <div className="home-advanced-search-loading" role="status" aria-label="Searching Steam Clouds">
                                    <div className="home-advanced-search-orbit" aria-hidden="true"><span /></div>
                                </div>
                            ) : homeCarouselGames.length > 0 ? (
                                <CloudCarousel
                                    games={homeCarouselGames}
                                    actionFor={(game) => game.protectedCorrupt
                                        ? 'Repair'
                                        : !game.platformSupported
                                            ? 'Store'
                                            : game.installing
                                            ? 'Installing…'
                                            : !game.installed && !game.inLibrary
                                                ? 'Add to library'
                                                : !game.installed
                                                    ? 'Install'
                                                    : !game.cloudRoot
                                                        ? 'Unavailable'
                                                        : 'Open'}
                                    onAction={(game) => {
                                        if (game.protectedCorrupt) {
                                            void window.vaporApi.getProtectedRepairIssue(game.id).then((issue) => {
                                                if (issue) setModal({ kind: 'repair', game, issue, targetWorked: false });
                                                else setModal({ kind: 'message', title: 'Repair unavailable', body: 'No degraded Mirror or Reed–Solomon pool was found for this Cloud.' });
                                            });
                                        } else if (!game.platformSupported) void window.vaporApi.openStore(game.id);
                                        else if (!game.installed && !game.inLibrary) void window.vaporApi.installGame(game.id);
                                        else if (!game.installed) setModal({ kind: 'install', game });
                                        else setModal({ kind: 'open', game });
                                    }}
                                    isFavorite={(id) => favoriteGameIds.has(id)}
                                    onToggleFavorite={toggleFavorite}
                                    isHidden={(id) => hiddenGameIds.has(id) || Boolean(status?.games.find((game) => game.id === id)?.protectedCorrupt)}
                                    onToggleHidden={toggleHidden}
                                    steamRunning={status.steamRunning}
                                    operationGame={activeGame && phase !== 'open' ? activeGame : null}
                                    operationPhase={phase}
                                    operationDetail={operationDetail}
                                    operationProgress={transferProgress}
                                />
                            ) : (
                                <div className="home-cloud-empty" role="status">
                                    {homeFilter === 'favorites' ? <FavoriteIcon active size={22} /> : homeFilter === 'hidden' ? <VisibilityIcon hidden size={22} /> : homeFilter === 'protected' ? <ShieldIcon size={22} /> : <SearchIcon size={22} />}
                                    {homeEmptyMessage && <strong>{homeEmptyMessage}</strong>}
                                </div>
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
                                beginImport={beginImport}
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
            )}

            {searchOpen && !activeGameId && status && (
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
                advancedFilters={advancedFilters}
                setAdvancedFilters={setAdvancedFilters}
                activateAdvancedFilter={() => {
                    setHomeFilter('advanced');
                    setHomeQuery('');
                    setHomeSearchExpanded(false);
                }}
                resetAdvancedSearch={() => {
                    setHomeQuery('');
                    setHomeSearchExpanded(false);
                }}
                setAdvancedSearchRunning={setAdvancedSearchRunning}
                applyStatus={setStatus}
                steamRunning={status?.steamRunning ?? false}
                games={status?.games ?? []}
                confirmProtectedImport={confirmProtectedImport}
                confirmProtectedDelete={confirmProtectedDelete}
                confirmProtectedRepair={confirmProtectedRepair}
            />
        </>
    );
}
