import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const AUDIT_FOLDER = 'CloudAudit';
export const MAX_SYNC_FILE_BYTES = 100 * 1024 * 1024;
export const SYNC_CHUNK_BYTES = 95 * 1024 * 1024;
export const SPLIT_STORAGE_FOLDER = 'VaporStow.parts';
const SPLIT_MANIFEST_FILE = 'manifest.vstow.json';
const SPLIT_MANIFEST_VERSION = 2;
const SPLIT_STAGING_PREFIX = `${SPLIT_STORAGE_FOLDER}.staging-`;
const SPLIT_RESTORE_POLL_MS = 400;
const SPLIT_RESTORE_STABLE_MS = 1500;
// Tolérer les longues sync tant qu'une activité de download ou rebuild reste visible.
const SPLIT_RESTORE_STALL_TIMEOUT_MS = 30 * 60 * 1000;
const SPLIT_RESTORE_MAX_MS = 6 * 60 * 60 * 1000;
const SPLIT_IO_BUFFER_BYTES = 4 * 1024 * 1024;

type SplitManifestPart = {
    file: string;
    size: number;
    // Garder les hashes optionnels pour migrer les manifests v1 sans renommer les parts.
    sha256?: string;
};

type SplitManifestEntry = {
    path: string;
    size: number;
    sha256: string;
    parts: SplitManifestPart[];
};

type SplitManifest = {
    version: 1 | 2;
    chunkBytes: number;
    createdAt: string;
    files: SplitManifestEntry[];
};

export type SplitPreparationResult = {
    splitFiles: number;
    parts: number;
    reusedParts: number;
    rewrittenParts: number;
    maxFileBytes: number;
    chunkBytes: number;
};

export type SplitRestoreResult = {
    restoredFiles: number;
    detected: boolean;
    cachedParts: number;
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

export type SplitRestoreProgressHandler = (progress: SplitRestoreProgress) => void;

// Gestion du format split et de son cache.

function isSplitInternalName(name: string): boolean {
    return name === SPLIT_STORAGE_FOLDER || name.startsWith(SPLIT_STAGING_PREFIX);
}

function splitStorageRoot(cloudRoot: string): string {
    return path.join(auditRoot(cloudRoot), SPLIT_STORAGE_FOLDER);
}

function splitManifestPath(cloudRoot: string): string {
    return path.join(splitStorageRoot(cloudRoot), SPLIT_MANIFEST_FILE);
}

function manifestPathIn(storageRoot: string): string {
    return path.join(storageRoot, SPLIT_MANIFEST_FILE);
}

function fromPortableRelative(relativePath: string): string {
    const parts = relativePath.split('/').filter(Boolean);
    return parts.join(path.sep);
}

function isSafePartFileName(file: string): boolean {
    return Boolean(file)
        && path.basename(file) === file
        && file.endsWith('.vstowpart')
        && !file.includes('/')
        && !file.includes('\\');
}

function stablePartName(relativePath: string, partIndex: number): string {
    const id = crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 32);
    return `${id}.${String(partIndex + 1).padStart(4, '0')}.vstowpart`;
}

function safePartPath(storageRoot: string, file: string): string {
    if (!isSafePartFileName(file)) throw new Error('Split-file manifest contains an invalid part filename.');
    const resolvedRoot = path.resolve(storageRoot);
    const resolved = path.resolve(storageRoot, file);
    if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error('Split-file manifest contains an invalid part path.');
    }
    return resolved;
}

async function removeSplitStaging(cloudRoot: string): Promise<void> {
    const root = auditRoot(cloudRoot);
    let entries: fs.Dirent[] = [];
    try {
        entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
        return;
    }

    await Promise.all(
        entries
            .filter((entry) => entry.isDirectory() && entry.name.startsWith(SPLIT_STAGING_PREFIX))
            .map((entry) => fsp.rm(path.join(root, entry.name), { recursive: true, force: true }))
    );
}

async function readManifestAt(storageRoot: string): Promise<SplitManifest | null> {
    try {
        const parsed = JSON.parse(await fsp.readFile(manifestPathIn(storageRoot), 'utf8')) as Partial<SplitManifest>;
        if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.files)) {
            throw new Error('Unsupported VaporStow split-file manifest.');
        }
        if (typeof parsed.chunkBytes !== 'number' || parsed.chunkBytes <= 0 || typeof parsed.createdAt !== 'string') {
            throw new Error('Damaged VaporStow split-file manifest.');
        }
        return parsed as SplitManifest;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function readSplitManifest(cloudRoot: string): Promise<SplitManifest | null> {
    return readManifestAt(splitStorageRoot(cloudRoot));
}

type SplitPartObservation = {
    signature: string;
    stableSince: number;
};

type SplitPartReadyInfo = {
    path: string;
    stat: fs.Stats;
};

async function inspectSplitPart(
    storageRoot: string,
    part: SplitManifestPart,
    observation: SplitPartObservation | undefined,
    now: number
): Promise<{ ready: SplitPartReadyInfo | null; observation: SplitPartObservation; changed: boolean; presentBytes: number }> {
    if (!part || typeof part.file !== 'string' || typeof part.size !== 'number' || part.size < 0) {
        throw new Error('Damaged split-part metadata.');
    }

    const partPath = safePartPath(storageRoot, part.file);
    try {
        const stat = await fsp.stat(partPath);
        if (!stat.isFile()) {
            const signature = `${part.file}:not-file`;
            return {
                ready: null,
                observation: { signature, stableSince: observation?.signature === signature ? observation.stableSince : now },
                changed: observation?.signature !== signature,
                presentBytes: 0
            };
        }

        const presentBytes = Math.min(Math.max(0, stat.size), part.size);
        const signature = `${part.file}:${stat.size}:${stat.mtimeMs}`;
        const same = observation?.signature === signature;
        const stableSince = same ? observation!.stableSince : now;
        const nextObservation = { signature, stableSince };
        const ready = stat.size === part.size && now - stableSince >= SPLIT_RESTORE_STABLE_MS
            ? { path: partPath, stat }
            : null;

        return {
            ready,
            observation: nextObservation,
            changed: !same,
            presentBytes
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const signature = `${part.file}:missing`;
        return {
            ready: null,
            observation: { signature, stableSince: observation?.signature === signature ? observation.stableSince : now },
            changed: observation?.signature !== signature,
            presentBytes: 0
        };
    }
}

async function sha256FileWithProgress(
    target: string,
    onBytes?: (bytes: number) => void
): Promise<string> {
    const hash = crypto.createHash('sha256');
    const handle = await fsp.open(target, 'r');
    const buffer = Buffer.allocUnsafe(SPLIT_IO_BUFFER_BYTES);
    let offset = 0;
    try {
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (bytesRead <= 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
            onBytes?.(bytesRead);
        }
    } finally {
        await handle.close();
    }
    return hash.digest('hex');
}

async function sha256File(target: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const handle = await fsp.open(target, 'r');
    const buffer = Buffer.allocUnsafe(SPLIT_IO_BUFFER_BYTES);
    let offset = 0;
    try {
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (bytesRead <= 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
    } finally {
        await handle.close();
    }
    return hash.digest('hex');
}

async function hashSourceRange(
    handle: fsp.FileHandle,
    start: number,
    size: number,
    wholeHash?: ReturnType<typeof crypto.createHash>
): Promise<string> {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(SPLIT_IO_BUFFER_BYTES);
    let offset = 0;

    while (offset < size) {
        const wanted = Math.min(buffer.length, size - offset);
        const { bytesRead } = await handle.read(buffer, 0, wanted, start + offset);
        if (bytesRead <= 0) throw new Error('Unexpected end of file while hashing a split chunk.');
        const data = buffer.subarray(0, bytesRead);
        hash.update(data);
        wholeHash?.update(data);
        offset += bytesRead;
    }

    return hash.digest('hex');
}

async function writeSourceRange(
    handle: fsp.FileHandle,
    start: number,
    size: number,
    destination: string
): Promise<void> {
    const out = await fsp.open(destination, 'wx');
    const buffer = Buffer.allocUnsafe(SPLIT_IO_BUFFER_BYTES);
    let offset = 0;
    try {
        while (offset < size) {
            const wanted = Math.min(buffer.length, size - offset);
            const { bytesRead } = await handle.read(buffer, 0, wanted, start + offset);
            if (bytesRead <= 0) throw new Error('Unexpected end of file while writing a split chunk.');
            await out.write(buffer, 0, bytesRead, offset);
            offset += bytesRead;
        }
        // Persister la transaction avant de retirer l'original et lancer la sync AC Exit.
        await out.sync();
    } finally {
        await out.close();
    }
}

async function cloneFilePreservingMetadata(source: string, destination: string): Promise<void> {
    try {
        await fsp.link(source, destination);
        return;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(code || '')) throw error;
    }

    const stat = await fsp.stat(source);
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    // Préserver le mtime pour conserver l'identité Cloud d'un fichier inchangé.
    await fsp.utimes(destination, stat.atime, stat.mtime);
}

async function replaceDirectory(source: string, destination: string): Promise<void> {
    await ensureDir(path.dirname(destination));
    const incoming = `${destination}.incoming-${crypto.randomUUID()}`;
    await fsp.rm(incoming, { recursive: true, force: true });

    let moved = false;
    try {
        try {
            await fsp.rename(source, incoming);
            moved = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            await fsp.cp(source, incoming, { recursive: true, preserveTimestamps: true, errorOnExist: true });
        }

        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(incoming, destination);
        if (!moved) await fsp.rm(source, { recursive: true, force: true });
    } catch (error) {
        await fsp.rm(incoming, { recursive: true, force: true });
        throw error;
    }
}

function cachedEntryFor(manifest: SplitManifest | null, relativePath: string): SplitManifestEntry | null {
    if (!manifest) return null;
    return manifest.files.find((entry) => entry.path === relativePath) || null;
}

async function cachedPartHash(cacheRoot: string, part: SplitManifestPart): Promise<string | null> {
    try {
        const target = safePartPath(cacheRoot, part.file);
        const stat = await fsp.stat(target);
        if (!stat.isFile() || stat.size !== part.size) return null;
        if (part.sha256) return part.sha256;
        return sha256File(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function writeFileInChunksIncremental(
    source: string,
    stagingRoot: string,
    cacheRoot: string | null,
    cachedManifest: SplitManifest | null,
    relativePath: string,
    size: number
): Promise<{ entry: SplitManifestEntry; reusedParts: number; rewrittenParts: number }> {
    const cachedEntry = cachedEntryFor(cachedManifest, relativePath);
    const sourceHandle = await fsp.open(source, 'r');
    const initialStat = await sourceHandle.stat();
    const wholeHash = crypto.createHash('sha256');
    const parts: SplitManifestPart[] = [];
    let sourceOffset = 0;
    let partIndex = 0;
    let reusedParts = 0;
    let rewrittenParts = 0;

    try {
        while (sourceOffset < size) {
            const partSize = Math.min(SYNC_CHUNK_BYTES, size - sourceOffset);
            const previous = cachedEntry?.parts[partIndex];
            // Réutiliser le filename précédent pour garder la même identité remote.
            const partName = previous && isSafePartFileName(previous.file)
                ? previous.file
                : stablePartName(relativePath, partIndex);
            const partPath = path.join(stagingRoot, partName);
            const sourcePartHash = await hashSourceRange(sourceHandle, sourceOffset, partSize, wholeHash);

            let reused = false;
            if (cacheRoot && previous && previous.size === partSize) {
                const previousHash = await cachedPartHash(cacheRoot, previous);
                if (previousHash === sourcePartHash) {
                    const cachedPartPath = safePartPath(cacheRoot, previous.file);
                    await cloneFilePreservingMetadata(cachedPartPath, partPath);
                    reused = true;
                    reusedParts += 1;
                }
            }

            if (!reused) {
                await writeSourceRange(sourceHandle, sourceOffset, partSize, partPath);
                rewrittenParts += 1;
            }

            parts.push({ file: partName, size: partSize, sha256: sourcePartHash });
            sourceOffset += partSize;
            partIndex += 1;
        }

        const finalStat = await sourceHandle.stat();
        if (finalStat.size !== initialStat.size || finalStat.mtimeMs !== initialStat.mtimeMs) {
            throw new Error(`“${relativePath}” changed while VaporStow was preparing its chunks. Try synchronizing again.`);
        }
    } finally {
        await sourceHandle.close();
    }

    return {
        entry: {
            path: relativePath,
            size,
            sha256: wholeHash.digest('hex'),
            parts
        },
        reusedParts,
        rewrittenParts
    };
}

function manifestsEquivalent(a: SplitManifest | null, b: SplitManifest): boolean {
    if (!a || a.version !== 2 || a.chunkBytes !== b.chunkBytes || a.files.length !== b.files.length) return false;
    for (let i = 0; i < a.files.length; i += 1) {
        const left = a.files[i];
        const right = b.files[i];
        if (left.path !== right.path || left.size !== right.size || left.sha256 !== right.sha256 || left.parts.length !== right.parts.length) {
            return false;
        }
        for (let j = 0; j < left.parts.length; j += 1) {
            const lp = left.parts[j];
            const rp = right.parts[j];
            if (lp.file !== rp.file || lp.size !== rp.size || lp.sha256 !== rp.sha256) return false;
        }
    }
    return true;
}

async function cacheCompleteSplitRepresentation(
    storageRoot: string,
    cacheRoot: string,
    manifest: SplitManifest,
    cachedManifest: SplitManifest | null
): Promise<void> {
    await ensureDir(path.dirname(cacheRoot));
    const incoming = `${cacheRoot}.incoming-${crypto.randomUUID()}`;
    await fsp.rm(incoming, { recursive: true, force: true });
    await ensureDir(incoming);

    try {
        for (const entry of manifest.files) {
            const cachedEntry = cachedManifest?.files.find((candidate) =>
                candidate.path === entry.path
                && candidate.size === entry.size
                && candidate.sha256 === entry.sha256
                && candidate.parts.length === entry.parts.length
            ) || null;

            for (let partIndex = 0; partIndex < entry.parts.length; partIndex += 1) {
                const part = entry.parts[partIndex];
                const cloudCandidate = safePartPath(storageRoot, part.file);
                const oldCachedPart = cachedEntry?.parts[partIndex];
                const cacheCandidate = oldCachedPart && oldCachedPart.size === part.size && isSafePartFileName(oldCachedPart.file)
                    ? safePartPath(cacheRoot, oldCachedPart.file)
                    : safePartPath(cacheRoot, part.file);
                let source: string | null = null;

                for (const candidate of [cloudCandidate, cacheCandidate]) {
                    try {
                        const stat = await fsp.stat(candidate);
                        if (stat.isFile() && stat.size === part.size) {
                            source = candidate;
                            break;
                        }
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                }

                if (!source) {
                    throw new Error(`Unable to cache split part “${part.file}” after reconstruction.`);
                }
                await cloneFilePreservingMetadata(source, path.join(incoming, part.file));
            }
        }

        const sourceManifest = manifestPathIn(storageRoot);
        try {
            await cloneFilePreservingMetadata(sourceManifest, manifestPathIn(incoming));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await fsp.writeFile(manifestPathIn(incoming), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        }

        await fsp.rm(cacheRoot, { recursive: true, force: true });
        await fsp.rename(incoming, cacheRoot);
        await fsp.rm(storageRoot, { recursive: true, force: true });
    } catch (error) {
        await fsp.rm(incoming, { recursive: true, force: true });
        throw error;
    }
}

// Reconstruction transactionnelle des fichiers split.

export async function restoreSplitFiles(
    cloudRoot: string,
    cacheRoot?: string,
    onProgress?: SplitRestoreProgressHandler
): Promise<SplitRestoreResult> {
    await removeSplitStaging(cloudRoot);
    const manifest = await readSplitManifest(cloudRoot);
    const storageRoot = splitStorageRoot(cloudRoot);
    const cachedManifest = cacheRoot ? await readManifestAt(cacheRoot) : null;

    const emit = (progress: SplitRestoreProgress) => {
        try { onProgress?.(progress); } catch { /* Le callback UI ne doit jamais interrompre le restore. */ }
    };

    if (!manifest) {
        if (fs.existsSync(storageRoot)) {
            throw new Error('Split-file data was found, but its VaporStow manifest is missing.');
        }
        emit({
            state: 'complete',
            percent: 100,
            processedBytes: 0,
            totalBytes: 0,
            completedFiles: 0,
            totalFiles: 0,
            receivedParts: 0,
            completedParts: 0,
            totalParts: 0,
            currentFileIndex: null,
            currentFileReceivedParts: 0,
            currentFileCompletedParts: 0,
            currentFileTotalParts: 0,
            cachedPartsUsed: 0,
            idleSeconds: null,
            speedBytesPerSecond: null,
            etaSeconds: 0,
            currentFile: null,
            message: 'No split files to rebuild.'
        });
        return { restoredFiles: 0, detected: false, cachedParts: 0 };
    }

    const root = path.resolve(auditRoot(cloudRoot));
    const totalFiles = manifest.files.length;
    const totalBytes = manifest.files.reduce((sum, entry) => sum + Math.max(0, Number(entry?.size) || 0), 0);
    const totalParts = manifest.files.reduce((sum, entry) => sum + (Array.isArray(entry?.parts) ? entry.parts.length : 0), 0);
    let restoredFiles = 0;
    let completedFiles = 0;
    let completedParts = 0;
    let receivedParts = 0;
    let processedBytes = 0;
    let rebuildBytes = 0;
    let cachedPartsUsed = 0;
    let currentFileIndex: number | null = totalFiles > 0 ? 1 : null;
    let currentFileReceivedParts = 0;
    let currentFileCompletedParts = 0;
    let currentFileTotalParts = manifest.files[0]?.parts?.length || 0;
    let currentIdleSeconds: number | null = null;
    const speedSamples: Array<{ at: number; bytes: number }> = [];

    const currentSpeed = (): number | null => {
        if (speedSamples.length < 2) return null;
        const first = speedSamples[0];
        const last = speedSamples[speedSamples.length - 1];
        const elapsed = (last.at - first.at) / 1000;
        if (elapsed <= 0.2 || last.bytes <= first.bytes) return null;
        return (last.bytes - first.bytes) / elapsed;
    };

    const report = (
        state: SplitRestoreProgress['state'],
        message: string,
        currentFile: string | null,
        speedOverride?: number | null
    ) => {
        const speed = speedOverride === undefined ? currentSpeed() : speedOverride;
        const percent = totalBytes > 0 ? Math.max(0, Math.min(100, (processedBytes / totalBytes) * 100)) : 100;
        const remaining = Math.max(0, totalBytes - processedBytes);
        const etaSeconds = speed && speed > 0 ? remaining / speed : (remaining === 0 ? 0 : null);
        emit({
            state,
            percent,
            processedBytes,
            totalBytes,
            completedFiles,
            totalFiles,
            receivedParts,
            completedParts,
            totalParts,
            currentFileIndex,
            currentFileReceivedParts,
            currentFileCompletedParts,
            currentFileTotalParts,
            cachedPartsUsed,
            idleSeconds: currentIdleSeconds,
            speedBytesPerSecond: speed,
            etaSeconds,
            currentFile,
            message
        });
    };

    const recordRebuiltBytes = (bytes: number, currentFile: string) => {
        if (bytes <= 0) return;
        processedBytes += bytes;
        rebuildBytes += bytes;
        currentIdleSeconds = null;
        const now = Date.now();
        speedSamples.push({ at: now, bytes: rebuildBytes });
        const cutoff = now - 8000;
        while (speedSamples.length > 2 && speedSamples[0].at < cutoff) speedSamples.shift();
        report('rebuilding', 'Rebuilding split file…', currentFile);
    };

    report('waiting', 'Preparing split files…', manifest.files[0]?.path || null, null);

    for (let entryIndex = 0; entryIndex < manifest.files.length; entryIndex += 1) {
        const entry = manifest.files[entryIndex];
        if (!entry || typeof entry.path !== 'string' || !Array.isArray(entry.parts) || !entry.sha256) {
            throw new Error('Damaged VaporStow split-file manifest.');
        }

        currentFileIndex = entryIndex + 1;
        currentFileTotalParts = entry.parts.length;
        currentFileReceivedParts = 0;
        currentFileCompletedParts = 0;
        currentIdleSeconds = null;

        const destination = path.resolve(root, fromPortableRelative(entry.path));
        if (destination === root || !destination.startsWith(`${root}${path.sep}`)) {
            throw new Error('Split-file manifest contains an invalid destination path.');
        }

        report('waiting', 'Checking existing file…', entry.path, null);

        let alreadyRestored = false;
        try {
            const existing = await fsp.stat(destination);
            if (existing.isFile() && existing.size === entry.size) {
                let checked = 0;
                let lastCheckReport = 0;
                const existingHash = await sha256FileWithProgress(destination, (bytes) => {
                    checked += bytes;
                    const now = Date.now();
                    if (now - lastCheckReport >= 120 || checked >= entry.size) {
                        const checkPercent = entry.size > 0 ? Math.min(100, Math.round((checked / entry.size) * 100)) : 100;
                        report('waiting', `Checking existing file · ${checkPercent}%`, entry.path, null);
                        lastCheckReport = now;
                    }
                });
                alreadyRestored = existingHash === entry.sha256;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        if (!alreadyRestored) {
            await ensureDir(path.dirname(destination));
            const temporary = path.join(storageRoot, `restore-${crypto.randomUUID()}.tmp`);
            const out = await fsp.open(temporary, 'wx+');
            const partOffsets: number[] = [];
            let expectedSize = 0;
            for (const part of entry.parts) {
                if (!part || typeof part.file !== 'string' || typeof part.size !== 'number' || part.size < 0) {
                    await out.close();
                    await fsp.rm(temporary, { force: true });
                    throw new Error(`Damaged part metadata for “${entry.path}”.`);
                }
                partOffsets.push(expectedSize);
                expectedSize += part.size;
            }
            if (expectedSize !== entry.size) {
                await out.close();
                await fsp.rm(temporary, { force: true });
                throw new Error(`Split-part sizes do not match “${entry.path}”.`);
            }

            await out.truncate(entry.size);
            const pending = new Set(entry.parts.map((_, index) => index));
            const cloudObservations = new Map<number, SplitPartObservation>();
            const invalidCachedParts = new Set<number>();
            const matchingCachedEntry = cachedManifest?.files.find((candidate) =>
                candidate.path === entry.path
                && candidate.size === entry.size
                && candidate.sha256 === entry.sha256
                && candidate.parts.length === entry.parts.length
            ) || null;
            const restoreStartedAt = Date.now();
            let lastActivityAt = restoreStartedAt;
            let previousPresentBytes = -1;

            try {
                while (pending.size > 0) {
                    const now = Date.now();
                    if (now - restoreStartedAt > SPLIT_RESTORE_MAX_MS) {
                        throw new Error(`Split-file restore exceeded the maximum session time for “${entry.path}”.`);
                    }

                    const readyParts: Array<{ index: number; info: SplitPartReadyInfo; source: 'steam' | 'cache' }> = [];
                    let completeAvailable = 0;
                    let presentBytes = 0;
                    let observedChange = false;

                    for (const partIndex of pending) {
                        const part = entry.parts[partIndex];
                        const inspected = await inspectSplitPart(
                            storageRoot,
                            part,
                            cloudObservations.get(partIndex),
                            now
                        );
                        cloudObservations.set(partIndex, inspected.observation);
                        observedChange ||= inspected.changed;
                        let availableBytes = inspected.presentBytes;
                        let available = inspected.presentBytes === part.size;

                        if (inspected.ready) {
                            readyParts.push({ index: partIndex, info: inspected.ready, source: 'steam' });
                        } else if (cacheRoot && matchingCachedEntry && !invalidCachedParts.has(partIndex)) {
                            const cachedPart = matchingCachedEntry.parts[partIndex];
                            if (cachedPart && cachedPart.size === part.size && isSafePartFileName(cachedPart.file)) {
                                try {
                                    const cachedPath = safePartPath(cacheRoot, cachedPart.file);
                                    const cachedStat = await fsp.stat(cachedPath);
                                    if (cachedStat.isFile() && cachedStat.size === part.size) {
                                        // Valider le cache par SHA-256 complet et vérifier chaque part en v2.
                                        let cacheValid = true;
                                        if (part.sha256) {
                                            if (cachedPart.sha256) {
                                                cacheValid = cachedPart.sha256 === part.sha256;
                                            } else {
                                                cacheValid = (await sha256File(cachedPath)) === part.sha256;
                                            }
                                        }
                                        if (cacheValid) {
                                            readyParts.push({ index: partIndex, info: { path: cachedPath, stat: cachedStat }, source: 'cache' });
                                            availableBytes = Math.max(availableBytes, part.size);
                                            available = true;
                                        } else {
                                            invalidCachedParts.add(partIndex);
                                        }
                                    }
                                } catch (error) {
                                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                                }
                            }
                        }

                        presentBytes += availableBytes;
                        if (available) completeAvailable += 1;
                    }

                    const rebuiltForFile = entry.parts.length - pending.size;
                    currentFileCompletedParts = rebuiltForFile;
                    currentFileReceivedParts = Math.min(entry.parts.length, rebuiltForFile + completeAvailable);
                    receivedParts = Math.max(receivedParts, completedParts + completeAvailable);

                    if (observedChange || presentBytes !== previousPresentBytes || readyParts.length > 0) {
                        lastActivityAt = now;
                        previousPresentBytes = presentBytes;
                    }

                    if (readyParts.length === 0) {
                        currentIdleSeconds = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
                        if (now - lastActivityAt > SPLIT_RESTORE_STALL_TIMEOUT_MS) {
                            const missing = pending.size;
                            throw new Error(
                                `Steam Cloud stopped delivering split data for “${entry.path}”. ` +
                                `${missing} part${missing === 1 ? '' : 's'} are still missing after 30 minutes without progress.`
                            );
                        }

                        report('waiting', 'Waiting for Steam Cloud…', entry.path, null);
                        await new Promise((resolve) => setTimeout(resolve, SPLIT_RESTORE_POLL_MS));
                        continue;
                    }

                    currentIdleSeconds = null;
                    // Exclure l'attente Steam du calcul de vitesse du rebuild.
                    if (Date.now() - lastActivityAt > 1500) speedSamples.length = 0;

                    for (const { index: partIndex, info, source } of readyParts) {
                        if (!pending.has(partIndex)) continue;
                        const part = entry.parts[partIndex];
                        const input = await fsp.open(info.path, 'r');
                        const partHash = crypto.createHash('sha256');
                        const buffer = Buffer.allocUnsafe(SPLIT_IO_BUFFER_BYTES);
                        let partOffset = 0;

                        report('rebuilding', 'Rebuilding split file…', entry.path);

                        try {
                            while (partOffset < part.size) {
                                const wanted = Math.min(buffer.length, part.size - partOffset);
                                const { bytesRead } = await input.read(buffer, 0, wanted, partOffset);
                                if (bytesRead <= 0) throw new Error(`Unexpected end of split part for “${entry.path}”.`);
                                const data = buffer.subarray(0, bytesRead);
                                partHash.update(data);
                                await out.write(data, 0, bytesRead, partOffsets[partIndex] + partOffset);
                                partOffset += bytesRead;
                                recordRebuiltBytes(bytesRead, entry.path);
                            }
                        } finally {
                            await input.close();
                        }

                        const after = await fsp.stat(info.path);
                        if (after.size !== info.stat.size || after.mtimeMs !== info.stat.mtimeMs) {
                            if (source === 'cache') {
                                invalidCachedParts.add(partIndex);
                                continue;
                            }
                            throw new Error(`Steam changed split part “${part.file}” while VaporStow was rebuilding it.`);
                        }
                        if (part.sha256 && partHash.digest('hex') !== part.sha256) {
                            if (source === 'cache') {
                                invalidCachedParts.add(partIndex);
                                continue;
                            }
                            throw new Error(`Integrity verification failed for split part “${part.file}”.`);
                        }

                        pending.delete(partIndex);
                        cloudObservations.delete(partIndex);
                        completedParts += 1;
                        currentFileCompletedParts = entry.parts.length - pending.size;
                        currentFileReceivedParts = Math.max(currentFileReceivedParts, currentFileCompletedParts);
                        receivedParts = Math.max(receivedParts, completedParts);
                        if (source === 'cache') cachedPartsUsed += 1;
                        lastActivityAt = Date.now();
                    }
                }

                await out.sync();
            } catch (error) {
                await out.close();
                await fsp.rm(temporary, { force: true });
                throw error;
            }

            await out.close();

            const everyPartHasHash = entry.parts.every((part) => Boolean(part.sha256));
            if (!everyPartHasHash) {
                let verified = 0;
                let lastVerifyReport = 0;
                const rebuiltHash = await sha256FileWithProgress(temporary, (bytes) => {
                    verified += bytes;
                    const now = Date.now();
                    if (now - lastVerifyReport >= 120 || verified >= entry.size) {
                        const verifyPercent = entry.size > 0 ? Math.min(100, Math.round((verified / entry.size) * 100)) : 100;
                        report('rebuilding', `Verifying restored file · ${verifyPercent}%`, entry.path, null);
                        lastVerifyReport = now;
                    }
                });
                if (rebuiltHash !== entry.sha256) {
                    await fsp.rm(temporary, { force: true });
                    throw new Error(`Integrity verification failed while restoring “${entry.path}”.`);
                }
            }

            try {
                await fsp.rm(destination, { force: true });
                await fsp.rename(temporary, destination);
            } catch (error) {
                await fsp.rm(temporary, { force: true });
                throw error;
            }
            restoredFiles += 1;
        } else {
            processedBytes += entry.size;
            completedParts += entry.parts.length;
            receivedParts = Math.max(receivedParts, completedParts);
            currentFileReceivedParts = entry.parts.length;
            currentFileCompletedParts = entry.parts.length;
        }

        completedFiles += 1;
        currentIdleSeconds = null;
        report('rebuilding', 'Split file rebuilt.', null);
    }

    processedBytes = totalBytes;
    currentFileIndex = null;
    currentFileReceivedParts = 0;
    currentFileCompletedParts = 0;
    currentFileTotalParts = 0;
    currentIdleSeconds = null;
    report('caching', cachedPartsUsed > 0 ? 'Finalizing split cache…' : 'Caching split parts…', null);

    const cachedParts = manifest.files.reduce((sum, entry) => sum + entry.parts.length, 0);
    if (cacheRoot) {
        // Fusionner les parts téléchargées avec le cache exact déjà disponible.
        await cacheCompleteSplitRepresentation(storageRoot, cacheRoot, manifest, cachedManifest);
    } else {
        await fsp.rm(storageRoot, { recursive: true, force: true });
    }

    emit({
        state: 'complete',
        percent: 100,
        processedBytes: totalBytes,
        totalBytes,
        completedFiles: totalFiles,
        totalFiles,
        receivedParts: totalParts,
        completedParts: totalParts,
        totalParts,
        currentFileIndex: null,
        currentFileReceivedParts: 0,
        currentFileCompletedParts: 0,
        currentFileTotalParts: 0,
        cachedPartsUsed,
        idleSeconds: null,
        speedBytesPerSecond: currentSpeed(),
        etaSeconds: 0,
        currentFile: null,
        message: 'Split files rebuilt.'
    });

    return { restoredFiles, detected: true, cachedParts };
}

// Préparation transactionnelle avant synchronisation.

export async function prepareSplitFilesForSync(
    cloudRoot: string,
    maxBytes: number,
    maxFiles: number,
    cacheRoot?: string
): Promise<SplitPreparationResult> {
    // Restaurer d'abord toute transaction de split active de façon idempotente.
    await restoreSplitFiles(cloudRoot, cacheRoot);
    await removeSplitStaging(cloudRoot);

    const root = auditRoot(cloudRoot);
    await ensureDir(root);
    const oversized = await filesOverLimit(cloudRoot, MAX_SYNC_FILE_BYTES);
    if (oversized.length === 0) {
        if (cacheRoot) await fsp.rm(cacheRoot, { recursive: true, force: true });
        return {
            splitFiles: 0,
            parts: 0,
            reusedParts: 0,
            rewrittenParts: 0,
            maxFileBytes: MAX_SYNC_FILE_BYTES,
            chunkBytes: SYNC_CHUNK_BYTES
        };
    }

    const cachedManifest = cacheRoot ? await readManifestAt(cacheRoot) : null;
    const current = await treeStats(cloudRoot);
    const totalParts = oversized.reduce((sum, file) => sum + Math.ceil(file.size / SYNC_CHUNK_BYTES), 0);
    const projectedFiles = current.files - oversized.length + totalParts + 1;
    if (projectedFiles > maxFiles) {
        throw new Error(
            `Splitting these files would need ${projectedFiles.toLocaleString()} cloud file slots, above the ${maxFiles.toLocaleString()}-file limit.`
        );
    }

    const stagingRoot = path.join(root, `${SPLIT_STAGING_PREFIX}${crypto.randomUUID()}`);
    await ensureDir(stagingRoot);
    const manifest: SplitManifest = {
        version: SPLIT_MANIFEST_VERSION,
        chunkBytes: SYNC_CHUNK_BYTES,
        createdAt: cachedManifest?.createdAt || new Date().toISOString(),
        files: []
    };
    let reusedParts = 0;
    let rewrittenParts = 0;

    try {
        // Trier les paths pour garder un manifest stable si le contenu ne change pas.
        const stableOversized = [...oversized].sort((a, b) => a.path.localeCompare(b.path));
        for (const file of stableOversized) {
            const source = safeAuditPath(cloudRoot, file.path);
            const result = await writeFileInChunksIncremental(
                source,
                stagingRoot,
                cacheRoot || null,
                cachedManifest,
                file.path,
                file.size
            );
            manifest.files.push(result.entry);
            reusedParts += result.reusedParts;
            rewrittenParts += result.rewrittenParts;
        }

        const equivalent = manifestsEquivalent(cachedManifest, manifest);
        const manifestTarget = path.join(stagingRoot, SPLIT_MANIFEST_FILE);
        if (equivalent && cacheRoot) {
            // Préserver aussi le mtime du manifest lorsqu'aucune part ne change.
            await cloneFilePreservingMetadata(manifestPathIn(cacheRoot), manifestTarget);
        } else {
            manifest.createdAt = new Date().toISOString();
            const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
            const projectedBytes = current.bytes + Buffer.byteLength(manifestJson, 'utf8');
            if (projectedBytes > maxBytes) {
                throw new Error('Splitting these files would exceed the Steam Cloud storage quota for this volume.');
            }
            const manifestHandle = await fsp.open(manifestTarget, 'wx');
            try {
                await manifestHandle.writeFile(manifestJson, 'utf8');
                await manifestHandle.sync();
            } finally {
                await manifestHandle.close();
            }
        }

        const activeRoot = splitStorageRoot(cloudRoot);
        await fsp.rm(activeRoot, { recursive: true, force: true });
        await fsp.rename(stagingRoot, activeRoot);

        try {
            for (const file of oversized) {
                await fsp.rm(safeAuditPath(cloudRoot, file.path), { force: true });
            }
        } catch (error) {
            // Restaurer les fichiers normaux si la suppression transactionnelle échoue.
            await restoreSplitFiles(cloudRoot, cacheRoot);
            throw error;
        }

        return {
            splitFiles: oversized.length,
            parts: totalParts,
            reusedParts,
            rewrittenParts,
            maxFileBytes: MAX_SYNC_FILE_BYTES,
            chunkBytes: SYNC_CHUNK_BYTES
        };
    } catch (error) {
        await fsp.rm(stagingRoot, { recursive: true, force: true });
        throw error;
    }
}

export type AuditEntry = {
    path: string;
    name: string;
    type: 'file' | 'directory';
    size: number;
};

export type TreeStats = {
    bytes: number;
    files: number;
};

type ImportPlan = {
    bytesDelta: number;
    newFiles: number;
};

// Opérations génériques sur le Cloud local.

export async function ensureDir(target: string): Promise<void> {
    await fsp.mkdir(target, { recursive: true });
}

export async function treeStats(target: string): Promise<TreeStats> {
    try {
        const stat = await fsp.stat(target);
        if (stat.isFile()) return { bytes: stat.size, files: 1 };
        if (!stat.isDirectory()) return { bytes: 0, files: 0 };

        const entries = await fsp.readdir(target, { withFileTypes: true });
        let bytes = 0;
        let files = 0;
        for (const entry of entries) {
            if (!entry.isFile() && !entry.isDirectory()) continue;
            const child = await treeStats(path.join(target, entry.name));
            bytes += child.bytes;
            files += child.files;
        }
        return { bytes, files };
    } catch {
        return { bytes: 0, files: 0 };
    }
}

export async function sizeOf(target: string): Promise<number> {
    return (await treeStats(target)).bytes;
}

export async function fileCountOf(target: string): Promise<number> {
    return (await treeStats(target)).files;
}

export async function largestFile(target: string): Promise<{ path: string; size: number } | null> {
    try {
        const stat = await fsp.stat(target);
        if (stat.isFile()) return { path: target, size: stat.size };
        if (!stat.isDirectory()) return null;

        const entries = await fsp.readdir(target, { withFileTypes: true });
        let largest: { path: string; size: number } | null = null;
        for (const entry of entries) {
            if (!entry.isFile() && !entry.isDirectory()) continue;
            const candidate = await largestFile(path.join(target, entry.name));
            if (candidate && (!largest || candidate.size > largest.size)) largest = candidate;
        }
        return largest;
    } catch {
        return null;
    }
}


export type OversizedFile = {
    path: string;
    name: string;
    size: number;
};

export async function filesOverLimit(
    cloudRoot: string,
    maxBytes: number
): Promise<OversizedFile[]> {
    const root = auditRoot(cloudRoot);
    const oversized: OversizedFile[] = [];

    async function walk(target: string): Promise<void> {
        let stat;
        try {
            stat = await fsp.stat(target);
        } catch {
            return;
        }

        if (stat.isFile()) {
            if (stat.size > maxBytes) {
                const relative = path.relative(root, target);
                oversized.push({
                    path: relative.split(path.sep).join('/'),
                    name: path.basename(target),
                    size: stat.size
                });
            }
            return;
        }

        if (!stat.isDirectory()) return;
        const entries = await fsp.readdir(target, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() && !entry.isDirectory()) continue;
            if (target === root && isSplitInternalName(entry.name)) continue;
            await walk(path.join(target, entry.name));
        }
    }

    await walk(root);
    oversized.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
    return oversized;
}

export async function statFsFor(target: string): Promise<{ free: number; total: number }> {
    let probe = target;
    while (probe && !fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }

    const stats = await fsp.statfs(probe || path.parse(target).root);
    return {
        free: Number(stats.bavail) * Number(stats.bsize),
        total: Number(stats.blocks) * Number(stats.bsize)
    };
}

export function auditRoot(cloudRoot: string): string {
    return path.join(cloudRoot, AUDIT_FOLDER);
}

function normalizeRelative(relativePath: string): string {
    const normalized = path.normalize(relativePath || '.');
    return normalized === '.' ? '' : normalized;
}

function safeAuditPath(cloudRoot: string, relativePath: string): string {
    const root = path.resolve(auditRoot(cloudRoot));
    const target = path.resolve(root, normalizeRelative(relativePath));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error('Path outside the VaporStow volume.');
    }
    return target;
}

export async function listAuditTree(cloudRoot: string): Promise<{
    root: string;
    bytes: number;
    files: number;
}> {
    const root = auditRoot(cloudRoot);
    const stats = await treeStats(root);
    return { root, ...stats };
}

export async function listAuditDirectory(
    cloudRoot: string,
    relativeDirectory = ''
): Promise<{ directory: string; entries: AuditEntry[] }> {
    const directory = normalizeRelative(relativeDirectory);
    const absolute = safeAuditPath(cloudRoot, directory);

    if (!fs.existsSync(absolute)) return { directory: '', entries: [] };

    const stat = await fsp.stat(absolute);
    if (!stat.isDirectory()) throw new Error('This path is not a folder.');

    const dirents = await fsp.readdir(absolute, { withFileTypes: true });
    const entries: AuditEntry[] = [];

    for (const dirent of dirents) {
        if (!dirent.isDirectory() && !dirent.isFile()) continue;
        if (!directory && isSplitInternalName(dirent.name)) continue;
        const relative = path.join(directory, dirent.name);
        let size = 0;
        if (dirent.isFile()) size = (await fsp.stat(path.join(absolute, dirent.name))).size;
        entries.push({
            path: relative,
            name: dirent.name,
            type: dirent.isDirectory() ? 'directory' : 'file',
            size
        });
    }

    entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return { directory, entries };
}

async function destinationDelta(source: string, destination: string): Promise<ImportPlan> {
    const sourceStat = await fsp.stat(source);
    if (!sourceStat.isFile()) throw new Error('Only regular files can be imported.');
    try {
        await fsp.access(source, fs.constants.R_OK);
    } catch {
        throw new Error(`Cannot read “${source}”. Check the source file permissions and try again.`);
    }

    try {
        const destinationStat = await fsp.stat(destination);
        if (!destinationStat.isFile()) {
            throw new Error(`Cannot overwrite a folder with the file “${path.basename(destination)}”.`);
        }
        return { bytesDelta: sourceStat.size - destinationStat.size, newFiles: 0 };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { bytesDelta: sourceStat.size, newFiles: 1 };
    }
}

async function validateDirectoryDestination(source: string, destination: string): Promise<void> {
    const sourceStat = await fsp.stat(source);
    if (!sourceStat.isDirectory()) throw new Error('The selected source is not a folder.');
    try {
        const destinationStat = await fsp.stat(destination);
        if (!destinationStat.isDirectory()) {
            throw new Error(`Cannot overwrite a file with the folder “${path.basename(destination)}”.`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

async function planDirectory(source: string, destination: string): Promise<ImportPlan> {
    await validateDirectoryDestination(source, destination);
    const dirents = await fsp.readdir(source, { withFileTypes: true });
    let bytesDelta = 0;
    let newFiles = 0;

    for (const dirent of dirents) {
        if (!dirent.isFile() && !dirent.isDirectory()) continue;
        const src = path.join(source, dirent.name);
        const dst = path.join(destination, dirent.name);
        if (dirent.isDirectory()) {
            const nested = await planDirectory(src, dst);
            bytesDelta += nested.bytesDelta;
            newFiles += nested.newFiles;
        } else {
            const delta = await destinationDelta(src, dst);
            bytesDelta += delta.bytesDelta;
            newFiles += delta.newFiles;
        }
    }

    return { bytesDelta, newFiles };
}

async function assertPlanFits(
    cloudRoot: string,
    plan: ImportPlan,
    maxBytes: number,
    maxFiles: number
): Promise<void> {
    // Compter tout le volume Auto-Cloud car le jeu peut aussi y créer ses fichiers.
    const current = await treeStats(cloudRoot);
    const projectedBytes = current.bytes + plan.bytesDelta;
    const projectedFiles = current.files + plan.newFiles;
    const remainingFiles = Math.max(0, maxFiles - current.files);

    if (projectedBytes > maxBytes) {
        throw new Error('This import would exceed the Steam Cloud storage quota for this volume.');
    }
    if (projectedFiles > maxFiles) {
        throw new Error(
            `This import needs ${plan.newFiles.toLocaleString()} new file slot${plan.newFiles === 1 ? '' : 's'}, but only ${remainingFiles.toLocaleString()} remain in this cloud.`
        );
    }
}

export async function preflightFilesImport(
    cloudRoot: string,
    relativeDirectory: string,
    sources: string[],
    maxBytes: number,
    maxFiles: number
): Promise<ImportPlan> {
    const destination = safeAuditPath(cloudRoot, relativeDirectory);
    const seen = new Set<string>();
    let bytesDelta = 0;
    let newFiles = 0;

    for (const source of sources) {
        const name = path.basename(source);
        const key = process.platform === 'win32' ? name.toLowerCase() : name;
        if (seen.has(key)) throw new Error(`Two selected files have the same name: “${name}”.`);
        seen.add(key);
        const delta = await destinationDelta(source, path.join(destination, name));
        bytesDelta += delta.bytesDelta;
        newFiles += delta.newFiles;
    }

    const plan = { bytesDelta, newFiles };
    await assertPlanFits(cloudRoot, plan, maxBytes, maxFiles);
    return plan;
}

export async function preflightDirectoryImport(
    cloudRoot: string,
    relativeDirectory: string,
    source: string,
    maxBytes: number,
    maxFiles: number
): Promise<ImportPlan> {
    const destination = safeAuditPath(cloudRoot, relativeDirectory);
    const target = path.join(destination, path.basename(source));
    const plan = await planDirectory(source, target);
    await assertPlanFits(cloudRoot, plan, maxBytes, maxFiles);
    return plan;
}

async function copyFile(source: string, destination: string): Promise<void> {
    const stat = await fsp.stat(source);
    if (!stat.isFile()) throw new Error('Only regular files can be imported.');
    try {
        await fsp.access(source, fs.constants.R_OK);
    } catch {
        throw new Error(`Cannot read “${source}”. Check the source file permissions and try again.`);
    }

    const parent = path.dirname(destination);
    await ensureDir(parent);

    // Do not overwrite the destination in-place. Git pack files and other
    // imported assets can legitimately be read-only; retrying an import would
    // then fail with EACCES when copyFile tries to truncate that existing file.
    // Copy to a fresh sibling and replace the directory entry atomically instead.
    const temporary = path.join(
        parent,
        `.${path.basename(destination)}.vaporstow-${process.pid}-${crypto.randomUUID()}.tmp`
    );

    try {
        await fsp.copyFile(source, temporary);

        // Keep the source permission bits where the platform supports them.
        // The replacement itself does not require the old destination to be writable.
        if (process.platform !== 'win32') {
            await fsp.chmod(temporary, stat.mode & 0o777).catch(() => undefined);
        }

        try {
            await fsp.rename(temporary, destination);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EEXIST'].includes(code || '')) throw error;

            // Windows can reject rename-over-existing. Remove the old entry and
            // retry; chmod helps with files carrying a read-only attribute.
            await fsp.chmod(destination, 0o666).catch(() => undefined);
            await fsp.rm(destination, { force: true });
            await fsp.rename(temporary, destination);
        }
    } finally {
        await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
}

export async function importFiles(
    cloudRoot: string,
    relativeDirectory: string,
    sources: string[],
    maxBytes: number,
    maxFiles: number
): Promise<void> {
    await preflightFilesImport(cloudRoot, relativeDirectory, sources, maxBytes, maxFiles);
    const destination = safeAuditPath(cloudRoot, relativeDirectory);
    await ensureDir(destination);
    for (const source of sources) await copyFile(source, path.join(destination, path.basename(source)));
}

async function copyDirectory(source: string, destination: string): Promise<void> {
    await ensureDir(destination);
    const dirents = await fsp.readdir(source, { withFileTypes: true });
    for (const dirent of dirents) {
        const src = path.join(source, dirent.name);
        const dst = path.join(destination, dirent.name);
        if (dirent.isDirectory()) await copyDirectory(src, dst);
        else if (dirent.isFile()) await copyFile(src, dst);
    }
}

export async function importDirectory(
    cloudRoot: string,
    relativeDirectory: string,
    source: string,
    maxBytes: number,
    maxFiles: number
): Promise<void> {
    await preflightDirectoryImport(cloudRoot, relativeDirectory, source, maxBytes, maxFiles);
    const destination = safeAuditPath(cloudRoot, relativeDirectory);
    await ensureDir(destination);
    await copyDirectory(source, path.join(destination, path.basename(source)));
}

export async function createFolder(
    cloudRoot: string,
    relativeDirectory: string,
    name: string
): Promise<void> {
    const cleanName = name.trim();
    if (!cleanName || cleanName === '.' || cleanName === '..' || /[\\/]/.test(cleanName)) {
        throw new Error('Invalid folder name.');
    }
    const parent = safeAuditPath(cloudRoot, relativeDirectory);
    await ensureDir(parent);
    await ensureDir(safeAuditPath(cloudRoot, path.join(relativeDirectory, cleanName)));
}

export async function deleteEntry(cloudRoot: string, relativePath: string): Promise<void> {
    const target = safeAuditPath(cloudRoot, relativePath);
    if (target === path.resolve(auditRoot(cloudRoot))) {
        throw new Error('The volume root itself cannot be deleted.');
    }
    await fsp.rm(target, { recursive: true, force: true });
}

export type CloudContentSummary = {
    files: number;
    directories: number;
    onlyEmptyDirectories: boolean;
};

export async function cloudContentSummary(cloudRoot: string): Promise<CloudContentSummary> {
    const root = auditRoot(cloudRoot);
    let files = 0;
    let directories = 0;

    async function walk(target: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(target, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }

        for (const entry of entries) {
            const child = path.join(target, entry.name);
            if (entry.isDirectory()) {
                directories += 1;
                await walk(child);
            } else if (entry.isFile()) {
                files += 1;
            }
        }
    }

    await walk(root);
    return {
        files,
        directories,
        onlyEmptyDirectories: files === 0 && directories > 0
    };
}

export async function pruneEmptyAuditDirectories(cloudRoot: string): Promise<{ removed: number }> {
    const root = auditRoot(cloudRoot);
    let removed = 0;

    async function prune(target: string, keep: boolean): Promise<boolean> {
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(target, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
            throw error;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            await prune(path.join(target, entry.name), false);
        }

        const remaining = await fsp.readdir(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });

        if (!keep && remaining.length === 0) {
            await fsp.rmdir(target);
            removed += 1;
            return true;
        }

        return remaining.length === 0;
    }

    await prune(root, true);
    return { removed };
}

export function resolveAuditDirectory(cloudRoot: string, relativeDirectory = ''): string {
    return safeAuditPath(cloudRoot, relativeDirectory);
}

export function resolveAuditEntry(cloudRoot: string, relativePath: string): string {
    return safeAuditPath(cloudRoot, relativePath);
}
