import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CARRIER_MAGIC = Buffer.from('VSTOWC1\n', 'ascii');
const CARRIER_PREFIX_BYTES = CARRIER_MAGIC.length + 4;
const CARRIER_VERSION = 1;
const CARRIER_PAYLOAD_BYTES = 94 * 1024 * 1024;
const IO_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

type CarrierHeader = {
    version: 1;
    logicalPath: string;
    sourceSize: number;
    sourceSha256: string;
    mtimeMs: number;
    mode: number;
    partIndex: number;
    partCount: number;
    payloadOffset: number;
    payloadSize: number;
    payloadSha256: string;
};

type CarrierFile = {
    file: string;
    absolute: string;
    header: CarrierHeader;
    headerBytes: number;
    size: number;
};

type SourceFile = {
    absolute: string;
    logicalPath: string;
    size: number;
    mtimeMs: number;
    mode: number;
};

export type CarrierPackResult = {
    carrierFiles: number;
    carrierBytes: number;
    logicalFiles: number;
    pattern: string;
};

export type CarrierRestoreResult = {
    detected: boolean;
    carrierFiles: number;
    restoredFiles: number;
};

function normalizeLogicalPath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
        throw new Error('Invalid VaporStow carrier path.');
    }
    return segments.join('/');
}

function safeWorkspacePath(workspaceRoot: string, logicalPath: string): string {
    const normalized = normalizeLogicalPath(logicalPath);
    const root = path.resolve(workspaceRoot);
    const target = path.resolve(root, ...normalized.split('/'));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error('Carrier path escapes the VaporStow workspace.');
    }
    return target;
}

async function sha256Range(target: string, offset: number, size: number): Promise<string> {
    const hash = crypto.createHash('sha256');
    const handle = await fsp.open(target, 'r');
    const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
    let read = 0;
    try {
        while (read < size) {
            const wanted = Math.min(buffer.length, size - read);
            const result = await handle.read(buffer, 0, wanted, offset + read);
            if (result.bytesRead <= 0) throw new Error('Unexpected end of carrier source file.');
            hash.update(buffer.subarray(0, result.bytesRead));
            read += result.bytesRead;
        }
    } finally {
        await handle.close();
    }
    return hash.digest('hex');
}

async function sha256File(target: string): Promise<string> {
    const stat = await fsp.stat(target);
    return sha256Range(target, 0, stat.size);
}

async function listSourceFiles(root: string): Promise<SourceFile[]> {
    const output: SourceFile[] = [];
    const resolvedRoot = path.resolve(root);

    async function walk(current: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(current, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }

        for (const entry of entries) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
                continue;
            }
            if (!entry.isFile()) continue;
            const stat = await fsp.stat(absolute);
            const relative = path.relative(resolvedRoot, absolute).split(path.sep).join('/');
            output.push({
                absolute,
                logicalPath: normalizeLogicalPath(relative),
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                mode: stat.mode & 0o777
            });
        }
    }

    await walk(resolvedRoot);
    output.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, undefined, { numeric: true }));
    return output;
}

function carrierFileName(pattern: string, token: string): string {
    let firstStar = true;
    let questionIndex = 0;
    const questionToken = token.replace(/[^a-z0-9]/gi, '') || 'vstow';
    const generated = pattern.trim()
        .replace(/\*/g, () => {
            if (firstStar) {
                firstStar = false;
                return `vstow_${token}`;
            }
            return 'vst';
        })
        .replace(/\?/g, () => questionToken[questionIndex++ % questionToken.length] || 'x');

    if (!generated || generated === '.' || generated === '..' || /[\\/]/.test(generated)) {
        throw new Error(`Unsupported Steam Cloud filename pattern: ${pattern}`);
    }
    return generated;
}

function wildcardRegex(pattern: string): RegExp {
    const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, process.platform === 'win32' ? 'i' : '');
}

async function readCarrierHeader(target: string): Promise<CarrierFile | null> {
    let handle: fsp.FileHandle | null = null;
    try {
        handle = await fsp.open(target, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < CARRIER_PREFIX_BYTES) return null;

        const prefix = Buffer.allocUnsafe(CARRIER_PREFIX_BYTES);
        const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
        if (prefixRead.bytesRead !== prefix.length) return null;
        if (!prefix.subarray(0, CARRIER_MAGIC.length).equals(CARRIER_MAGIC)) return null;

        const headerLength = prefix.readUInt32LE(CARRIER_MAGIC.length);
        if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || CARRIER_PREFIX_BYTES + headerLength > stat.size) return null;

        const headerBuffer = Buffer.allocUnsafe(headerLength);
        const headerRead = await handle.read(headerBuffer, 0, headerLength, CARRIER_PREFIX_BYTES);
        if (headerRead.bytesRead !== headerLength) return null;
        const parsed = JSON.parse(headerBuffer.toString('utf8')) as Partial<CarrierHeader>;

        if (
            parsed.version !== CARRIER_VERSION
            || typeof parsed.logicalPath !== 'string'
            || !Number.isFinite(parsed.sourceSize)
            || typeof parsed.sourceSha256 !== 'string'
            || !Number.isFinite(parsed.mtimeMs)
            || !Number.isFinite(parsed.mode)
            || !Number.isInteger(parsed.partIndex)
            || !Number.isInteger(parsed.partCount)
            || !Number.isFinite(parsed.payloadOffset)
            || !Number.isFinite(parsed.payloadSize)
            || typeof parsed.payloadSha256 !== 'string'
        ) return null;

        const header = parsed as CarrierHeader;
        if (
            header.sourceSize < 0
            || header.partIndex < 0
            || header.partCount <= 0
            || header.partIndex >= header.partCount
            || header.payloadOffset < 0
            || header.payloadSize < 0
            || CARRIER_PREFIX_BYTES + headerLength + header.payloadSize !== stat.size
        ) return null;

        normalizeLogicalPath(header.logicalPath);
        return {
            file: path.basename(target),
            absolute: target,
            header,
            headerBytes: headerLength,
            size: stat.size
        };
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function listExistingCarriers(cloudRoot: string): Promise<CarrierFile[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fsp.readdir(cloudRoot, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }

    const output: CarrierFile[] = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const carrier = await readCarrierHeader(path.join(cloudRoot, entry.name));
        if (carrier) output.push(carrier);
    }
    return output;
}

async function writeCarrier(
    source: SourceFile,
    sourceSha256: string,
    sourceOffset: number,
    payloadSize: number,
    partIndex: number,
    partCount: number,
    destination: string
): Promise<number> {
    const payloadSha256 = await sha256Range(source.absolute, sourceOffset, payloadSize);
    const header: CarrierHeader = {
        version: CARRIER_VERSION,
        logicalPath: source.logicalPath,
        sourceSize: source.size,
        sourceSha256,
        mtimeMs: source.mtimeMs,
        mode: source.mode,
        partIndex,
        partCount,
        payloadOffset: sourceOffset,
        payloadSize,
        payloadSha256
    };
    const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
    if (headerBuffer.length > MAX_HEADER_BYTES) throw new Error('VaporStow carrier metadata is unexpectedly large.');

    const out = await fsp.open(destination, 'wx');
    const input = await fsp.open(source.absolute, 'r');
    const prefix = Buffer.allocUnsafe(CARRIER_PREFIX_BYTES);
    CARRIER_MAGIC.copy(prefix, 0);
    prefix.writeUInt32LE(headerBuffer.length, CARRIER_MAGIC.length);
    const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
    let copied = 0;

    try {
        await out.write(prefix, 0, prefix.length, 0);
        await out.write(headerBuffer, 0, headerBuffer.length, prefix.length);
        let writeOffset = prefix.length + headerBuffer.length;
        while (copied < payloadSize) {
            const wanted = Math.min(buffer.length, payloadSize - copied);
            const result = await input.read(buffer, 0, wanted, sourceOffset + copied);
            if (result.bytesRead <= 0) throw new Error('Unexpected end of file while creating a VaporStow carrier.');
            await out.write(buffer, 0, result.bytesRead, writeOffset);
            copied += result.bytesRead;
            writeOffset += result.bytesRead;
        }
        await out.sync();
        return writeOffset;
    } finally {
        await input.close();
        await out.close();
    }
}

async function nonCarrierUsage(cloudRoot: string, pattern: string, recursive: boolean, carrierNames: Set<string>): Promise<{ bytes: number; files: number; names: Set<string> }> {
    const matcher = wildcardRegex(pattern);
    const names = new Set<string>();
    let bytes = 0;
    let files = 0;

    async function walk(current: string, depth: number): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(current, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }

        for (const entry of entries) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (recursive) await walk(absolute, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            if (depth === 0 && carrierNames.has(entry.name)) continue;
            if (!matcher.test(entry.name)) continue;
            const stat = await fsp.stat(absolute);
            bytes += stat.size;
            files += 1;
            if (depth === 0) names.add(process.platform === 'win32' ? entry.name.toLowerCase() : entry.name);
        }
    }

    await walk(cloudRoot, 0);
    return { bytes, files, names };
}

async function replaceFile(source: string, destination: string): Promise<void> {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.vstow-${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
        await fsp.copyFile(source, temporary);
        try {
            await fsp.rename(temporary, destination);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EEXIST'].includes(code || '')) throw error;
            await fsp.rm(destination, { force: true });
            await fsp.rename(temporary, destination);
        }
    } finally {
        await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
}

export async function packWorkspace(
    workspaceRoot: string,
    cloudRoot: string,
    pattern: string,
    recursive: boolean,
    quotaBytes: number,
    maxFiles: number
): Promise<CarrierPackResult> {
    if (!pattern.includes('*') && !pattern.includes('?')) {
        throw new Error(`Steam Cloud pattern “${pattern}” does not provide a safe wildcard namespace.`);
    }

    const sources = await listSourceFiles(workspaceRoot);
    const existingCarriers = await listExistingCarriers(cloudRoot);
    const oldCarrierNames = new Set(existingCarriers.map((entry) => entry.file));
    const nonCarrier = await nonCarrierUsage(cloudRoot, pattern, recursive, oldCarrierNames);
    const stagingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaporstow-carrier-'));
    const staged = new Map<string, string>();
    let carrierBytes = 0;
    let carrierFiles = 0;

    try {
        for (const source of sources) {
            const sourceSha256 = await sha256File(source.absolute);
            const partCount = Math.max(1, Math.ceil(source.size / CARRIER_PAYLOAD_BYTES));
            for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
                const sourceOffset = partIndex * CARRIER_PAYLOAD_BYTES;
                const payloadSize = Math.min(CARRIER_PAYLOAD_BYTES, Math.max(0, source.size - sourceOffset));
                let filename = '';
                for (let attempt = 0; attempt < 1000; attempt += 1) {
                    const tokenHash = crypto.createHash('sha256')
                        .update(`${source.logicalPath}\0${partIndex}\0${attempt}`)
                        .digest('hex')
                        .slice(0, 24);
                    const token = `${tokenHash}_${partIndex}`;
                    const candidate = carrierFileName(pattern, token);
                    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
                    if (!nonCarrier.names.has(key) && ![...staged.keys()].some((name) => (process.platform === 'win32' ? name.toLowerCase() : name) === key)) {
                        filename = candidate;
                        break;
                    }
                }
                if (!filename) throw new Error(`Unable to create a collision-free carrier name for pattern “${pattern}”.`);

                const stagedFile = path.join(stagingRoot, filename);
                const bytes = await writeCarrier(
                    source,
                    sourceSha256,
                    sourceOffset,
                    payloadSize,
                    partIndex,
                    partCount,
                    stagedFile
                );
                staged.set(filename, stagedFile);
                carrierBytes += bytes;
                carrierFiles += 1;
            }
        }

        if (nonCarrier.bytes + carrierBytes > quotaBytes) {
            throw new Error('The encoded VaporStow files would exceed this Steam Cloud quota.');
        }
        if (nonCarrier.files + carrierFiles > maxFiles) {
            throw new Error(
                `The encoded VaporStow volume needs ${carrierFiles.toLocaleString()} Steam Cloud file slots, but this Cloud does not have enough free slots.`
            );
        }

        await fsp.mkdir(cloudRoot, { recursive: true });
        for (const [filename, stagedFile] of staged) {
            await replaceFile(stagedFile, path.join(cloudRoot, filename));
        }

        const keep = new Set(staged.keys());
        for (const old of existingCarriers) {
            if (!keep.has(old.file)) await fsp.rm(old.absolute, { force: true });
        }

        return { carrierFiles, carrierBytes, logicalFiles: sources.length, pattern };
    } finally {
        await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function appendCarrierPayload(carrier: CarrierFile, destination: fsp.FileHandle, expectedOffset: number): Promise<void> {
    const input = await fsp.open(carrier.absolute, 'r');
    const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
    const payloadHash = crypto.createHash('sha256');
    const dataOffset = CARRIER_PREFIX_BYTES + carrier.headerBytes;
    let copied = 0;
    try {
        while (copied < carrier.header.payloadSize) {
            const wanted = Math.min(buffer.length, carrier.header.payloadSize - copied);
            const result = await input.read(buffer, 0, wanted, dataOffset + copied);
            if (result.bytesRead <= 0) throw new Error('Unexpected end of VaporStow carrier file.');
            const data = buffer.subarray(0, result.bytesRead);
            payloadHash.update(data);
            await destination.write(data, 0, result.bytesRead, expectedOffset + copied);
            copied += result.bytesRead;
        }
    } finally {
        await input.close();
    }
    if (payloadHash.digest('hex') !== carrier.header.payloadSha256) {
        throw new Error(`Carrier integrity check failed for “${carrier.file}”.`);
    }
}

async function replaceDirectory(source: string, destination: string): Promise<void> {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const backup = `${destination}.previous-${crypto.randomUUID()}`;
    const destinationExists = await fsp.stat(destination).then(() => true).catch(() => false);
    try {
        if (destinationExists) await fsp.rename(destination, backup);
        try {
            await fsp.rename(source, destination);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            await fsp.cp(source, destination, { recursive: true, preserveTimestamps: true });
            await fsp.rm(source, { recursive: true, force: true });
        }
        await fsp.rm(backup, { recursive: true, force: true });
    } catch (error) {
        await fsp.rm(destination, { recursive: true, force: true }).catch(() => undefined);
        if (destinationExists) await fsp.rename(backup, destination).catch(() => undefined);
        throw error;
    }
}

export async function restoreWorkspace(cloudRoot: string, workspaceRoot: string): Promise<CarrierRestoreResult> {
    const carriers = await listExistingCarriers(cloudRoot);
    await fsp.mkdir(path.dirname(workspaceRoot), { recursive: true });
    const stagingRoot = await fsp.mkdtemp(path.join(path.dirname(workspaceRoot), '.vaporstow-restore-'));

    try {
        const groups = new Map<string, CarrierFile[]>();
        for (const carrier of carriers) {
            const logicalPath = normalizeLogicalPath(carrier.header.logicalPath);
            const list = groups.get(logicalPath) ?? [];
            list.push(carrier);
            groups.set(logicalPath, list);
        }

        for (const [logicalPath, parts] of groups) {
            parts.sort((left, right) => left.header.partIndex - right.header.partIndex);
            const first = parts[0];
            if (!first || parts.length !== first.header.partCount) {
                throw new Error(`Incomplete VaporStow carrier set for “${logicalPath}”.`);
            }
            for (let index = 0; index < parts.length; index += 1) {
                const current = parts[index];
                if (
                    current.header.partIndex !== index
                    || current.header.partCount !== first.header.partCount
                    || current.header.sourceSize !== first.header.sourceSize
                    || current.header.sourceSha256 !== first.header.sourceSha256
                    || current.header.logicalPath !== first.header.logicalPath
                ) {
                    throw new Error(`Inconsistent VaporStow carrier metadata for “${logicalPath}”.`);
                }
            }

            const destinationPath = safeWorkspacePath(stagingRoot, logicalPath);
            await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
            const destination = await fsp.open(destinationPath, 'wx');
            let offset = 0;
            try {
                for (const carrier of parts) {
                    if (carrier.header.payloadOffset !== offset) {
                        throw new Error(`Unexpected carrier offset for “${logicalPath}”.`);
                    }
                    await appendCarrierPayload(carrier, destination, offset);
                    offset += carrier.header.payloadSize;
                }
                await destination.sync();
            } finally {
                await destination.close();
            }

            if (offset !== first.header.sourceSize || await sha256File(destinationPath) !== first.header.sourceSha256) {
                throw new Error(`Restored file integrity check failed for “${logicalPath}”.`);
            }
            if (process.platform !== 'win32') await fsp.chmod(destinationPath, first.header.mode).catch(() => undefined);
            const mtime = new Date(first.header.mtimeMs);
            await fsp.utimes(destinationPath, mtime, mtime).catch(() => undefined);
        }

        await replaceDirectory(stagingRoot, workspaceRoot);
        return { detected: carriers.length > 0, carrierFiles: carriers.length, restoredFiles: groups.size };
    } catch (error) {
        await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

export async function carrierUsage(cloudRoot: string): Promise<{ bytes: number; files: number }> {
    const carriers = await listExistingCarriers(cloudRoot);
    return {
        bytes: carriers.reduce((sum, entry) => sum + entry.size, 0),
        files: carriers.length
    };
}
