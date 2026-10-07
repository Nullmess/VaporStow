import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { GameDefinition } from '../games';
import {
    appInfoRecordsFromAppInfoFile,
    discoverSteamCloudGamesFromJsonAppInfo,
    parseTextAppInfoRecords
} from './steamCloudDiscovery';


export type ExternalCatalogSearchCriteria = {
    minQuotaBytes?: number;
    minFiles?: number;
    maxAppSizeBytes?: number | null;
    targetResults?: number;
    excludeAppIds?: string[];
};

type CatalogApp = {
    appId: string;
    name?: string;
    type?: 'game' | 'application' | string;
    isFreeApp: true;
    storePriceCents: 0;
    storePriceLabel?: string;
    installSizeBytes?: number;
    artworkUrls?: string[];
    appInfo: Record<string, unknown>;
};

type CatalogDocument = {
    version: 1;
    generatedAt: string;
    apps: CatalogApp[];
};

type CandidateStatus = 'queued' | 'unresolved' | 'no-cloud' | 'cloud' | 'not-free';

type StoreCandidate = {
    appId: string;
    cloudListed: boolean;
    seenAt: number;
    status: CandidateStatus;
    appInfoCheckedAt: number;
    freeCheckedAt: number;
    attempts: number;
    retryAfter: number;
};

type LiveSearchState = {
    version: 4;
    cloudPage: number;
    genericPage: number;
    cloudTotal: number;
    genericTotal: number;
    sourceTurn: number;
    lastStoreRequestAt: number;
    lastSearchAt: number;
    candidates: Record<string, StoreCandidate>;
};

type StoreSearchPayload = {
    total_count?: number;
    results_html?: string;
};

export type ExternalCatalogDiscoveryStats = {
    indexedApps: number;
    candidatesSeen: number;
    candidatesChecked: number;
    queuedCandidates: number;
    unresolvedCandidates: number;
    cloudCandidates: number;
    storeCloudTotal: number;
    storeGenericTotal: number;
    lastSearchAt: number;
};

type StoreAppDetailsPayload = Record<string, {
    success?: boolean;
    data?: {
        is_free?: boolean;
        type?: string;
        name?: string;
        header_image?: string;
        capsule_image?: string;
        capsule_imagev5?: string;
    };
}>;

type PublicAppInfoPayload = {
    status?: string;
    data?: Record<string, unknown> | string;
};

const STORE_PAGE_SIZE = 100;
const STORE_REQUEST_DELAY_MS = 1_100;
const STORE_CLOUD_TURNS = 6;
const CANDIDATE_BATCH_SIZE = 32;
const CANDIDATE_PREFETCH_TARGET = 96;
const CANDIDATE_CACHE_LIMIT = 50_000;
const SEARCH_BUDGET_MS = 40_000;
const SEARCH_BATCH_IDLE_DELAY_MS = 180;
const NO_CLOUD_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_FREE_RECHECK_MS = 24 * 60 * 60 * 1000;
const CLOUD_RECHECK_MS = 14 * 24 * 60 * 60 * 1000;
const UNRESOLVED_BASE_RETRY_MS = 10 * 60 * 1000;
const UNRESOLVED_MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const APPDETAILS_DELAY_MS = 175;
const PUBLIC_APPINFO_CONCURRENCY = 8;
const PUBLIC_APPINFO_TIMEOUT_MS = 4_500;
const STEAMCMD_REQUEST_TIMEOUT_MS = 8_500;
const STEAMCMD_PRINT_TIMEOUT_MS = 12_000;

const STEAMCMD_URLS: Partial<Record<NodeJS.Platform, string>> = {
    linux: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
    win32: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
    darwin: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz'
};

let seedGames: GameDefinition[] = [];
let liveGames: GameDefinition[] = [];
let loadedCacheDir: string | null = null;
let foregroundPromise: Promise<GameDefinition[]> | null = null;
let discoveryStats: ExternalCatalogDiscoveryStats = {
    indexedApps: 0,
    candidatesSeen: 0,
    candidatesChecked: 0,
    queuedCandidates: 0,
    unresolvedCandidates: 0,
    cloudCandidates: 0,
    storeCloudTotal: 0,
    storeGenericTotal: 0,
    lastSearchAt: 0
};

function indexFile(cacheDir: string): string {
    return path.join(cacheDir, 'cloud-catalog.json');
}

function liveIndexFile(cacheDir: string): string {
    return path.join(cacheDir, 'cloud-catalog.live.json');
}

function liveStateFile(cacheDir: string): string {
    return path.join(cacheDir, 'cloud-search-state.json');
}

function managedSteamCmdExecutable(toolDir: string): string {
    if (process.platform === 'win32') return path.join(toolDir, 'steamcmd.exe');
    return path.join(toolDir, 'steamcmd.sh');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function fileExists(file: string): Promise<boolean> {
    try {
        return (await fsp.stat(file)).isFile();
    } catch {
        return false;
    }
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

async function writeJson(file: string, value: unknown): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
    await fsp.rename(tmp, file);
}

function validCatalog(value: unknown): value is CatalogDocument {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.apps)) return false;
    return record.apps.every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const app = entry as Record<string, unknown>;
        return /^\d+$/.test(String(app.appId ?? ''))
            && app.isFreeApp === true
            && Number(app.storePriceCents) === 0
            && Boolean(app.appInfo && typeof app.appInfo === 'object' && !Array.isArray(app.appInfo));
    });
}

function definitionsFromCatalog(document: CatalogDocument, steamRoot: string): GameDefinition[] {
    const output = new Map<string, GameDefinition>();

    for (const app of document.apps) {
        if (!app.isFreeApp || app.storePriceCents !== 0) continue;
        const payload = { data: { [app.appId]: app.appInfo } };
        const [definition] = discoverSteamCloudGamesFromJsonAppInfo(
            payload,
            steamRoot,
            new Set([app.appId]),
            { discoverySource: 'catalog', requireFree: false }
        );
        if (!definition) continue;
        output.set(app.appId, {
            ...definition,
            name: app.name?.trim() || definition.name,
            discoverySource: 'catalog',
            isFreeApp: true,
            storePriceCents: 0,
            storePriceLabel: app.storePriceLabel?.trim() || 'Free',
            artworkUrls: [...new Set([
                ...definition.artworkUrls,
                ...(Array.isArray(app.artworkUrls) ? app.artworkUrls.filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)) : [])
            ])],
            installSizeFallbackBytes: Number.isFinite(app.installSizeBytes) && Number(app.installSizeBytes) > 0
                ? Math.floor(Number(app.installSizeBytes))
                : definition.installSizeFallbackBytes
        });
    }

    return [...output.values()].sort(compareGames);
}

function compareGames(left: GameDefinition, right: GameDefinition): number {
    return right.quotaBytes - left.quotaBytes
        || right.maxFiles - left.maxFiles
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

function mergeGames(...groups: GameDefinition[][]): GameDefinition[] {
    const merged = new Map<string, GameDefinition>();
    for (const group of groups) {
        for (const game of group) {
            if (game.discoverySource !== 'catalog' || game.isFreeApp !== true || game.storePriceCents !== 0) continue;
            merged.set(game.appId, game);
        }
    }
    return [...merged.values()].sort(compareGames);
}

function matchesCriteria(
    game: GameDefinition,
    criteria: ExternalCatalogSearchCriteria,
    excludedAppIds?: ReadonlySet<string>
): boolean {
    if (excludedAppIds?.has(game.appId)) return false;
    if (game.quotaBytes < Math.max(0, criteria.minQuotaBytes ?? 0)) return false;
    if (game.maxFiles < Math.max(0, criteria.minFiles ?? 0)) return false;
    const maxSize = criteria.maxAppSizeBytes;
    if (maxSize !== null && maxSize !== undefined && maxSize > 0
        && game.installSizeFallbackBytes > 0
        && game.installSizeFallbackBytes > maxSize) return false;
    return true;
}

function matchingCount(criteria: ExternalCatalogSearchCriteria): number {
    const excludedAppIds = criteria.excludeAppIds?.length ? new Set(criteria.excludeAppIds) : undefined;
    return currentExternalCatalogGames().filter((game) => matchesCriteria(game, criteria, excludedAppIds)).length;
}

async function loadCachedCatalog(cacheDir: string, steamRoot: string): Promise<GameDefinition[]> {
    if (loadedCacheDir === cacheDir && (seedGames.length > 0 || liveGames.length > 0)) return currentExternalCatalogGames();

    const [cachedSeed, cachedLive] = await Promise.all([
        readJson<unknown>(indexFile(cacheDir)),
        readJson<unknown>(liveIndexFile(cacheDir))
    ]);
    loadedCacheDir = cacheDir;
    seedGames = validCatalog(cachedSeed) ? definitionsFromCatalog(cachedSeed, steamRoot) : [];
    liveGames = validCatalog(cachedLive) ? definitionsFromCatalog(cachedLive, steamRoot) : [];
    return currentExternalCatalogGames();
}

function appIdsFromStoreHtml(html: string): string[] {
    const ids = new Set<string>();

    for (const match of html.matchAll(/data-ds-appid="([^"]+)"/gi)) {
        for (const token of match[1].split(/[^0-9]+/)) {
            if (/^\d+$/.test(token)) ids.add(token);
        }
    }
    for (const match of html.matchAll(/store\.steampowered\.com\/app\/(\d+)(?:\/|[?"'])/gi)) {
        ids.add(match[1]);
    }
    return [...ids];
}

async function fetchStorePage(
    cloudListed: boolean,
    page: number,
    deadline: number
): Promise<{ ids: string[]; total: number; ok: boolean }> {
    if (Date.now() >= deadline - 350) return { ids: [], total: 0, ok: false };
    const url = new URL('https://store.steampowered.com/search/results/');
    url.searchParams.set('query', '');
    url.searchParams.set('start', String(Math.max(0, page) * STORE_PAGE_SIZE));
    url.searchParams.set('count', String(STORE_PAGE_SIZE));
    url.searchParams.set('dynamic_data', '');
    url.searchParams.set('sort_by', 'Name_ASC');
    url.searchParams.set('maxprice', 'free');
    url.searchParams.set('ignore_preferences', '1');
    url.searchParams.set('ndl', '1');
    url.searchParams.set('l', 'english');
    url.searchParams.set('cc', 'us');
    url.searchParams.set('infinite', '1');
    if (cloudListed) url.searchParams.set('category2', '23');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(4_500, Math.max(600, deadline - Date.now())));
    try {
        const response = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
                'User-Agent': 'VaporStow/1.0.2 outside-search',
                'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.8'
            }
        });
        if (!response.ok) return { ids: [], total: 0, ok: false };
        const text = await response.text();
        let html = text;
        let total = 0;
        try {
            const payload = JSON.parse(text) as StoreSearchPayload;
            if (typeof payload.results_html === 'string') html = payload.results_html;
            total = Number(payload.total_count ?? 0) || 0;
        } catch {
        }
        return { ids: appIdsFromStoreHtml(html), total, ok: true };
    } catch {
        return { ids: [], total: 0, ok: false };
    } finally {
        clearTimeout(timer);
    }
}

function defaultLiveState(): LiveSearchState {
    return {
        version: 4,
        cloudPage: 0,
        genericPage: 0,
        cloudTotal: 0,
        genericTotal: 0,
        sourceTurn: 0,
        lastStoreRequestAt: 0,
        lastSearchAt: 0,
        candidates: {}
    };
}

function normalizeCandidate(value: Partial<StoreCandidate> & { appId: string }): StoreCandidate {
    const status: CandidateStatus = value.status === 'unresolved'
        || value.status === 'no-cloud'
        || value.status === 'cloud'
        || value.status === 'not-free'
        ? value.status
        : 'queued';
    return {
        appId: String(value.appId),
        cloudListed: Boolean(value.cloudListed),
        seenAt: Number(value.seenAt ?? 0) || 0,
        status,
        appInfoCheckedAt: Number(value.appInfoCheckedAt ?? 0) || 0,
        freeCheckedAt: Number(value.freeCheckedAt ?? 0) || 0,
        attempts: Math.max(0, Number(value.attempts ?? 0) || 0),
        retryAfter: Math.max(0, Number(value.retryAfter ?? 0) || 0)
    };
}

async function loadLiveState(cacheDir: string): Promise<LiveSearchState> {
    const raw = await readJson<Record<string, unknown>>(liveStateFile(cacheDir));
    if (!raw || typeof raw !== 'object') return defaultLiveState();

    const state = defaultLiveState();
    state.cloudPage = Math.max(0, Number(raw.cloudPage ?? 0) || 0);
    state.genericPage = Math.max(0, Number(raw.genericPage ?? 0) || 0);
    state.cloudTotal = Math.max(0, Number(raw.cloudTotal ?? 0) || 0);
    state.genericTotal = Math.max(0, Number(raw.genericTotal ?? 0) || 0);
    state.sourceTurn = Math.max(0, Number(raw.sourceTurn ?? 0) || 0);
    state.lastStoreRequestAt = Math.max(0, Number(raw.lastStoreRequestAt ?? 0) || 0);
    state.lastSearchAt = Math.max(0, Number(raw.lastSearchAt ?? raw.lastLiveSearchAt ?? 0) || 0);

    const previousVersion = Math.max(0, Number(raw.version ?? 0) || 0);
    const candidates = raw.candidates && typeof raw.candidates === 'object' && !Array.isArray(raw.candidates)
        ? raw.candidates as Record<string, Record<string, unknown>>
        : {};
    for (const [appId, candidate] of Object.entries(candidates)) {
        if (!/^\d+$/.test(appId) || !candidate || typeof candidate !== 'object') continue;
        const legacyCheckedAt = Number(candidate.checkedAt ?? 0) || 0;
        const storedStatus = String(candidate.status ?? '');
        const migratedStatus: CandidateStatus = storedStatus === 'queued' || storedStatus === 'unresolved' || storedStatus === 'no-cloud' || storedStatus === 'cloud' || storedStatus === 'not-free'
            ? storedStatus as CandidateStatus
            : legacyCheckedAt > 0 ? 'unresolved' : 'queued';

        const recheckAfterUpgrade = previousVersion < 4 && migratedStatus !== 'cloud';
        state.candidates[appId] = normalizeCandidate({
            appId,
            cloudListed: Boolean(candidate.cloudListed),
            seenAt: Number(candidate.seenAt ?? 0) || 0,
            status: recheckAfterUpgrade ? 'queued' : migratedStatus,
            appInfoCheckedAt: recheckAfterUpgrade ? 0 : Number(candidate.appInfoCheckedAt ?? legacyCheckedAt) || 0,
            freeCheckedAt: recheckAfterUpgrade ? 0 : Number(candidate.freeCheckedAt ?? 0) || 0,
            attempts: recheckAfterUpgrade ? 0 : Number(candidate.attempts ?? (legacyCheckedAt > 0 ? 1 : 0)) || 0,
            retryAfter: recheckAfterUpgrade ? 0 : Number(candidate.retryAfter ?? (legacyCheckedAt > 0 ? legacyCheckedAt + UNRESOLVED_BASE_RETRY_MS : 0)) || 0
        });
    }
    return state;
}


function refreshDiscoveryStats(state: LiveSearchState): void {
    const candidates = Object.values(state.candidates);
    discoveryStats = {
        indexedApps: currentExternalCatalogGames().length,
        candidatesSeen: candidates.length,
        candidatesChecked: candidates.filter((candidate) => candidate.appInfoCheckedAt > 0).length,
        queuedCandidates: candidates.filter((candidate) => candidate.status === 'queued').length,
        unresolvedCandidates: candidates.filter((candidate) => candidate.status === 'unresolved').length,
        cloudCandidates: candidates.filter((candidate) => candidate.status === 'cloud').length,
        storeCloudTotal: state.cloudTotal,
        storeGenericTotal: state.genericTotal,
        lastSearchAt: state.lastSearchAt
    };
}

export function currentExternalCatalogStats(): ExternalCatalogDiscoveryStats {
    return {
        ...discoveryStats,
        indexedApps: currentExternalCatalogGames().length
    };
}

function ciValue(object: Record<string, unknown> | undefined, key: string): unknown {
    if (!object) return undefined;
    const found = Object.keys(object).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    return found === undefined ? undefined : object[found];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function appInfoFreeFlag(record: Record<string, unknown>): boolean | null {
    const common = objectRecord(ciValue(record, 'common'));
    const raw = ciValue(common, 'isfreeapp');
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const normalized = String(raw).trim().toLowerCase();
    if (raw === true || raw === 1 || normalized === '1' || normalized === 'true') return true;
    if (raw === false || raw === 0 || normalized === '0' || normalized === 'false') return false;
    return null;
}

function readyCandidateCount(state: LiveSearchState): number {
    const now = Date.now();
    const known = new Set(currentExternalCatalogGames().map((game) => game.appId));
    return Object.values(state.candidates)
        .filter((candidate) => !known.has(candidate.appId) || candidate.status === 'cloud')
        .filter((candidate) => candidateReady(candidate, now))
        .length;
}

function nextPage(current: number, total: number): number {
    if (!(total > 0)) return Math.max(0, current) + 1;
    const pages = Math.max(1, Math.ceil(total / STORE_PAGE_SIZE));
    return (Math.max(0, current) + 1) % pages;
}

function candidateReady(candidate: StoreCandidate, now: number): boolean {
    if (candidate.status === 'queued') return true;
    if (candidate.status === 'unresolved') return now >= candidate.retryAfter;
    if (candidate.status === 'no-cloud') return now - candidate.appInfoCheckedAt >= NO_CLOUD_RECHECK_MS;
    if (candidate.status === 'not-free') return now - candidate.freeCheckedAt >= NOT_FREE_RECHECK_MS;
    if (candidate.status === 'cloud') return now - Math.max(candidate.appInfoCheckedAt, candidate.freeCheckedAt) >= CLOUD_RECHECK_MS;
    return true;
}

function candidatePriority(candidate: StoreCandidate, now: number): number {
    let score = candidate.cloudListed ? 1_000_000 : 0;
    if (candidate.status === 'queued') score += 500_000;
    else if (candidate.status === 'unresolved') score += 350_000;
    else if (candidate.status === 'cloud') score += 250_000;
    else if (candidate.status === 'not-free') score += 100_000;
    score += Math.min(100_000, Math.max(0, now - candidate.appInfoCheckedAt) / 1000);
    score += Math.min(50_000, Math.max(0, now - candidate.seenAt) / 10_000);
    return score;
}

function selectCandidateIds(state: LiveSearchState, limit = CANDIDATE_BATCH_SIZE): string[] {
    const now = Date.now();
    const known = new Set(currentExternalCatalogGames().map((game) => game.appId));
    return Object.values(state.candidates)
        .filter((candidate) => !known.has(candidate.appId) || candidate.status === 'cloud')
        .filter((candidate) => candidateReady(candidate, now))
        .sort((left, right) => candidatePriority(right, now) - candidatePriority(left, now)
            || Number(left.appId) - Number(right.appId))
        .slice(0, limit)
        .map((candidate) => candidate.appId);
}

function compactState(state: LiveSearchState): void {
    const now = Date.now();
    const compact = Object.values(state.candidates)
        .sort((left, right) => Number(right.status === 'queued') - Number(left.status === 'queued')
            || Number(right.cloudListed) - Number(left.cloudListed)
            || candidatePriority(right, now) - candidatePriority(left, now))
        .slice(0, CANDIDATE_CACHE_LIMIT);
    state.candidates = Object.fromEntries(compact.map((candidate) => [candidate.appId, candidate]));
}

async function throttleStore(state: LiveSearchState, deadline: number): Promise<boolean> {
    const remainingDelay = STORE_REQUEST_DELAY_MS - (Date.now() - state.lastStoreRequestAt);
    if (remainingDelay <= 0) return true;
    if (Date.now() + remainingDelay >= deadline - 500) return false;
    await sleep(remainingDelay);
    return true;
}

async function extendFrontier(cacheDir: string, state: LiveSearchState, deadline: number): Promise<number> {
    if (!(await throttleStore(state, deadline))) return 0;

    const cycle = STORE_CLOUD_TURNS + 1;
    const cloudListed = state.sourceTurn % cycle < STORE_CLOUD_TURNS;
    const page = cloudListed ? state.cloudPage : state.genericPage;
    const result = await fetchStorePage(cloudListed, page, deadline);
    state.lastStoreRequestAt = Date.now();
    state.sourceTurn += 1;

    if (result.ok) {
        if (cloudListed) {
            if (result.total > 0) state.cloudTotal = result.total;
            state.cloudPage = nextPage(state.cloudPage, state.cloudTotal || result.total);
        } else {
            if (result.total > 0) state.genericTotal = result.total;
            state.genericPage = nextPage(state.genericPage, state.genericTotal || result.total);
        }
    }

    const now = Date.now();
    for (const appId of result.ids) {
        const existing = state.candidates[appId];
        if (existing) {
            existing.cloudListed = existing.cloudListed || cloudListed;
            existing.seenAt = now;
            continue;
        }
        state.candidates[appId] = {
            appId,
            cloudListed,
            seenAt: now,
            status: 'queued',
            appInfoCheckedAt: 0,
            freeCheckedAt: 0,
            attempts: 0,
            retryAfter: 0
        };
    }

    compactState(state);
    refreshDiscoveryStats(state);
    await writeJson(liveStateFile(cacheDir), state).catch(() => undefined);
    return result.ids.length;
}

async function fetchBuffer(url: string, timeoutMs: number): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'VaporStow/1.0.2' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
}

async function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<boolean> {
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
        } catch {
            finish(false);
            return;
        }
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            finish(false);
        }, Math.max(500, timeoutMs));
        child.once('error', () => { clearTimeout(timer); finish(false); });
        child.once('exit', (code) => { clearTimeout(timer); finish(code === 0); });
    });
}

async function runCapture(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
    return await new Promise((resolve) => {
        let settled = false;
        let output = '';
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve(output);
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            finish();
            return;
        }
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { output += chunk; });
        child.stderr?.on('data', (chunk: string) => { output += `\n${chunk}`; });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            finish();
        }, Math.max(500, timeoutMs));
        child.once('error', () => { clearTimeout(timer); finish(); });
        child.once('exit', () => { clearTimeout(timer); finish(); });
    });
}

async function extractSteamCmd(archive: string, toolDir: string, timeoutMs: number): Promise<boolean> {
    if (process.platform === 'win32') {
        const escapedArchive = archive.replace(/'/g, "''");
        const escapedTarget = toolDir.replace(/'/g, "''");
        return run('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedTarget}' -Force`
        ], toolDir, timeoutMs);
    }
    return run('tar', ['-xzf', archive, '-C', toolDir], toolDir, timeoutMs);
}

async function findExistingSteamCmd(cacheDir: string): Promise<string | null> {
    const managed = managedSteamCmdExecutable(path.join(cacheDir, 'steamcmd'));
    const candidates = process.platform === 'win32'
        ? [managed]
        : [managed, '/usr/games/steamcmd', '/usr/bin/steamcmd', '/usr/local/bin/steamcmd'];
    for (const candidate of candidates) {
        if (await fileExists(candidate)) return candidate;
    }
    return null;
}

async function ensureManagedSteamCmd(cacheDir: string, deadline: number): Promise<string | null> {
    const existing = await findExistingSteamCmd(cacheDir);
    if (existing) return existing;
    const url = STEAMCMD_URLS[process.platform];
    if (!url || Date.now() >= deadline - 3_000) return null;

    const toolDir = path.join(cacheDir, 'steamcmd');
    const executable = managedSteamCmdExecutable(toolDir);
    try {
        await fsp.mkdir(toolDir, { recursive: true });
        const archive = path.join(toolDir, process.platform === 'win32' ? 'steamcmd.zip' : 'steamcmd.tar.gz');
        const remaining = Math.max(2_000, deadline - Date.now() - 1_500);
        const buffer = await fetchBuffer(url, Math.min(10_000, remaining));
        await fsp.writeFile(archive, buffer);
        const extractBudget = Math.max(1_500, deadline - Date.now() - 500);
        const ok = await extractSteamCmd(archive, toolDir, Math.min(12_000, extractBudget));
        await fsp.rm(archive, { force: true }).catch(() => undefined);
        if (!ok || !(await fileExists(executable))) return null;
        if (process.platform !== 'win32') await fsp.chmod(executable, 0o755).catch(() => undefined);
        return executable;
    } catch {
        return null;
    }
}

async function requestSteamCmdAppInfo(
    executable: string,
    appIds: string[],
    deadline: number
): Promise<boolean> {
    if (appIds.length === 0 || Date.now() >= deadline - 1_000) return false;
    const cwd = path.dirname(executable);
    const requestArgs: string[] = ['+login', 'anonymous'];
    for (const appId of appIds) requestArgs.push('+app_info_request', appId);
    requestArgs.push('+quit');
    const requestBudget = Math.min(STEAMCMD_REQUEST_TIMEOUT_MS, Math.max(800, deadline - Date.now() - 700));
    const ok = await run(executable, requestArgs, cwd, requestBudget);
    if (ok && Date.now() < deadline - 500) await sleep(300);
    return ok;
}

async function printSteamCmdAppInfo(
    executable: string,
    appIds: string[],
    deadline: number
): Promise<string> {
    if (appIds.length === 0 || Date.now() >= deadline - 800) return '';
    const cwd = path.dirname(executable);
    const printArgs: string[] = ['+login', 'anonymous'];
    for (const appId of appIds) printArgs.push('+app_info_print', appId);
    printArgs.push('+quit');
    const printBudget = Math.min(STEAMCMD_PRINT_TIMEOUT_MS, Math.max(700, deadline - Date.now() - 300));
    return await runCapture(executable, printArgs, cwd, printBudget);
}

async function fetchPublicAppInfoRecord(
    appId: string,
    deadline: number
): Promise<Record<string, unknown> | null> {
    if (Date.now() >= deadline - 650) return null;
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        Math.min(PUBLIC_APPINFO_TIMEOUT_MS, Math.max(650, deadline - Date.now() - 250))
    );
    try {
        const response = await fetch(`https://api.steamcmd.net/v1/info/${appId}`, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'VaporStow/1.0.2 outside-search',
                'Accept': 'application/json'
            }
        });
        if (!response.ok) return null;
        const payload = await response.json() as PublicAppInfoPayload;
        if (payload.status && payload.status !== 'success') return null;
        const data = objectRecord(payload.data);
        const record = objectRecord(data?.[appId]);
        return record ?? null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchPublicAppInfoBatch(
    appIds: string[],
    deadline: number
): Promise<Record<string, Record<string, unknown>>> {
    const output: Record<string, Record<string, unknown>> = {};
    let cursor = 0;
    const workers = Array.from({ length: Math.min(PUBLIC_APPINFO_CONCURRENCY, appIds.length) }, async () => {
        while (Date.now() < deadline - 700) {
            const index = cursor;
            cursor += 1;
            if (index >= appIds.length) return;
            const appId = appIds[index];
            const record = await fetchPublicAppInfoRecord(appId, deadline);
            if (record) output[appId] = record;
        }
    });
    await Promise.all(workers);
    return output;
}

type StorePresentation = {
    isFree: boolean | null;
    name: string | null;
    artworkUrls: string[];
};

async function fetchStorePresentation(appId: string, deadline: number): Promise<StorePresentation | null> {
    if (Date.now() >= deadline - 500) return null;
    const url = new URL('https://store.steampowered.com/api/appdetails');
    url.searchParams.set('appids', appId);
    url.searchParams.set('cc', 'us');
    url.searchParams.set('l', 'english');
    url.searchParams.set('filters', 'basic');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(3_500, Math.max(600, deadline - Date.now())));
    try {
        const response = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
                'User-Agent': 'VaporStow/1.0.2 outside-search',
                'Accept': 'application/json'
            }
        });
        if (!response.ok) return null;
        const payload = await response.json() as StoreAppDetailsPayload;
        const entry = payload[appId];
        if (entry?.success !== true || !entry.data) return null;
        const artworkUrls = [entry.data.capsule_image, entry.data.capsule_imagev5, entry.data.header_image]
            .filter((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value));
        return {
            isFree: typeof entry.data.is_free === 'boolean' ? entry.data.is_free : null,
            name: typeof entry.data.name === 'string' && entry.data.name.trim() ? entry.data.name.trim() : null,
            artworkUrls: [...new Set(artworkUrls)]
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        if (Date.now() < deadline - APPDETAILS_DELAY_MS) await sleep(APPDETAILS_DELAY_MS);
    }
}

function catalogAppFromRecord(
    appId: string,
    record: Record<string, unknown>,
    game: GameDefinition,
    presentation: StorePresentation | null
): CatalogApp {
    return {
        appId,
        name: presentation?.name || game.name,
        isFreeApp: true,
        storePriceCents: 0,
        storePriceLabel: 'Free',
        installSizeBytes: game.installSizeFallbackBytes > 0 ? game.installSizeFallbackBytes : undefined,
        artworkUrls: [...new Set([...game.artworkUrls, ...(presentation?.artworkUrls ?? [])])],
        appInfo: record
    };
}

async function saveLiveCatalog(cacheDir: string, incoming: CatalogApp[], steamRoot: string): Promise<void> {
    if (incoming.length === 0) return;
    const previous = await readJson<unknown>(liveIndexFile(cacheDir));
    const apps = new Map<string, CatalogApp>();
    if (validCatalog(previous)) {
        for (const app of previous.apps) apps.set(app.appId, app);
    }
    for (const app of incoming) apps.set(app.appId, app);
    const document: CatalogDocument = {
        version: 1,
        generatedAt: new Date().toISOString(),
        apps: [...apps.values()].sort((left, right) => Number(left.appId) - Number(right.appId))
    };
    await writeJson(liveIndexFile(cacheDir), document);
    liveGames = definitionsFromCatalog(document, steamRoot);
}

function unresolvedRetry(attempts: number): number {
    const exponent = Math.max(0, Math.min(6, attempts - 1));
    return Math.min(UNRESOLVED_MAX_RETRY_MS, UNRESOLVED_BASE_RETRY_MS * 2 ** exponent);
}

async function validateCandidateBatch(
    cacheDir: string,
    steamRoot: string,
    state: LiveSearchState,
    candidateIds: string[],
    deadline: number
): Promise<void> {
    if (candidateIds.length === 0 || Date.now() >= deadline - 900) return;
    const wanted = new Set(candidateIds);
    const appInfoPath = path.join(steamRoot, 'appcache', 'appinfo.vdf');

    const managedAppInfoPath = path.join(cacheDir, 'steamcmd', 'appcache', 'appinfo.vdf');
    const [localRecords, managedRecords] = await Promise.all([
        appInfoRecordsFromAppInfoFile(appInfoPath, wanted),
        appInfoRecordsFromAppInfoFile(managedAppInfoPath, wanted)
    ]);
    const cachedRecords: Record<string, Record<string, unknown>> = { ...managedRecords, ...localRecords };
    const missing = candidateIds.filter((appId) => !cachedRecords[appId]);

    let publicRecords: Record<string, Record<string, unknown>> = {};
    if (missing.length > 0 && Date.now() < deadline - 1_200) {
        publicRecords = await fetchPublicAppInfoBatch(missing, deadline);
    }

    const afterPublic = missing.filter((appId) => !publicRecords[appId]);
    let refreshedRecords: Record<string, Record<string, unknown>> = {};
    let textRecords: Record<string, Record<string, unknown>> = {};
    if (afterPublic.length > 0 && Date.now() < deadline - 1_500) {
        const executable = await ensureManagedSteamCmd(cacheDir, deadline);
        if (executable && Date.now() < deadline - 1_200) {
            await requestSteamCmdAppInfo(executable, afterPublic, deadline);
            refreshedRecords = await appInfoRecordsFromAppInfoFile(managedAppInfoPath, new Set(afterPublic));
            const stillMissing = afterPublic.filter((appId) => !refreshedRecords[appId]);
            if (stillMissing.length > 0 && Date.now() < deadline - 1_000) {
                const output = await printSteamCmdAppInfo(executable, stillMissing, deadline);
                if (output) textRecords = parseTextAppInfoRecords(output, new Set(stillMissing));
            }
        }
    }

    const records: Record<string, Record<string, unknown>> = {
        ...cachedRecords,
        ...publicRecords,
        ...refreshedRecords,
        ...textRecords
    };
    const definitions = discoverSteamCloudGamesFromJsonAppInfo(
        { data: records },
        steamRoot,
        wanted,
        { discoverySource: 'catalog', requireFree: false }
    );
    const definitionsById = new Map(definitions.map((game) => [game.appId, game]));
    const persist: CatalogApp[] = [];
    const now = Date.now();

    for (const appId of candidateIds) {
        const candidate = state.candidates[appId];
        if (!candidate) continue;
        const record = records[appId];
        if (!record) {
            candidate.status = 'unresolved';
            candidate.attempts += 1;
            candidate.retryAfter = now + unresolvedRetry(candidate.attempts);
            continue;
        }

        candidate.appInfoCheckedAt = now;
        candidate.retryAfter = 0;
        candidate.attempts = 0;
        const definition = definitionsById.get(appId);
        if (!definition) {
            candidate.status = 'no-cloud';
            continue;
        }

        const freeFlag = appInfoFreeFlag(record);
        const presentation = Date.now() < deadline - 700
            ? await fetchStorePresentation(appId, deadline)
            : null;
        const free: boolean | null = freeFlag ?? presentation?.isFree ?? null;
        candidate.freeCheckedAt = Date.now();
        if (free === null) {
            candidate.status = 'unresolved';
            candidate.attempts = Math.max(1, candidate.attempts + 1);
            candidate.retryAfter = Date.now() + unresolvedRetry(candidate.attempts);
            continue;
        }
        if (!free) {
            candidate.status = 'not-free';
            continue;
        }

        candidate.status = 'cloud';
        const normalized: GameDefinition = {
            ...definition,
            discoverySource: 'catalog',
            isFreeApp: true,
            storePriceCents: 0,
            storePriceLabel: 'Free'
        };
        persist.push(catalogAppFromRecord(appId, record, normalized, presentation));
    }

    if (persist.length > 0) await saveLiveCatalog(cacheDir, persist, steamRoot).catch(() => undefined);
    compactState(state);
    refreshDiscoveryStats(state);
    await writeJson(liveStateFile(cacheDir), state).catch(() => undefined);
}

async function runDiscoveryPass(
    cacheDir: string,
    steamRoot: string,
    criteria: ExternalCatalogSearchCriteria,
    deadline: number
): Promise<void> {
    const state = await loadLiveState(cacheDir);
    const target = Math.max(1, Math.min(48, Math.floor(criteria.targetResults ?? 24)));
    state.lastSearchAt = Date.now();
    refreshDiscoveryStats(state);

    while (Date.now() < deadline - 900) {
        if (matchingCount(criteria) >= target) break;

        let frontierAttempts = 0;
        const minimumFrontierPages = readyCandidateCount(state) === 0 ? 2 : 0;
        while ((frontierAttempts < minimumFrontierPages || readyCandidateCount(state) < CANDIDATE_PREFETCH_TARGET)
            && Date.now() < deadline - 6_000
            && frontierAttempts < 4) {
            const before = readyCandidateCount(state);
            await extendFrontier(cacheDir, state, deadline);
            frontierAttempts += 1;
            if (readyCandidateCount(state) <= before && Date.now() >= deadline - 8_000) break;
        }

        const batch = selectCandidateIds(state);
        if (batch.length === 0) {
            if (Date.now() < deadline - STORE_REQUEST_DELAY_MS - 2_000) {
                await extendFrontier(cacheDir, state, deadline);
            }
            const retry = selectCandidateIds(state);
            if (retry.length === 0) break;
            await validateCandidateBatch(cacheDir, steamRoot, state, retry, deadline);
        } else {
            await validateCandidateBatch(cacheDir, steamRoot, state, batch, deadline);
        }

        refreshDiscoveryStats(state);
        if (Date.now() < deadline - SEARCH_BATCH_IDLE_DELAY_MS - 900) {
            await sleep(SEARCH_BATCH_IDLE_DELAY_MS);
        }
    }

    state.lastSearchAt = Date.now();
    compactState(state);
    refreshDiscoveryStats(state);
    await writeJson(liveStateFile(cacheDir), state).catch(() => undefined);
}

export async function refreshExternalCatalogDiscovery(
    cacheDir: string,
    steamRoot: string | null,
    criteria: ExternalCatalogSearchCriteria = {}
): Promise<GameDefinition[]> {
    if (!steamRoot) return currentExternalCatalogGames();
    await loadCachedCatalog(cacheDir, steamRoot);
    refreshDiscoveryStats(await loadLiveState(cacheDir));

    const target = Math.max(1, Math.min(48, Math.floor(criteria.targetResults ?? 24)));
    if (matchingCount(criteria) >= target) return currentExternalCatalogGames();

    if (foregroundPromise) return foregroundPromise;
    foregroundPromise = (async () => {
        const deadline = Date.now() + SEARCH_BUDGET_MS;
        await runDiscoveryPass(cacheDir, steamRoot, criteria, deadline);
        return currentExternalCatalogGames();
    })().finally(() => { foregroundPromise = null; });

    return foregroundPromise;
}

export function currentExternalCatalogGames(): GameDefinition[] {
    return mergeGames(seedGames, liveGames);
}

export async function startExternalCatalogDiscovery(
    cacheDir: string,
    steamRoot: string | null
): Promise<GameDefinition[]> {
    if (!steamRoot) return currentExternalCatalogGames();
    const games = await loadCachedCatalog(cacheDir, steamRoot);
    refreshDiscoveryStats(await loadLiveState(cacheDir));
    return games;
}
