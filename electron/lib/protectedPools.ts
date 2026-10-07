import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GameId } from '../games';
import * as cloudFs from './cloudFs';

export type ProtectedImportMode = 'mirror' | 'reed-solomon';
export type ProtectedPoolState = 'pending' | 'healthy' | 'degraded';

export type ImportSelection = {
    sourcePath: string;
    relativePath: string;
    name: string;
    size: number;
};

export type ReedSolomonLayout = {
    dataShards: number;
    parityShards: number;
};

export type ProtectedPoolFile = {
    name: string;
    logicalPath: string;
    size: number;
    sha256: string;
    stageOriginal: string;
    shardSize?: number;
    shardFiles?: string[];
};

export type ProtectedPool = {
    version: 1;
    id: string;
    mode: ProtectedImportMode;
    originGameId: GameId;
    memberGameIds: GameId[];
    directory: string;
    createdAt: string;
    state: ProtectedPoolState;
    syncedGameIds: GameId[];
    layout?: ReedSolomonLayout;
    files: ProtectedPoolFile[];
    pendingDeletions?: string[];
    inaccessibleGameIds?: GameId[];
};

export type ProtectionDescriptor = {
    mode: ProtectedImportMode;
    poolId: string;
    memberGameIds: GameId[];
    state: ProtectedPoolState;
    dataShards?: number;
    parityShards?: number;
};

type ProtectedCleanupTask = {
    poolId: string;
    gameId: GameId;
    mode: ProtectedImportMode;
    logicalPaths: string[];
};

type Registry = {
    version: 1;
    pools: ProtectedPool[];
    retiredPoolIds?: string[];
    cleanupTasks?: ProtectedCleanupTask[];
};

export const PROTECTED_LIBRARY_FOLDER = 'VaporStow Protected';
export const PROTECTED_MIN_QUOTA_BYTES = 100_000_000_000;
export const PROTECTED_MIN_FILE_SLOTS = 10_000;

const REGISTRY_VERSION = 1;
const MANIFEST_FILE = 'pool.vstow.json';
const RS_IO_BLOCK = 1024 * 1024;
let registryCache: Registry | null = null;

function registryFile(): string {
    return path.join(app.getPath('userData'), 'protected-pools.json');
}

function stagingBase(): string {
    return path.join(app.getPath('userData'), 'protected-pool-staging');
}

function stageRoot(poolId: string): string {
    return path.join(stagingBase(), poolId);
}

function normalizePortable(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function safePortable(value: string): string {
    const clean = normalizePortable(value);
    if (!clean || clean.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('Invalid protected import path.');
    }
    return clean;
}

function parentPortable(value: string): string {
    const parts = normalizePortable(value).split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function logicalPath(directory: string, relativePath: string): string {
    return [normalizePortable(directory), safePortable(relativePath)].filter(Boolean).join('/');
}

export function isProtectedCloudEligible(quotaBytes: number, maxFiles: number): boolean {
    return Number.isFinite(quotaBytes)
        && Number.isFinite(maxFiles)
        && quotaBytes >= PROTECTED_MIN_QUOTA_BYTES
        && maxFiles >= PROTECTED_MIN_FILE_SLOTS;
}


async function loadRegistry(): Promise<Registry> {
    if (registryCache) return registryCache;
    try {
        const parsed = JSON.parse(await fsp.readFile(registryFile(), 'utf8')) as Partial<Registry>;
        if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.pools)) throw new Error('Invalid protected pool registry.');
        registryCache = {
            version: REGISTRY_VERSION,
            pools: parsed.pools as ProtectedPool[],
            retiredPoolIds: Array.isArray(parsed.retiredPoolIds) ? parsed.retiredPoolIds : [],
            cleanupTasks: Array.isArray(parsed.cleanupTasks) ? parsed.cleanupTasks as ProtectedCleanupTask[] : []
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[VaporStow] Protected pool registry reset:', error);
        }
        registryCache = { version: REGISTRY_VERSION, pools: [], retiredPoolIds: [], cleanupTasks: [] };
    }
    return registryCache;
}

async function saveRegistry(): Promise<void> {
    const registry = await loadRegistry();
    const file = registryFile();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, file);
}

function validateMembers(mode: ProtectedImportMode, memberGameIds: GameId[]): void {
    const unique = new Set(memberGameIds);
    if (unique.size !== memberGameIds.length) throw new Error('A protected pool cannot contain the same Cloud twice.');
    if (mode === 'mirror' && memberGameIds.length < 2) throw new Error('Mirror requires at least 2 Clouds.');
    if (mode === 'reed-solomon' && memberGameIds.length < 3) throw new Error('Reed–Solomon requires at least 3 Clouds.');
}

export function layoutForCloudCount(count: number): ReedSolomonLayout {
    if (count < 3) throw new Error('Reed–Solomon requires at least 3 Clouds.');
    if (count === 3) return { dataShards: 2, parityShards: 1 };
    if (count === 4) return { dataShards: 3, parityShards: 1 };
    if (count === 5) return { dataShards: 3, parityShards: 2 };
    if (count === 6) return { dataShards: 4, parityShards: 2 };
    if (count === 7) return { dataShards: 4, parityShards: 3 };
    const parityShards = Math.max(2, Math.floor(count / 3));
    return { dataShards: count - parityShards, parityShards };
}

async function sha256File(file: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.once('error', reject);
        stream.once('end', () => resolve(hash.digest('hex')));
    });
}

async function durableCopy(source: string, destination: string): Promise<void> {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
    try {
        await fsp.copyFile(source, temporary);
        await fsp.rename(temporary, destination);
    } finally {
        await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
}

// GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfInv(a: number): number {
    if (a === 0) throw new Error('Cannot invert zero in GF(256).');
    return GF_EXP[255 - GF_LOG[a]];
}

function gfPow(a: number, power: number): number {
    if (power === 0) return 1;
    if (a === 0) return 0;
    return GF_EXP[(GF_LOG[a] * power) % 255];
}

function invertMatrix(input: number[][]): number[][] {
    const n = input.length;
    const work = input.map((row, r) => [
        ...row,
        ...Array.from({ length: n }, (_, c) => (r === c ? 1 : 0))
    ]);

    for (let col = 0; col < n; col += 1) {
        let pivot = col;
        while (pivot < n && work[pivot][col] === 0) pivot += 1;
        if (pivot === n) throw new Error('Reed–Solomon matrix is singular.');
        if (pivot !== col) [work[col], work[pivot]] = [work[pivot], work[col]];

        const scale = gfInv(work[col][col]);
        for (let c = 0; c < n * 2; c += 1) work[col][c] = gfMul(work[col][c], scale);

        for (let row = 0; row < n; row += 1) {
            if (row === col) continue;
            const factor = work[row][col];
            if (factor === 0) continue;
            for (let c = 0; c < n * 2; c += 1) {
                work[row][c] ^= gfMul(factor, work[col][c]);
            }
        }
    }
    return work.map((row) => row.slice(n));
}

function multiplyMatrices(left: number[][], right: number[][]): number[][] {
    const rows = left.length;
    const inner = right.length;
    const cols = right[0]?.length ?? 0;
    const output = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
            let value = 0;
            for (let i = 0; i < inner; i += 1) value ^= gfMul(left[r][i], right[i][c]);
            output[r][c] = value;
        }
    }
    return output;
}

function generatorMatrix(totalShards: number, dataShards: number): number[][] {
    const vandermonde = Array.from({ length: totalShards }, (_, row) => {
        const base = row + 1;
        return Array.from({ length: dataShards }, (_, col) => gfPow(base, col));
    });
    const top = vandermonde.slice(0, dataShards);
    return multiplyMatrices(vandermonde, invertMatrix(top));
}

async function encodeReedSolomon(
    source: string,
    outputDirectory: string,
    baseName: string,
    layout: ReedSolomonLayout
): Promise<{ shardFiles: string[]; shardSize: number }> {
    const stat = await fsp.stat(source);
    const totalShards = layout.dataShards + layout.parityShards;
    const shardSize = Math.ceil(stat.size / layout.dataShards);
    const matrix = generatorMatrix(totalShards, layout.dataShards);
    await fsp.mkdir(outputDirectory, { recursive: true });

    const shardFiles = Array.from({ length: totalShards }, (_, index) =>
        path.join(outputDirectory, `${baseName}.${String(index + 1).padStart(2, '0')}-of-${String(totalShards).padStart(2, '0')}.vstowrs`)
    );
    const sourceHandle = await fsp.open(source, 'r');
    const outputHandles = await Promise.all(shardFiles.map((file) => fsp.open(file, 'w')));
    const parityTables = matrix.slice(layout.dataShards).map((row) =>
        row.map((coefficient) => Uint8Array.from({ length: 256 }, (_, value) => gfMul(coefficient, value)))
    );

    try {
        for (let offset = 0; offset < shardSize; offset += RS_IO_BLOCK) {
            const length = Math.min(RS_IO_BLOCK, shardSize - offset);
            const dataBlocks: Buffer[] = [];
            for (let dataIndex = 0; dataIndex < layout.dataShards; dataIndex += 1) {
                const block = Buffer.alloc(length);
                const sourcePosition = dataIndex * shardSize + offset;
                const available = Math.max(0, Math.min(length, stat.size - sourcePosition));
                if (available > 0) await sourceHandle.read(block, 0, available, sourcePosition);
                dataBlocks.push(block);
                await outputHandles[dataIndex].write(block, 0, block.length, offset);
            }

            for (let parityIndex = 0; parityIndex < layout.parityShards; parityIndex += 1) {
                const parity = Buffer.alloc(length);
                const tables = parityTables[parityIndex];
                for (let dataIndex = 0; dataIndex < layout.dataShards; dataIndex += 1) {
                    const block = dataBlocks[dataIndex];
                    const table = tables[dataIndex];
                    if (matrix[layout.dataShards + parityIndex][dataIndex] === 1) {
                        for (let i = 0; i < length; i += 1) parity[i] ^= block[i];
                    } else {
                        for (let i = 0; i < length; i += 1) parity[i] ^= table[block[i]];
                    }
                }
                await outputHandles[layout.dataShards + parityIndex].write(parity, 0, parity.length, offset);
            }
        }
    } finally {
        await sourceHandle.close();
        await Promise.all(outputHandles.map((handle) => handle.close()));
    }

    return { shardFiles, shardSize };
}

export async function createPool(
    mode: ProtectedImportMode,
    originGameId: GameId,
    memberGameIds: GameId[],
    _directory: string,
    selections: ImportSelection[]
): Promise<ProtectedPool> {
    validateMembers(mode, memberGameIds);
    if (!memberGameIds.includes(originGameId)) throw new Error('The current Cloud must remain in the protected pool.');
    if (selections.length === 0) throw new Error('Select at least one file.');

    const poolId = crypto.randomBytes(10).toString('hex');
    const root = stageRoot(poolId);
    const originals = path.join(root, 'originals');
    const shards = path.join(root, 'shards');
    await fsp.mkdir(originals, { recursive: true });
    const protectedDirectory = PROTECTED_LIBRARY_FOLDER;
    const layout = mode === 'reed-solomon' ? layoutForCloudCount(memberGameIds.length) : undefined;
    const files: ProtectedPoolFile[] = [];

    const seen = new Set<string>();
    for (let index = 0; index < selections.length; index += 1) {
        const selection = selections[index];
        const relativePath = safePortable(selection.relativePath);
        const duplicateKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
        if (seen.has(duplicateKey)) throw new Error(`Two selected files target the same path: “${relativePath}”.`);
        seen.add(duplicateKey);

        const stat = await fsp.stat(selection.sourcePath);
        if (!stat.isFile()) throw new Error(`“${selection.name}” is not a regular file.`);
        const stagedName = `${String(index + 1).padStart(4, '0')}-${crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}-${path.basename(relativePath)}`;
        const stagedOriginal = path.join(originals, stagedName);
        await durableCopy(selection.sourcePath, stagedOriginal);
        const sha256 = await sha256File(stagedOriginal);

        const file: ProtectedPoolFile = {
            name: path.basename(relativePath),
            logicalPath: logicalPath(protectedDirectory, relativePath),
            size: stat.size,
            sha256,
            stageOriginal: stagedOriginal
        };

        if (layout) {
            const encoded = await encodeReedSolomon(stagedOriginal, shards, crypto.createHash('sha256').update(file.logicalPath).digest('hex').slice(0, 24), layout);
            file.shardFiles = encoded.shardFiles;
            file.shardSize = encoded.shardSize;
        }
        files.push(file);
    }

    const pool: ProtectedPool = {
        version: 1,
        id: poolId,
        mode,
        originGameId,
        memberGameIds: [...memberGameIds],
        directory: protectedDirectory,
        createdAt: new Date().toISOString(),
        state: 'pending',
        syncedGameIds: [],
        layout,
        files
    };

    const registry = await loadRegistry();
    registry.pools = registry.pools.filter((candidate) => candidate.id !== pool.id);
    registry.pools.push(pool);
    await saveRegistry();
    return pool;
}

export async function getPool(poolId: string): Promise<ProtectedPool> {
    const registry = await loadRegistry();
    const pool = registry.pools.find((candidate) => candidate.id === poolId);
    if (!pool) throw new Error('Protected pool not found.');
    return pool;
}

function manifestPool(pool: ProtectedPool): ProtectedPool {
    return {
        ...pool,
        // Stage paths are local implementation details and never belong in Steam Cloud metadata.
        files: pool.files.map((file) => ({
            ...file,
            stageOriginal: '',
            shardFiles: file.shardFiles?.map((fileName) => path.basename(fileName))
        }))
    };
}

async function writeManifestSource(pool: ProtectedPool): Promise<string> {
    const file = path.join(stageRoot(pool.id), MANIFEST_FILE);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(manifestPool(pool), null, 2)}\n`, 'utf8');
    return file;
}

export async function deployToCloud(
    poolId: string,
    gameId: GameId,
    cloudRoot: string,
    quotaBytes: number,
    maxFiles: number
): Promise<{ files: number; bytes: number }> {
    const pool = await getPool(poolId);
    const memberIndex = pool.memberGameIds.indexOf(gameId);
    if (memberIndex < 0) throw new Error('This Cloud is not a member of the protected pool.');
    if (!isProtectedCloudEligible(quotaBytes, maxFiles)) {
        throw new Error('Protected storage requires at least 93 GiB of Steam Cloud quota and 10,000 file slots.');
    }

    let bytes = 0;
    if (pool.mode === 'mirror') {
        const mapped = pool.files.map((file) => {
            const relativeToPoolDirectory = pool.directory && file.logicalPath.startsWith(`${pool.directory}/`)
                ? file.logicalPath.slice(pool.directory.length + 1)
                : file.logicalPath;
            bytes += file.size;
            return { source: file.stageOriginal, relativePath: relativeToPoolDirectory };
        });
        await cloudFs.importMappedFiles(cloudRoot, pool.directory, mapped, quotaBytes, maxFiles);
    } else {
        const shardFiles = pool.files.map((file) => {
            const source = file.shardFiles?.[memberIndex];
            if (!source) throw new Error('Reed–Solomon shard is missing from the local staging area.');
            bytes += file.shardSize ?? 0;
            return source;
        });
        await cloudFs.importFiles(
            cloudRoot,
            `${cloudFs.PROTECTED_STORAGE_FOLDER}/${pool.id}`,
            shardFiles,
            quotaBytes,
            maxFiles
        );
    }

    if (!pool.syncedGameIds.includes(gameId)) pool.syncedGameIds.push(gameId);
    pool.state = pool.syncedGameIds.length === pool.memberGameIds.length ? 'healthy' : 'degraded';
    await saveRegistry();

    const manifest = await writeManifestSource(pool);
    await cloudFs.importFiles(
        cloudRoot,
        `${cloudFs.PROTECTED_STORAGE_FOLDER}/${pool.id}`,
        [manifest],
        quotaBytes,
        maxFiles
    );
    return { files: pool.files.length, bytes };
}

export async function finalizePool(poolId: string): Promise<ProtectedPool> {
    const pool = await getPool(poolId);
    pool.state = pool.syncedGameIds.length === pool.memberGameIds.length ? 'healthy' : 'degraded';
    await saveRegistry();
    if (pool.state === 'healthy') {
        await fsp.rm(stageRoot(pool.id), { recursive: true, force: true }).catch(() => undefined);
    }
    return pool;
}

function pendingDeletionTargets(pool: ProtectedPool): string[] {
    return [...new Set((pool.pendingDeletions ?? []).map(normalizePortable).filter(Boolean))];
}

function pathMatchesPendingDeletion(pool: ProtectedPool, logicalPath: string): boolean {
    const normalized = normalizePortable(logicalPath);
    return pendingDeletionTargets(pool).some((target) => normalized === target || normalized.startsWith(`${target}/`));
}

export type PendingProtectedDeletion = {
    poolId: string;
    logicalPath: string;
    memberGameIds: GameId[];
};

export async function stageEntryDeletion(poolId: string, logicalTarget: string): Promise<PendingProtectedDeletion> {
    const pool = await getPool(poolId);
    const target = normalizePortable(logicalTarget);
    if (!target) throw new Error('Invalid protected file path.');
    const targets = protectedFilesForTarget(pool, target);
    if (targets.length === 0) throw new Error('Protected file not found in this pool.');
    const pending = new Set(pendingDeletionTargets(pool));
    pending.add(target);
    pool.pendingDeletions = [...pending];
    await saveRegistry();
    return { poolId: pool.id, logicalPath: target, memberGameIds: [...pool.memberGameIds] };
}

export async function pendingEntryDeletionsForGame(gameId: GameId): Promise<PendingProtectedDeletion[]> {
    const registry = await loadRegistry();
    const output: PendingProtectedDeletion[] = [];
    for (const pool of registry.pools) {
        if (!pool.memberGameIds.includes(gameId)) continue;
        for (const logicalPath of pendingDeletionTargets(pool)) {
            output.push({ poolId: pool.id, logicalPath, memberGameIds: [...pool.memberGameIds] });
        }
    }
    return output;
}

export async function isPathPendingDeletion(gameId: GameId, logicalPath: string): Promise<boolean> {
    const registry = await loadRegistry();
    return registry.pools.some((pool) => pool.memberGameIds.includes(gameId) && pathMatchesPendingDeletion(pool, logicalPath));
}

export async function hasProtectedFiles(gameId: GameId): Promise<boolean> {
    const registry = await loadRegistry();
    return registry.pools.some((pool) =>
        pool.memberGameIds.includes(gameId)
        && pool.files.some((file) => !pathMatchesPendingDeletion(pool, file.logicalPath))
    );
}

function protectedFilesForTarget(pool: ProtectedPool, logicalTarget: string): ProtectedPoolFile[] {
    const target = normalizePortable(logicalTarget);
    if (!target) throw new Error('Invalid protected file path.');
    const prefix = `${target}/`;
    return pool.files.filter((file) => file.logicalPath === target || file.logicalPath.startsWith(prefix));
}

export async function deleteEntryFromCloud(
    poolId: string,
    gameId: GameId,
    cloudRoot: string,
    logicalTarget: string
): Promise<{ files: number; remainingFiles: number }> {
    const pool = await getPool(poolId);
    const memberIndex = pool.memberGameIds.indexOf(gameId);
    if (memberIndex < 0) throw new Error('This Cloud is not a member of the protected pool.');

    const targets = protectedFilesForTarget(pool, logicalTarget);
    if (targets.length === 0) throw new Error('Protected file not found in this pool.');
    const targetPaths = new Set(targets.map((file) => file.logicalPath));
    const remainingFiles = pool.files.filter((file) => !targetPaths.has(file.logicalPath));

    if (pool.mode === 'mirror') {
        for (const file of targets) await cloudFs.deleteEntry(cloudRoot, file.logicalPath);
        // The visible protected library is reserved for protected storage only.
        // Remove any now-empty nested folders, including the root when the last
        // protected file in this Cloud has disappeared.
        await cloudFs.pruneEmptyAuditSubtree(cloudRoot, PROTECTED_LIBRARY_FOLDER);
    } else {
        for (const file of targets) {
            const shard = file.shardFiles?.[memberIndex];
            if (!shard) throw new Error('Reed–Solomon shard metadata is missing for this Cloud.');
            await cloudFs.deleteEntry(
                cloudRoot,
                `${cloudFs.PROTECTED_STORAGE_FOLDER}/${pool.id}/${path.basename(shard)}`
            );
        }
    }

    const hiddenPoolDirectory = `${cloudFs.PROTECTED_STORAGE_FOLDER}/${pool.id}`;
    if (remainingFiles.length === 0) {
        await cloudFs.deleteEntry(cloudRoot, hiddenPoolDirectory);
    } else {
        const manifest = await writeManifestSource({ ...pool, files: remainingFiles });
        await cloudFs.importFiles(
            cloudRoot,
            hiddenPoolDirectory,
            [manifest],
            Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER
        );
    }

    return { files: targets.length, remainingFiles: remainingFiles.length };
}

export async function finalizeEntryDeletion(poolId: string, logicalTarget: string): Promise<{ removedFiles: number; poolRemoved: boolean }> {
    const registry = await loadRegistry();
    const pool = registry.pools.find((candidate) => candidate.id === poolId);
    if (!pool) throw new Error('Protected pool not found.');

    const targets = protectedFilesForTarget(pool, logicalTarget);
    if (targets.length === 0) throw new Error('Protected file not found in this pool.');
    const targetPaths = new Set(targets.map((file) => file.logicalPath));
    pool.files = pool.files.filter((file) => !targetPaths.has(file.logicalPath));
    pool.pendingDeletions = pendingDeletionTargets(pool).filter((target) => target !== normalizePortable(logicalTarget));
    pool.state = pool.syncedGameIds.length === pool.memberGameIds.length ? 'healthy' : 'degraded';

    const poolRemoved = pool.files.length === 0;
    if (poolRemoved) registry.pools = registry.pools.filter((candidate) => candidate.id !== poolId);
    await saveRegistry();
    await fsp.rm(stageRoot(poolId), { recursive: true, force: true }).catch(() => undefined);
    return { removedFiles: targets.length, poolRemoved };
}

export async function markPoolDegraded(poolId: string): Promise<void> {
    try {
        const pool = await getPool(poolId);
        pool.state = 'degraded';
        await saveRegistry();
    } catch {
        // The import may have failed before a pool was persisted.
    }
}

function protectedManifestRoot(cloudRoot: string): string {
    return path.join(cloudFs.auditRoot(cloudRoot), cloudFs.PROTECTED_STORAGE_FOLDER);
}

export async function ingestManifests(cloudRoot: string): Promise<number> {
    const root = protectedManifestRoot(cloudRoot);
    let dirents: fs.Dirent[];
    try {
        dirents = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
    }

    const registry = await loadRegistry();
    let changed = 0;
    for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        try {
            const parsed = JSON.parse(await fsp.readFile(path.join(root, dirent.name, MANIFEST_FILE), 'utf8')) as ProtectedPool;
            if (parsed.version !== 1 || parsed.id !== dirent.name || !Array.isArray(parsed.memberGameIds) || !Array.isArray(parsed.files)) continue;
            if ((registry.retiredPoolIds ?? []).includes(parsed.id)) continue;
            const existingIndex = registry.pools.findIndex((candidate) => candidate.id === parsed.id);
            if (existingIndex < 0) {
                registry.pools.push({ ...parsed, state: parsed.state === 'healthy' ? 'healthy' : 'degraded', syncedGameIds: parsed.syncedGameIds ?? [] });
                changed += 1;
                continue;
            }
            const existing = registry.pools[existingIndex];
            // Never replace live local staging paths with manifest-only paths, but merge health metadata.
            const mergedSynced = [...new Set([...(existing.syncedGameIds ?? []), ...(parsed.syncedGameIds ?? [])])];
            if (existing.files.some((file) => Boolean(file.stageOriginal))) {
                existing.syncedGameIds = mergedSynced;
                existing.state = existing.state === 'healthy' || parsed.state === 'healthy' ? 'healthy' : 'degraded';
                changed += 1;
                continue;
            }
            registry.pools[existingIndex] = {
                ...parsed,
                state: existing.state === 'healthy' || parsed.state === 'healthy' ? 'healthy' : 'degraded',
                syncedGameIds: mergedSynced
            };
            changed += 1;
        } catch {
            // Ignore a damaged/partial pool manifest; the actual Cloud files remain untouched.
        }
    }
    if (changed > 0) await saveRegistry();
    return changed;
}

function visibleMembers(pool: ProtectedPool): GameId[] {
    return pool.state === 'healthy' ? pool.memberGameIds : pool.syncedGameIds;
}

export async function descriptorFor(gameId: GameId, logicalFilePath: string): Promise<ProtectionDescriptor | null> {
    const normalized = normalizePortable(logicalFilePath);
    const registry = await loadRegistry();
    const pool = registry.pools
        .slice()
        .reverse()
        .find((candidate) => visibleMembers(candidate).includes(gameId) && !pathMatchesPendingDeletion(candidate, normalized) && candidate.files.some((file) => file.logicalPath === normalized));
    if (!pool) return null;
    return {
        mode: pool.mode,
        poolId: pool.id,
        memberGameIds: [...pool.memberGameIds],
        state: pool.state,
        dataShards: pool.layout?.dataShards,
        parityShards: pool.layout?.parityShards
    };
}

export type VirtualProtectedEntry = {
    path: string;
    parentPath: string;
    name: string;
    type: 'file' | 'directory';
    size: number;
    protection: ProtectionDescriptor;
};

export async function virtualEntriesForDirectory(gameId: GameId, directory: string): Promise<VirtualProtectedEntry[]> {
    const target = normalizePortable(directory);
    const targetPrefix = target ? `${target}/` : '';
    const registry = await loadRegistry();
    const output = new Map<string, VirtualProtectedEntry>();
    for (const pool of registry.pools) {
        if (pool.mode !== 'reed-solomon' || !visibleMembers(pool).includes(gameId)) continue;
        const protection: ProtectionDescriptor = {
            mode: pool.mode,
            poolId: pool.id,
            memberGameIds: [...pool.memberGameIds],
            state: pool.state,
            dataShards: pool.layout?.dataShards,
            parityShards: pool.layout?.parityShards
        };
        for (const file of pool.files) {
            if (pathMatchesPendingDeletion(pool, file.logicalPath)) continue;
            if (parentPortable(file.logicalPath) === target) {
                output.set(file.logicalPath, {
                    path: file.logicalPath,
                    parentPath: parentPortable(file.logicalPath),
                    name: file.name,
                    type: 'file',
                    size: file.size,
                    protection
                });
                continue;
            }
            if (!file.logicalPath.startsWith(targetPrefix)) continue;
            const remainder = file.logicalPath.slice(targetPrefix.length);
            const parts = remainder.split('/').filter(Boolean);
            if (parts.length < 2) continue;
            const childName = parts[0];
            const childPath = [target, childName].filter(Boolean).join('/');
            if (!output.has(childPath)) {
                output.set(childPath, {
                    path: childPath,
                    parentPath: target,
                    name: childName,
                    type: 'directory',
                    size: 0,
                    protection
                });
            }
        }
    }
    return [...output.values()];
}

export async function virtualSearch(gameId: GameId, query: string): Promise<VirtualProtectedEntry[]> {
    const term = query.trim().toLocaleLowerCase();
    const registry = await loadRegistry();
    const output: VirtualProtectedEntry[] = [];
    for (const pool of registry.pools) {
        if (pool.mode !== 'reed-solomon' || !visibleMembers(pool).includes(gameId)) continue;
        for (const file of pool.files) {
            if (pathMatchesPendingDeletion(pool, file.logicalPath)) continue;
            if (term && !file.name.toLocaleLowerCase().includes(term) && !file.logicalPath.toLocaleLowerCase().includes(term)) continue;
            output.push({
                path: file.logicalPath,
                parentPath: parentPortable(file.logicalPath),
                name: file.name,
                type: 'file',
                size: file.size,
                protection: {
                    mode: pool.mode,
                    poolId: pool.id,
                    memberGameIds: [...pool.memberGameIds],
                    state: pool.state,
                    dataShards: pool.layout?.dataShards,
                    parityShards: pool.layout?.parityShards
                }
            });
        }
    }
    return output;
}

export type ProtectedRepairIssue = {
    triggerGameId: GameId;
    poolIds: string[];
    corruptGameIds: GameId[];
    memberGameIds: GameId[];
    fileCount: number;
    totalBytes: number;
};

export type PreparedRepairPool = {
    id: string;
    mode: ProtectedImportMode;
    memberGameIds: GameId[];
    layout: ReedSolomonLayout | null;
    fileCount: number;
    totalBytes: number;
};

export type GatherRepairPlan = {
    id: string;
    triggerGameId: GameId;
    destinationGameId: GameId;
    poolIds: string[];
    sourceGameIds: GameId[];
    fileCount: number;
    totalBytes: number;
};

type GatherRepairPlanDisk = GatherRepairPlan & {
    files: Array<{ source: string; relativePath: string; size: number; sha256: string }>;
    cleanedGameIds: GameId[];
};

function repairPlanRoot(planId: string): string {
    return path.join(app.getPath('userData'), 'protected-repair-plans', planId);
}

function repairPlanFile(planId: string): string {
    return path.join(repairPlanRoot(planId), 'plan.json');
}

function uniqueGameIds(values: GameId[]): GameId[] {
    return [...new Set(values)];
}

function queueCleanupTask(registry: Registry, pool: ProtectedPool, gameId: GameId): void {
    registry.cleanupTasks ??= [];
    const task: ProtectedCleanupTask = {
        poolId: pool.id,
        gameId,
        mode: pool.mode,
        logicalPaths: pool.mode === 'mirror'
            ? pool.files.filter((file) => !pathMatchesPendingDeletion(pool, file.logicalPath)).map((file) => file.logicalPath)
            : []
    };
    const existing = registry.cleanupTasks.findIndex((candidate) => candidate.poolId === task.poolId && candidate.gameId === task.gameId);
    if (existing >= 0) registry.cleanupTasks[existing] = task;
    else registry.cleanupTasks.push(task);
}

function activeProtectedPoolsForGame(registry: Registry, gameId: GameId, mode?: ProtectedImportMode): ProtectedPool[] {
    return registry.pools.filter((pool) =>
        (!mode || pool.mode === mode)
        && pool.memberGameIds.includes(gameId)
        && pool.files.some((file) => !pathMatchesPendingDeletion(pool, file.logicalPath))
    );
}

export async function protectedRepairMemberIdsForGame(gameId: GameId): Promise<GameId[]> {
    const registry = await loadRegistry();
    return uniqueGameIds(activeProtectedPoolsForGame(registry, gameId).flatMap((pool) => pool.memberGameIds));
}

export async function reedSolomonMemberIdsForGame(gameId: GameId): Promise<GameId[]> {
    const registry = await loadRegistry();
    return uniqueGameIds(activeProtectedPoolsForGame(registry, gameId, 'reed-solomon').flatMap((pool) => pool.memberGameIds));
}

export async function markGameInaccessible(gameId: GameId): Promise<number> {
    const registry = await loadRegistry();
    let changed = 0;
    for (const pool of registry.pools) {
        if (!pool.memberGameIds.includes(gameId)) continue;
        const inaccessible = new Set(pool.inaccessibleGameIds ?? []);
        if (!inaccessible.has(gameId)) {
            inaccessible.add(gameId);
            pool.inaccessibleGameIds = [...inaccessible];
            changed += 1;
        }
        pool.state = 'degraded';
    }
    if (changed > 0) await saveRegistry();
    return changed;
}

export async function markGameAccessible(gameId: GameId): Promise<number> {
    const registry = await loadRegistry();
    let changed = 0;
    for (const pool of registry.pools) {
        const inaccessible = new Set(pool.inaccessibleGameIds ?? []);
        if (!inaccessible.delete(gameId)) continue;
        pool.inaccessibleGameIds = [...inaccessible];
        if (pool.inaccessibleGameIds.length === 0 && pool.syncedGameIds.length === pool.memberGameIds.length) {
            pool.state = 'healthy';
        }
        changed += 1;
    }
    if (changed > 0) await saveRegistry();
    return changed;
}

export async function isGameInaccessible(gameId: GameId): Promise<boolean> {
    const registry = await loadRegistry();
    return registry.pools.some((pool) =>
        (pool.inaccessibleGameIds ?? []).includes(gameId)
        && pool.files.some((file) => !pathMatchesPendingDeletion(pool, file.logicalPath))
    );
}

export async function repairIssueForGame(triggerGameId: GameId): Promise<ProtectedRepairIssue | null> {
    const registry = await loadRegistry();
    const pools = activeProtectedPoolsForGame(registry, triggerGameId).filter((pool) => (pool.inaccessibleGameIds ?? []).length > 0);
    if (pools.length === 0) return null;

    const uniqueFiles = new Map<string, ProtectedPoolFile>();
    for (const pool of pools) {
        for (const file of pool.files) {
            if (pathMatchesPendingDeletion(pool, file.logicalPath)) continue;
            uniqueFiles.set(`${pool.id}:${file.logicalPath}`, file);
        }
    }
    return {
        triggerGameId,
        poolIds: pools.map((pool) => pool.id),
        corruptGameIds: uniqueGameIds(pools.flatMap((pool) => pool.inaccessibleGameIds ?? [])),
        memberGameIds: uniqueGameIds(pools.flatMap((pool) => pool.memberGameIds)),
        fileCount: uniqueFiles.size,
        totalBytes: [...uniqueFiles.values()].reduce((sum, file) => sum + file.size, 0)
    };
}

function shardPathInCloud(pool: ProtectedPool, file: ProtectedPoolFile, memberIndex: number, cloudRoot: string): string | null {
    const shard = file.shardFiles?.[memberIndex];
    if (!shard) return null;
    return path.join(
        cloudFs.auditRoot(cloudRoot),
        cloudFs.PROTECTED_STORAGE_FOLDER,
        pool.id,
        path.basename(shard)
    );
}

async function reconstructMirrorOriginalFromClouds(
    pool: ProtectedPool,
    file: ProtectedPoolFile,
    cloudRoots: Partial<Record<GameId, string>>,
    destination: string
): Promise<void> {
    for (const memberId of pool.memberGameIds) {
        if ((pool.inaccessibleGameIds ?? []).includes(memberId)) continue;
        const cloudRoot = cloudRoots[memberId];
        if (!cloudRoot) continue;
        const source = path.join(cloudFs.auditRoot(cloudRoot), ...normalizePortable(file.logicalPath).split('/'));
        try {
            const stat = await fsp.stat(source);
            if (!stat.isFile() || stat.size !== file.size) continue;
            if (await sha256File(source) !== file.sha256) continue;
            await durableCopy(source, destination);
            return;
        } catch {
            // Try the next healthy Mirror replica.
        }
    }
    throw new Error(`No healthy Mirror replica remains for “${file.name}”.`);
}

async function reconstructOriginalFromProtectedClouds(
    pool: ProtectedPool,
    file: ProtectedPoolFile,
    cloudRoots: Partial<Record<GameId, string>>,
    destination: string
): Promise<void> {
    if (pool.mode === 'mirror') {
        await reconstructMirrorOriginalFromClouds(pool, file, cloudRoots, destination);
        return;
    }
    await reconstructOriginalFromClouds(pool, file, cloudRoots, destination);
}

async function reconstructOriginalFromClouds(
    pool: ProtectedPool,
    file: ProtectedPoolFile,
    cloudRoots: Partial<Record<GameId, string>>,
    destination: string
): Promise<void> {
    const layout = pool.layout;
    if (!layout) throw new Error('Reed–Solomon layout metadata is missing.');
    const shardSize = file.shardSize;
    if (!Number.isFinite(shardSize) || !shardSize || shardSize <= 0) throw new Error('Reed–Solomon shard size metadata is missing.');

    const available: Array<{ index: number; path: string }> = [];
    for (let index = 0; index < pool.memberGameIds.length; index += 1) {
        const memberId = pool.memberGameIds[index];
        if ((pool.inaccessibleGameIds ?? []).includes(memberId)) continue;
        const cloudRoot = cloudRoots[memberId];
        if (!cloudRoot) continue;
        const shardPath = shardPathInCloud(pool, file, index, cloudRoot);
        if (!shardPath) continue;
        try {
            const stat = await fsp.stat(shardPath);
            if (stat.isFile() && stat.size >= shardSize) available.push({ index, path: shardPath });
        } catch {
        }
    }
    if (available.length < layout.dataShards) {
        throw new Error(`Not enough Reed–Solomon shards remain to reconstruct “${file.name}”.`);
    }

    const selected = available.slice(0, layout.dataShards);
    const matrix = generatorMatrix(layout.dataShards + layout.parityShards, layout.dataShards);
    const decodeMatrix = invertMatrix(selected.map((item) => matrix[item.index].slice(0, layout.dataShards)));
    await fsp.mkdir(path.dirname(destination), { recursive: true });

    const inputs = await Promise.all(selected.map((item) => fsp.open(item.path, 'r')));
    const output = await fsp.open(destination, 'w');
    try {
        for (let offset = 0; offset < shardSize; offset += RS_IO_BLOCK) {
            const length = Math.min(RS_IO_BLOCK, shardSize - offset);
            const sourceBlocks: Buffer[] = [];
            for (const handle of inputs) {
                const block = Buffer.alloc(length);
                await handle.read(block, 0, length, offset);
                sourceBlocks.push(block);
            }

            for (let dataIndex = 0; dataIndex < layout.dataShards; dataIndex += 1) {
                const decoded = Buffer.alloc(length);
                const coefficients = decodeMatrix[dataIndex];
                for (let sourceIndex = 0; sourceIndex < sourceBlocks.length; sourceIndex += 1) {
                    const block = sourceBlocks[sourceIndex];
                    const coefficient = coefficients[sourceIndex];
                    if (coefficient === 0) continue;
                    if (coefficient === 1) {
                        for (let i = 0; i < length; i += 1) decoded[i] ^= block[i];
                    } else {
                        for (let i = 0; i < length; i += 1) decoded[i] ^= gfMul(coefficient, block[i]);
                    }
                }
                const absoluteOffset = dataIndex * shardSize + offset;
                if (absoluteOffset >= file.size) continue;
                const writable = Math.min(length, file.size - absoluteOffset);
                await output.write(decoded, 0, writable, absoluteOffset);
            }
        }
        await output.truncate(file.size);
    } finally {
        await output.close();
        await Promise.all(inputs.map((handle) => handle.close()));
    }

    const digest = await sha256File(destination);
    if (digest !== file.sha256) {
        await fsp.rm(destination, { force: true }).catch(() => undefined);
        throw new Error(`Reed–Solomon reconstruction failed integrity verification for “${file.name}”.`);
    }
}

async function reconstructPoolToStage(
    pool: ProtectedPool,
    cloudRoots: Partial<Record<GameId, string>>
): Promise<void> {
    const root = stageRoot(pool.id);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
    const originals = path.join(root, 'originals');
    const shards = path.join(root, 'shards');
    await fsp.mkdir(originals, { recursive: true });

    for (let index = 0; index < pool.files.length; index += 1) {
        const file = pool.files[index];
        const stagedOriginal = path.join(
            originals,
            `${String(index + 1).padStart(4, '0')}-${crypto.createHash('sha256').update(file.logicalPath).digest('hex').slice(0, 16)}-${path.basename(file.logicalPath)}`
        );
        await reconstructOriginalFromProtectedClouds(pool, file, cloudRoots, stagedOriginal);
        file.stageOriginal = stagedOriginal;
        if (pool.mode === 'reed-solomon') {
            if (!pool.layout) throw new Error('Reed–Solomon layout metadata is missing.');
            const encoded = await encodeReedSolomon(
                stagedOriginal,
                shards,
                crypto.createHash('sha256').update(file.logicalPath).digest('hex').slice(0, 24),
                pool.layout
            );
            file.shardFiles = encoded.shardFiles;
            file.shardSize = encoded.shardSize;
        }
    }
}

export async function prepareReplacementRepair(
    triggerGameId: GameId,
    corruptGameId: GameId,
    replacementGameId: GameId,
    cloudRoots: Partial<Record<GameId, string>>
): Promise<PreparedRepairPool[]> {
    const registry = await loadRegistry();
    const pools = activeProtectedPoolsForGame(registry, triggerGameId).filter((pool) =>
        (pool.inaccessibleGameIds ?? []).includes(corruptGameId)
    );
    if (pools.length === 0) throw new Error('No degraded protected pool requires this replacement.');
    if (replacementGameId === corruptGameId) throw new Error('Choose a different replacement Cloud.');

    for (const pool of pools) {
        const corruptIndex = pool.memberGameIds.indexOf(corruptGameId);
        if (corruptIndex < 0) continue;
        if (pool.memberGameIds.includes(replacementGameId)) {
            throw new Error('The replacement Cloud is already part of this protected pool.');
        }
        await reconstructPoolToStage(pool, cloudRoots);
        // The unavailable Cloud can still contain a stale Mirror replica or RS shard/manifest.
        // Queue its cleanup for the next time that Cloud becomes locally accessible.
        queueCleanupTask(registry, pool, corruptGameId);
        pool.memberGameIds[corruptIndex] = replacementGameId;
        pool.inaccessibleGameIds = (pool.inaccessibleGameIds ?? []).filter((id) => id !== corruptGameId && id !== replacementGameId);
        pool.syncedGameIds = [];
        pool.state = 'pending';
    }
    await saveRegistry();

    return pools.map((pool) => ({
        id: pool.id,
        mode: pool.mode,
        memberGameIds: [...pool.memberGameIds],
        layout: pool.layout ?? null,
        fileCount: pool.files.filter((file) => !pathMatchesPendingDeletion(pool, file.logicalPath)).length,
        totalBytes: pool.files.filter((file) => !pathMatchesPendingDeletion(pool, file.logicalPath)).reduce((sum, file) => sum + file.size, 0)
    }));
}

export async function prepareGatherRepair(
    triggerGameId: GameId,
    destinationGameId: GameId,
    cloudRoots: Partial<Record<GameId, string>>
): Promise<GatherRepairPlan> {
    const registry = await loadRegistry();
    const pools = activeProtectedPoolsForGame(registry, triggerGameId).filter((pool) => (pool.inaccessibleGameIds ?? []).length > 0);
    if (pools.length === 0) throw new Error('No degraded protected pool requires repair.');

    const planId = crypto.randomBytes(10).toString('hex');
    const root = repairPlanRoot(planId);
    const originals = path.join(root, 'originals');
    await fsp.mkdir(originals, { recursive: true });
    const files: GatherRepairPlanDisk['files'] = [];
    const seen = new Set<string>();

    for (const pool of pools) {
        const tempPoolRoot = path.join(root, 'pool-stage', pool.id);
        // Reconstruct directly into this repair plan so the existing pool registry remains untouched.
        for (let index = 0; index < pool.files.length; index += 1) {
            const file = pool.files[index];
            if (pathMatchesPendingDeletion(pool, file.logicalPath)) continue;
            const relativePath = file.logicalPath.startsWith(`${PROTECTED_LIBRARY_FOLDER}/`)
                ? file.logicalPath.slice(PROTECTED_LIBRARY_FOLDER.length + 1)
                : file.logicalPath;
            const collisionKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
            if (seen.has(collisionKey)) continue;
            seen.add(collisionKey);
            const destination = path.join(tempPoolRoot, `${String(index + 1).padStart(4, '0')}-${path.basename(relativePath)}`);
            await reconstructOriginalFromProtectedClouds(pool, file, cloudRoots, destination);
            const finalPath = path.join(originals, ...normalizePortable(relativePath).split('/'));
            await durableCopy(destination, finalPath);
            files.push({ source: finalPath, relativePath: normalizePortable(relativePath), size: file.size, sha256: file.sha256 });
        }
    }

    const plan: GatherRepairPlanDisk = {
        id: planId,
        triggerGameId,
        destinationGameId,
        poolIds: pools.map((pool) => pool.id),
        sourceGameIds: uniqueGameIds(pools.flatMap((pool) => pool.memberGameIds)),
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        files,
        cleanedGameIds: []
    };
    await fsp.writeFile(repairPlanFile(planId), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    return {
        id: plan.id,
        triggerGameId: plan.triggerGameId,
        destinationGameId: plan.destinationGameId,
        poolIds: [...plan.poolIds],
        sourceGameIds: [...plan.sourceGameIds],
        fileCount: plan.fileCount,
        totalBytes: plan.totalBytes
    };
}

async function loadGatherPlan(planId: string): Promise<GatherRepairPlanDisk> {
    const parsed = JSON.parse(await fsp.readFile(repairPlanFile(planId), 'utf8')) as GatherRepairPlanDisk;
    if (!parsed || parsed.id !== planId || !Array.isArray(parsed.files) || !Array.isArray(parsed.poolIds)) {
        throw new Error('Invalid protected repair plan.');
    }
    parsed.cleanedGameIds = Array.isArray(parsed.cleanedGameIds) ? parsed.cleanedGameIds : [];
    return parsed;
}

export async function applyGatherRepairToDestination(
    planId: string,
    gameId: GameId,
    cloudRoot: string,
    quotaBytes: number,
    maxFiles: number
): Promise<{ files: number; bytes: number }> {
    const plan = await loadGatherPlan(planId);
    if (plan.destinationGameId !== gameId) throw new Error('This Cloud is not the selected repair destination.');
    // Gather dissolves the protected pool. Recovered files become
    // ordinary VaporStow files at the selected Cloud root, preserving their
    // original relative paths but no longer living in the protected library.
    await cloudFs.importMappedFiles(
        cloudRoot,
        '',
        plan.files.map((file) => ({ source: file.source, relativePath: file.relativePath })),
        quotaBytes,
        maxFiles
    );
    return { files: plan.fileCount, bytes: plan.totalBytes };
}

export async function cleanupGatherRepairFromCloud(planId: string, gameId: GameId, cloudRoot: string): Promise<number> {
    const plan = await loadGatherPlan(planId);
    if (!plan.sourceGameIds.includes(gameId)) return 0;
    let removed = 0;
    const registry = await loadRegistry();
    for (const poolId of plan.poolIds) {
        const pool = registry.pools.find((candidate) => candidate.id === poolId);
        if (pool?.memberGameIds.includes(gameId) && pool.mode === 'mirror') {
            for (const file of pool.files) {
                if (pathMatchesPendingDeletion(pool, file.logicalPath)) continue;
                await cloudFs.deleteEntry(cloudRoot, file.logicalPath).catch(() => undefined);
            }
        }
        try {
            await cloudFs.deleteEntry(cloudRoot, `${cloudFs.PROTECTED_STORAGE_FOLDER}/${poolId}`);
            removed += 1;
        } catch {
        }
    }
    // The visible protected folder is reserved for active Mirror/RS data.
    // Never delete user data here: only prune it when it is actually empty.
    await cloudFs.pruneEmptyAuditSubtree(cloudRoot, PROTECTED_LIBRARY_FOLDER).catch(() => ({ removed: 0 }));
    if (!plan.cleanedGameIds.includes(gameId)) {
        plan.cleanedGameIds.push(gameId);
        await fsp.writeFile(repairPlanFile(planId), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    }
    return removed;
}

export async function cleanupRetiredPoolsFromCloud(gameId: GameId, cloudRoot: string): Promise<{ removed: number }> {
    const registry = await loadRegistry();
    const retired = [...new Set(registry.retiredPoolIds ?? [])];
    let removed = 0;

    const pendingTasks = [...(registry.cleanupTasks ?? [])];
    const completed = new Set<string>();
    for (const task of pendingTasks) {
        if (task.gameId !== gameId) continue;
        if (task.mode === 'mirror') {
            for (const logicalPath of task.logicalPaths) {
                await cloudFs.deleteEntry(cloudRoot, logicalPath).catch(() => undefined);
            }
        }
        await cloudFs.deleteEntry(cloudRoot, `${cloudFs.PROTECTED_STORAGE_FOLDER}/${task.poolId}`).catch(() => undefined);
        completed.add(`${task.poolId}:${task.gameId}`);
        removed += 1;
    }
    if (completed.size > 0) {
        registry.cleanupTasks = (registry.cleanupTasks ?? []).filter((task) => !completed.has(`${task.poolId}:${task.gameId}`));
        await saveRegistry();
    }

    // Retired IDs are also removed defensively. This is especially useful for
    // old RS manifests and for installs upgraded from an earlier 1.0.2 build.
    for (const poolId of retired) {
        try {
            await cloudFs.deleteEntry(cloudRoot, `${cloudFs.PROTECTED_STORAGE_FOLDER}/${poolId}`);
            removed += 1;
        } catch {
            // Missing retired pool data is the expected steady state.
        }
    }
    await cloudFs.pruneEmptyAuditSubtree(cloudRoot, PROTECTED_LIBRARY_FOLDER).catch(() => ({ removed: 0 }));
    return { removed };
}

export async function finalizeGatherRepair(planId: string): Promise<boolean> {
    const plan = await loadGatherPlan(planId);
    const registry = await loadRegistry();
    const poolIds = new Set(plan.poolIds);
    const retiredPools = registry.pools.filter((pool) => poolIds.has(pool.id));
    const cleaned = new Set(plan.cleanedGameIds ?? []);
    for (const pool of retiredPools) {
        for (const memberId of pool.memberGameIds) {
            if (!cleaned.has(memberId)) queueCleanupTask(registry, pool, memberId);
        }
    }
    registry.pools = registry.pools.filter((pool) => !poolIds.has(pool.id));
    registry.retiredPoolIds = [...new Set([...(registry.retiredPoolIds ?? []), ...poolIds])];
    await saveRegistry();
    for (const poolId of poolIds) await fsp.rm(stageRoot(poolId), { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(repairPlanRoot(planId), { recursive: true, force: true }).catch(() => undefined);
    return true;
}
