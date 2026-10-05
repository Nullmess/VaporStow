import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CloudContext, CloudStorageRule, GameDefinition } from '../games';

interface VdfObject {
    [key: string]: VdfValue;
}
type VdfValue = VdfObject | string | number | bigint;

type AppInfoRecord = {
    appId: string;
    data: VdfObject;
};

type SaveRule = {
    root: string;
    relativePath: string;
    pattern: string;
    recursive: boolean;
    platforms: string[];
};

type RootOverride = {
    root: string;
    os: string;
    useInstead: string;
    transforms: Array<{ find: string; replace: string }>;
};

type ResolvedRule = CloudStorageRule;

type DiscoveryCache = {
    key: string;
    scopeKey: string;
    games: GameDefinition[];
};

type AppInfoDiscoveryOptions = {
    discoverySource?: 'local' | 'catalog';
    requireFree?: boolean;
};

let discoveryCache: DiscoveryCache | null = null;


function objectValue(value: VdfValue | undefined): VdfObject | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as VdfObject : null;
}

function findKey(object: VdfObject | null, key: string): VdfValue | undefined {
    if (!object) return undefined;
    const wanted = key.toLowerCase();
    const match = Object.keys(object).find((candidate) => candidate.toLowerCase() === wanted);
    return match === undefined ? undefined : object[match];
}

function findObject(object: VdfObject | null, key: string): VdfObject | null {
    return objectValue(findKey(object, key));
}

function stringValue(value: VdfValue | undefined): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    return null;
}

function numberValue(value: VdfValue | undefined): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') {
        const number = Number(value);
        return Number.isSafeInteger(number) ? number : null;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const number = Number(value.trim());
        return Number.isFinite(number) ? number : null;
    }
    return null;
}

type TextVdfToken = { kind: 'string' | 'brace'; value: string };

function decodeTextVdfString(raw: string): string {
    return raw.slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

function tokenizeTextVdf(input: string): TextVdfToken[] {
    const tokens: TextVdfToken[] = [];
    const pattern = /"(?:\\.|[^"\\])*"|[{}]/g;
    for (const match of input.matchAll(pattern)) {
        const raw = match[0];
        if (raw === '{' || raw === '}') tokens.push({ kind: 'brace', value: raw });
        else tokens.push({ kind: 'string', value: decodeTextVdfString(raw) });
    }
    return tokens;
}

function parseTextVdfObject(tokens: TextVdfToken[], start: number): { value: VdfObject; next: number } | null {
    if (tokens[start]?.value !== '{') return null;
    const result: VdfObject = {};
    let cursor = start + 1;
    while (cursor < tokens.length) {
        const token = tokens[cursor];
        if (token.kind === 'brace' && token.value === '}') return { value: result, next: cursor + 1 };
        if (token.kind !== 'string') {
            cursor += 1;
            continue;
        }
        const key = token.value;
        const next = tokens[cursor + 1];
        if (!next) return null;
        if (next.kind === 'brace' && next.value === '{') {
            const nested = parseTextVdfObject(tokens, cursor + 1);
            if (!nested) return null;
            result[key] = nested.value;
            cursor = nested.next;
            continue;
        }
        if (next.kind === 'string') {
            result[key] = next.value;
            cursor += 2;
            continue;
        }
        cursor += 1;
    }
    return null;
}

function parseTextAppInfo(input: string, wantedAppIds: Set<string> | null = null): Map<string, AppInfoRecord> {
    const tokens = tokenizeTextVdf(input);
    const records = new Map<string, AppInfoRecord>();
    for (let index = 0; index + 1 < tokens.length; index += 1) {
        const key = tokens[index];
        const brace = tokens[index + 1];
        if (key.kind !== 'string' || !/^\d+$/.test(key.value) || brace.value !== '{') continue;
        if (wantedAppIds && !wantedAppIds.has(key.value)) continue;
        const parsed = parseTextVdfObject(tokens, index + 1);
        if (!parsed) continue;
        const appRoot = findObject(parsed.value, 'appinfo') ?? parsed.value;
        records.set(key.value, { appId: key.value, data: appRoot });
        index = parsed.next - 1;
    }
    return records;
}

function truthyValue(value: VdfValue | undefined): boolean {
    const numeric = numberValue(value);
    if (numeric !== null) return numeric !== 0;
    const normalized = stringValue(value)?.trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readNullUtf8(buffer: Buffer, cursor: { offset: number }, end: number): string {
    const start = cursor.offset;
    let offset = start;
    while (offset < end && buffer[offset] !== 0) offset += 1;
    if (offset >= end) throw new Error('Unterminated VDF string.');
    cursor.offset = offset + 1;
    return buffer.toString('utf8', start, offset);
}

function readNullUtf16(buffer: Buffer, cursor: { offset: number }, end: number): string {
    const start = cursor.offset;
    let offset = start;
    while (offset + 1 < end && (buffer[offset] !== 0 || buffer[offset + 1] !== 0)) offset += 2;
    if (offset + 1 >= end) throw new Error('Unterminated VDF UTF-16 string.');
    cursor.offset = offset + 2;
    return buffer.toString('utf16le', start, offset);
}

function parseBinaryObject(
    buffer: Buffer,
    cursor: { offset: number },
    end: number,
    version: number,
    stringTable: string[] | null
): VdfObject {
    const result: VdfObject = {};

    while (cursor.offset < end) {
        const type = buffer[cursor.offset++];
        if (type === 0x08) return result;

        let key: string;
        if (version >= 41) {
            if (!stringTable || cursor.offset + 4 > end) throw new Error('Invalid appinfo string-table key.');
            const keyIndex = buffer.readUInt32LE(cursor.offset);
            cursor.offset += 4;
            key = stringTable[keyIndex] ?? `__unknown_${keyIndex}`;
        } else {
            key = readNullUtf8(buffer, cursor, end);
        }

        switch (type) {
            case 0x00:
                result[key] = parseBinaryObject(buffer, cursor, end, version, stringTable);
                break;
            case 0x01:
                result[key] = readNullUtf8(buffer, cursor, end);
                break;
            case 0x02:
                if (cursor.offset + 4 > end) throw new Error('Truncated VDF int32.');
                result[key] = buffer.readInt32LE(cursor.offset);
                cursor.offset += 4;
                break;
            case 0x03:
                if (cursor.offset + 4 > end) throw new Error('Truncated VDF float32.');
                result[key] = buffer.readFloatLE(cursor.offset);
                cursor.offset += 4;
                break;
            case 0x04:
            case 0x06:
                if (cursor.offset + 4 > end) throw new Error('Truncated VDF uint32.');
                result[key] = buffer.readUInt32LE(cursor.offset);
                cursor.offset += 4;
                break;
            case 0x05:
                result[key] = readNullUtf16(buffer, cursor, end);
                break;
            case 0x07:
                if (cursor.offset + 8 > end) throw new Error('Truncated VDF uint64.');
                result[key] = buffer.readBigUInt64LE(cursor.offset);
                cursor.offset += 8;
                break;
            default:
                throw new Error(`Unsupported binary VDF type 0x${type.toString(16)}.`);
        }
    }

    return result;
}

function readStringTable(buffer: Buffer, offset: number): string[] {
    if (offset < 0 || offset + 4 > buffer.length) throw new Error('Invalid appinfo string-table offset.');
    const count = buffer.readUInt32LE(offset);
    const cursor = { offset: offset + 4 };
    const strings: string[] = [];
    for (let index = 0; index < count; index += 1) {
        strings.push(readNullUtf8(buffer, cursor, buffer.length));
    }
    return strings;
}

function parseAppInfo(buffer: Buffer, wantedAppIds: Set<string> | null = null): Map<string, AppInfoRecord> {
    if (buffer.length < 8) return new Map();
    const magic = buffer.readUInt32LE(0);
    const version = magic & 0xff;
    const signature = magic >>> 8;
    if (signature !== 0x075644 || version < 39 || version > 41) return new Map();

    let cursorOffset = 8;
    let stringTable: string[] | null = null;
    if (version >= 41) {
        if (buffer.length < 16) return new Map();
        const tableOffset = Number(buffer.readBigInt64LE(8));
        stringTable = readStringTable(buffer, tableOffset);
        cursorOffset = 16;
    }

    const records = new Map<string, AppInfoRecord>();
    while (cursorOffset + 4 <= buffer.length) {
        const appId = buffer.readUInt32LE(cursorOffset);
        cursorOffset += 4;
        if (appId === 0) break;
        if (cursorOffset + 4 > buffer.length) break;

        const size = buffer.readUInt32LE(cursorOffset);
        cursorOffset += 4;
        const entryStart = cursorOffset;
        const entryEnd = entryStart + size;
        if (entryEnd > buffer.length || size <= 0) break;

        const appIdString = String(appId);
        if (!wantedAppIds || wantedAppIds.has(appIdString)) {
            const fixedBytes = version >= 40 ? 60 : 40;
            const dataStart = entryStart + fixedBytes;
            if (dataStart < entryEnd) {
                try {
                    const cursor = { offset: dataStart };
                    const parsed = parseBinaryObject(buffer, cursor, entryEnd, version, stringTable);
                    const appRoot = findObject(parsed, 'appinfo') ?? parsed;
                    records.set(appIdString, { appId: appIdString, data: appRoot });
                } catch {
                }
            }
        }

        cursorOffset = entryEnd;
    }

    return records;
}

function steam3AccountId(steamId64: string | null): string | null {
    if (!steamId64 || !/^\d+$/.test(steamId64)) return null;
    try {
        const value = BigInt(steamId64) - 76561197960265728n;
        return value >= 0n ? value.toString() : null;
    } catch {
        return null;
    }
}

function values(object: VdfObject | null): VdfValue[] {
    return object ? Object.values(object) : [];
}

function platformsFromRule(rule: VdfObject): string[] {
    const platforms = findObject(rule, 'platforms');
    return values(platforms)
        .map((value) => stringValue(value)?.trim())
        .filter((value): value is string => Boolean(value));
}

function saveRules(ufs: VdfObject): SaveRule[] {
    const savefiles = findObject(ufs, 'savefiles');
    if (!savefiles) return [];

    return values(savefiles).flatMap((value) => {
        const rule = objectValue(value);
        if (!rule) return [];
        const root = stringValue(findKey(rule, 'root'))?.trim() || '';
        const relativePath = stringValue(findKey(rule, 'path'))?.trim() || '';
        const pattern = stringValue(findKey(rule, 'pattern'))?.trim() || '';
        const recursive = numberValue(findKey(rule, 'recursive')) === 1
            || stringValue(findKey(rule, 'recursive'))?.trim() === '1';
        if (!root || !pattern) return [];
        return [{ root, relativePath, pattern, recursive, platforms: platformsFromRule(rule) }];
    });
}

function rootOverrides(ufs: VdfObject): RootOverride[] {
    const overrides = findObject(ufs, 'rootoverrides');
    if (!overrides) return [];

    return values(overrides).flatMap((value) => {
        const rule = objectValue(value);
        if (!rule) return [];
        const root = stringValue(findKey(rule, 'root'))?.trim() || '';
        const osName = stringValue(findKey(rule, 'os'))?.trim() || '';
        const useInstead = stringValue(findKey(rule, 'useinstead'))?.trim() || '';
        if (!root || !osName || !useInstead) return [];

        const transformsObject = findObject(rule, 'pathtransforms');
        const transforms = values(transformsObject).flatMap((transformValue) => {
            const transform = objectValue(transformValue);
            if (!transform) return [];
            const find = stringValue(findKey(transform, 'find')) ?? '';
            const replace = stringValue(findKey(transform, 'replace')) ?? '';
            return find ? [{ find, replace }] : [];
        });

        return [{ root, os: osName, useInstead, transforms }];
    });
}

function platformMatches(value: string, platform: NodeJS.Platform): boolean {
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (platform === 'win32') return normalized === 'windows' || normalized === 'win32';
    if (platform === 'darwin') return normalized === 'macos' || normalized === 'mac' || normalized === 'osx';
    return normalized === 'linux' || normalized === 'steamos';
}

function ruleAllowsPlatform(rule: SaveRule, platform: NodeJS.Platform): boolean {
    if (rule.platforms.length === 0) return true;
    return rule.platforms.some((candidate) => platformMatches(candidate, platform));
}

function rootFamily(root: string): 'all' | 'windows' | 'macos' | 'linux' | 'unknown' {
    const normalized = normalizeRootName(root);
    if (
        normalized === 'gameinstall'
        || normalized === 'appinstalldirectory'
        || normalized === 'steamuserdata'
        || normalized === 'steamuserbasestorage'
        || normalized === 'steamclouddocuments'
        || normalized === 'default'
    ) return 'all';
    if (normalized.startsWith('win') || normalized === 'windowshome') return 'windows';
    if (normalized.startsWith('mac')) return 'macos';
    if (normalized.startsWith('linux')) return 'linux';
    return 'unknown';
}

function rootIsNativeForPlatform(root: string, platform: NodeJS.Platform): boolean {
    const family = rootFamily(root);
    if (family === 'all') return true;
    if (platform === 'win32') return family === 'windows';
    if (platform === 'darwin') return family === 'macos';
    return family === 'linux';
}

function broadPattern(pattern: string): boolean {
    const compact = pattern.trim().replace(/\s+/g, '');
    return compact === '*' || compact === '*.*';
}

function carrierPattern(pattern: string): boolean {
    const compact = pattern.trim();
    if (!compact || compact.includes('/') || compact.includes('\\')) return false;
    if (!compact.includes('*') && !compact.includes('?')) return false;
    // A wildcard namespace lets VaporStow create its own physical carrier files
    // without overwriting a game's exact save/config filename. Character-class
    // glob syntax is left unsupported until it can be generated unambiguously.
    return !/[<>:\"|\[\]{}]/.test(compact);
}

function normalizeRootName(root: string): string {
    return root.trim().replace(/^%|%$/g, '').toLowerCase();
}

function safeRelativePath(value: string): string | null {
    const normalized = value
        .replace(/\\/g, '/')
        .replace(/^\.?\/+/, '')
        .replace(/^\.\/?$/, '')
        .replace(/^\/+/, '');
    if (!normalized || normalized === '.') return '';
    const segments = normalized.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..')) return null;
    return segments.join(path.sep);
}

function sandboxHomeForSteam(steamRoot: string, home: string): string {
    const normalized = path.normalize(steamRoot);
    const flatpakMarker = path.join('.var', 'app', 'com.valvesoftware.Steam');
    if (normalized.includes(flatpakMarker)) return path.join(home, '.var', 'app', 'com.valvesoftware.Steam');
    const snapMarker = path.join('snap', 'steam', 'common');
    if (normalized.includes(snapMarker)) return path.join(home, 'snap', 'steam', 'common');
    return home;
}

function rootBase(
    root: string,
    context: CloudContext,
    steamRoot: string,
    appId: string,
    proton: boolean
): string | null {
    const normalized = normalizeRootName(root);
    const realHome = os.homedir();
    const home = process.platform === 'linux' ? sandboxHomeForSteam(steamRoot, realHome) : realHome;

    if (normalized === 'gameinstall' || normalized === 'appinstalldirectory') return context.installedDir;

    if (proton && process.platform === 'linux') {
        if (!context.installedLibrary) return null;
        const prefixHome = path.join(
            context.installedLibrary,
            'steamapps',
            'compatdata',
            appId,
            'pfx',
            'drive_c',
            'users',
            'steamuser'
        );
        if (normalized === 'winmydocuments') return path.join(prefixHome, 'Documents');
        if (normalized === 'winappdatalocal') return path.join(prefixHome, 'AppData', 'Local');
        if (normalized === 'winappdatalocallow') return path.join(prefixHome, 'AppData', 'LocalLow');
        if (normalized === 'winappdataroaming') return path.join(prefixHome, 'AppData', 'Roaming');
        if (normalized === 'winsavedgames') return path.join(prefixHome, 'Saved Games');
        if (normalized === 'winprogramdata') return path.join(prefixHome, '..', '..', 'ProgramData');
        if (normalized === 'windowshome') return prefixHome;
        if (normalized === 'steamclouddocuments') return path.join(prefixHome, 'Documents', 'Steam Cloud');
        return null;
    }

    if (process.platform === 'win32') {
        const userProfile = process.env.USERPROFILE || home;
        if (normalized === 'winmydocuments') return path.join(userProfile, 'Documents');
        if (normalized === 'winappdatalocal') return process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
        if (normalized === 'winappdatalocallow') return path.join(userProfile, 'AppData', 'LocalLow');
        if (normalized === 'winappdataroaming') return process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
        if (normalized === 'winsavedgames') return path.join(userProfile, 'Saved Games');
        if (normalized === 'winprogramdata') return process.env.ProgramData || path.join(path.parse(userProfile).root, 'ProgramData');
        if (normalized === 'windowshome') return userProfile;
        if (normalized === 'steamclouddocuments') return path.join(userProfile, 'Documents', 'Steam Cloud');
    }

    if (process.platform === 'darwin') {
        if (normalized === 'machome') return home;
        if (normalized === 'macappsupport') return path.join(home, 'Library', 'Application Support');
        if (normalized === 'macdocuments') return path.join(home, 'Documents');
        if (normalized === 'maccaches') return path.join(home, 'Library', 'Caches');
        if (normalized === 'steamclouddocuments') return path.join(home, 'Documents', 'Steam Cloud');
    }

    if (process.platform === 'linux') {
        if (normalized === 'linuxhome') return home;
        if (normalized === 'linuxxdgdatahome') return process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
        if (normalized === 'linuxxdgconfighome') return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        if (normalized === 'steamclouddocuments') return path.join(home, '.SteamCloud');
    }

    const accountId = steam3AccountId(context.steamId64);
    if (accountId) {
        if (normalized === 'default') return path.join(steamRoot, 'userdata', accountId, appId, 'remote');
        if (normalized === 'steamuserdata' || normalized === 'steamuserbasestorage') {
            return path.join(steamRoot, 'userdata', accountId, appId);
        }
    }

    return null;
}

function substituteSteamIds(value: string, steamId64: string | null): string {
    const accountId = steam3AccountId(steamId64) ?? '';
    return value
        .replace(/\{64BitSteamID\}/gi, steamId64 ?? '')
        .replace(/\{Steam3AccountID\}/gi, accountId);
}

function applyTransforms(value: string, transforms: RootOverride['transforms']): string {
    let result = value;
    for (const transform of transforms) result = result.split(transform.find).join(transform.replace);
    return result;
}

function matchingOverride(rule: SaveRule, overrides: RootOverride[], platform: NodeJS.Platform): RootOverride | null {
    return overrides.find((override) => (
        normalizeRootName(override.root) === normalizeRootName(rule.root)
        && platformMatches(override.os, platform)
    )) ?? null;
}

function resolveRuleCandidate(
    rule: SaveRule,
    overrides: RootOverride[],
    platform: NodeJS.Platform
): ResolvedRule | null {
    const direct = rule.recursive && broadPattern(rule.pattern);
    const carrier = !direct && carrierPattern(rule.pattern);
    if (!direct && !carrier) return null;

    const storageMode = direct ? 'direct' : 'carrier';
    const questionWildcards = (rule.pattern.match(/\?/g) ?? []).length;
    const patternBonus = broadPattern(rule.pattern)
        ? 10
        : rule.pattern.includes('*')
            ? 8
            : Math.min(6, questionWildcards);
    const recursiveBonus = rule.recursive ? 4 : 0;
    const directBonus = direct ? 40 : 0;

    const override = matchingOverride(rule, overrides, platform);
    if (override && ruleAllowsPlatform(rule, platform) && rootIsNativeForPlatform(override.useInstead, platform)) {
        return {
            root: override.useInstead,
            relativePath: applyTransforms(rule.relativePath, override.transforms),
            pattern: rule.pattern,
            recursive: rule.recursive,
            native: true,
            proton: false,
            storageMode,
            score: 130 + directBonus + patternBonus + recursiveBonus
        };
    }

    if (ruleAllowsPlatform(rule, platform) && rootIsNativeForPlatform(rule.root, platform)) {
        return {
            root: rule.root,
            relativePath: rule.relativePath,
            pattern: rule.pattern,
            recursive: rule.recursive,
            native: true,
            proton: false,
            storageMode,
            score: 110 + directBonus + patternBonus + recursiveBonus
        };
    }

    if (platform === 'linux') {
        const windowsAllowed = rule.platforms.length === 0
            ? rootFamily(rule.root) === 'windows'
            : rule.platforms.some((candidate) => platformMatches(candidate, 'win32'));
        const root = normalizeRootName(rule.root);
        const protonResolvable = rootFamily(rule.root) === 'windows'
            || root === 'gameinstall'
            || root === 'appinstalldirectory';
        if (windowsAllowed && protonResolvable) {
            return {
                root: rule.root,
                relativePath: rule.relativePath,
                pattern: rule.pattern,
                recursive: rule.recursive,
                native: false,
                proton: true,
                storageMode,
                score: 70 + directBonus + patternBonus + recursiveBonus
            };
        }
    }

    return null;
}

function chooseRules(ufs: VdfObject): ResolvedRule[] {
    const overrides = rootOverrides(ufs);
    return saveRules(ufs)
        .map((rule) => resolveRuleCandidate(rule, overrides, process.platform))
        .filter((rule): rule is ResolvedRule => Boolean(rule))
        .sort((left, right) => right.score - left.score);
}

function currentDepotOsNames(): string[] {
    if (process.platform === 'win32') return ['windows', 'win32'];
    if (process.platform === 'darwin') return ['macos', 'mac', 'osx'];
    return ['linux', 'steamos', 'windows', 'win32'];
}

function depotMatchesCurrentPlatform(depot: VdfObject): boolean {
    const config = findObject(depot, 'config');
    const osList = stringValue(findKey(config, 'oslist'))?.trim().toLowerCase();
    if (!osList) return true;
    const values = osList.split(/[;,\s]+/).filter(Boolean);
    const allowed = currentDepotOsNames();
    return values.some((value) => allowed.includes(value));
}

function publicManifestSize(depot: VdfObject): number {
    const manifests = findObject(depot, 'manifests');
    const publicManifest = findObject(manifests, 'public');
    const publicSize = Math.floor(numberValue(findKey(publicManifest, 'size')) ?? 0);
    if (publicSize > 0) return publicSize;

    const maxSize = Math.floor(numberValue(findKey(depot, 'maxsize')) ?? 0);
    if (maxSize > 0) return maxSize;
    return Math.floor(numberValue(findKey(depot, 'size')) ?? 0);
}

function estimateInstallSizeBytes(data: VdfObject): number {
    const depots = findObject(data, 'depots');
    if (!depots) return 0;

    let baseBytes = 0;
    const localizedTotals = new Map<string, number>();

    for (const [depotId, value] of Object.entries(depots)) {
        if (!/^\d+$/.test(depotId)) continue;
        const depot = objectValue(value);
        if (!depot || !depotMatchesCurrentPlatform(depot)) continue;

        if (findKey(depot, 'dlcappid') !== undefined || findKey(depot, 'optional') !== undefined) continue;

        const size = publicManifestSize(depot);
        if (size <= 0) continue;

        const config = findObject(depot, 'config');
        const language = stringValue(findKey(config, 'language'))?.trim().toLowerCase() || '';
        if (!language) {
            baseBytes += size;
            continue;
        }

        localizedTotals.set(language, (localizedTotals.get(language) ?? 0) + size);
    }

    const localizedBytes = Math.max(0, ...localizedTotals.values());
    return baseBytes + localizedBytes;
}

function launchExecutables(config: VdfObject | null): string[] {
    const launch = findObject(config, 'launch');
    if (!launch) return [];
    const hints = new Set<string>();
    for (const value of values(launch)) {
        const entry = objectValue(value);
        const executable = stringValue(findKey(entry, 'executable'))?.trim();
        if (!executable) continue;
        const base = path.basename(executable.replace(/\\/g, '/'));
        if (base) hints.add(base);
        const withoutExtension = base.replace(/\.(exe|x86_64|sh)$/i, '');
        if (withoutExtension) hints.add(withoutExtension);
    }
    return [...hints];
}

const STORE_ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';

function artworkPriority(value: string): number {
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

function artworkUrlsFromCommon(common: VdfObject | null, appId: string): string[] {
    const discovered = new Set<string>();
    const visit = (value: VdfValue | undefined): void => {
        if (typeof value === 'string') {
            const raw = value.trim().replace(/\\/g, '/');
            if (!raw) return;
            const lower = raw.toLowerCase();
            const looksLikeArtwork = /(library_600x900(?:_2x)?\.(?:jpg|png|webp)|library_capsule|hero_capsule|capsule_(?:616x353|467x181|231x87)\.(?:jpg|png|webp)|header\.(?:jpg|png|webp))(?:\?|$)/i.test(lower);
            if (!looksLikeArtwork) return;
            if (/^https?:\/\//i.test(raw)) discovered.add(raw);
            else discovered.add(`${STORE_ASSET_BASE}/${appId}/${raw.replace(/^\/+/, '')}`);
            return;
        }
        const object = objectValue(value);
        if (!object) return;
        for (const child of Object.values(object)) visit(child);
    };
    visit(common ?? undefined);

    const extracted = [...discovered].sort((left, right) => artworkPriority(left) - artworkPriority(right));
    const fallback = [
        `${STORE_ASSET_BASE}/${appId}/library_600x900.jpg`,
        `${STORE_ASSET_BASE}/${appId}/library_600x900_2x.jpg`,
        `${STORE_ASSET_BASE}/${appId}/capsule_616x353.jpg`,
        `${STORE_ASSET_BASE}/${appId}/header.jpg`,
        `${STORE_ASSET_BASE}/${appId}/capsule_231x87.jpg`,
        `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
        `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/capsule_231x87.jpg`
    ];
    return [...new Set([...extracted, ...fallback])];
}

function definitionFromRecord(
    record: AppInfoRecord,
    steamRoot: string,
    options: AppInfoDiscoveryOptions = {}
): GameDefinition | null {
    const common = findObject(record.data, 'common');
    const config = findObject(record.data, 'config');
    const ufs = findObject(record.data, 'ufs');
    if (!ufs) return null;

    const appType = stringValue(findKey(common, 'type'))?.trim().toLowerCase();
    if (appType && appType !== 'game' && appType !== 'application') return null;
    const releaseState = stringValue(findKey(common, 'releasestate'))?.trim().toLowerCase();
    if (releaseState && releaseState !== 'released') return null;
    const isFreeApp = truthyValue(findKey(common, 'isfreeapp'));
    if (options.requireFree && !isFreeApp) return null;

    const compatibleRules = chooseRules(ufs);
    const selected = compatibleRules[0] ?? null;
    if (!selected) return null;

    const quotaBytes = Math.max(0, Math.floor(numberValue(findKey(ufs, 'quota')) ?? 0));
    const maxFiles = Math.max(0, Math.floor(numberValue(findKey(ufs, 'maxnumfiles')) ?? 0));
    if (quotaBytes <= 0 || maxFiles <= 0) return null;

    const name = stringValue(findKey(common, 'name'))?.trim() || `Steam App ${record.appId}`;
    const configuredInstallDir = stringValue(findKey(config, 'installdir'))?.trim() || null;
    const chosenPath = safeRelativePath(selected.relativePath);
    if (chosenPath === null) return null;

    const resolveCloudRoot = (context: CloudContext): string | null => {
        let installedDir = context.installedDir;
        if (!installedDir && context.installedLibrary && configuredInstallDir) {
            installedDir = path.join(context.installedLibrary, 'steamapps', 'common', configuredInstallDir);
        }
        const effectiveContext = { ...context, installedDir };
        const base = rootBase(selected.root, effectiveContext, steamRoot, record.appId, selected.proton);
        if (!base) return null;
        if (/\{(?:64BitSteamID|Steam3AccountID)\}/i.test(chosenPath) && !context.steamId64) return null;
        const substituted = substituteSteamIds(chosenPath, context.steamId64);
        return substituted ? path.join(base, substituted) : base;
    };

    const pathLabel = selected.relativePath && selected.relativePath !== '.'
        ? selected.relativePath.replace(/\\/g, '/')
        : normalizeRootName(selected.root);
    const volumeName = path.basename(pathLabel.replace(/\/$/, '')) || 'Cloud';
    const processHints = new Set<string>([
        name,
        configuredInstallDir || '',
        ...launchExecutables(config)
    ].filter(Boolean));

    return {
        id: `steam-${record.appId}`,
        appId: record.appId,
        name,
        volumeName,
        quotaBytes,
        installSizeFallbackBytes: estimateInstallSizeBytes(record.data),
        maxFiles,
        cloudPattern: `${selected.pattern} · ${selected.recursive ? 'recursive' : 'flat'} · ${selected.storageMode} · ${selected.relativePath || selected.root}`,
        cloudRules: compatibleRules,
        storageMode: selected.storageMode,
        discoverySource: options.discoverySource ?? 'local',
        isFreeApp,
        storePriceCents: isFreeApp ? 0 : null,
        storePriceLabel: isFreeApp ? 'Free' : null,
        artworkUrls: artworkUrlsFromCommon(common, record.appId),
        platforms: [process.platform],
        nativeCloudPlatforms: selected.native ? [process.platform] : [],
        protonExperimental: selected.proton,
        storeUrl: `https://store.steampowered.com/app/${record.appId}/`,
        steamInstallUrl: `steam://install/${record.appId}`,
        steamRunUrl: `steam://run/${record.appId}`,
        processHints: [...processHints],
        windowHints: [name],
        getCloudRoot: resolveCloudRoot
    };
}

function jsonSafeVdfValue(value: VdfValue): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as VdfObject)) {
        output[key] = jsonSafeVdfValue(child);
    }
    return output;
}

export function parseTextAppInfoRecords(
    appInfoText: string,
    wantedAppIds: Set<string> | null = null
): Record<string, Record<string, unknown>> {
    const records = parseTextAppInfo(appInfoText, wantedAppIds);
    const output: Record<string, Record<string, unknown>> = {};
    for (const [appId, record] of records) {
        output[appId] = jsonSafeVdfValue(record.data) as Record<string, unknown>;
    }
    return output;
}

export function cachedAppIdsFromTextAppInfo(
    appInfoText: string,
    wantedAppIds: Set<string>
): Set<string> {
    return new Set(parseTextAppInfo(appInfoText, wantedAppIds).keys());
}

export function discoverSteamCloudGamesFromTextAppInfo(
    appInfoText: string,
    steamRoot: string,
    wantedAppIds: Set<string> | null = null,
    options: AppInfoDiscoveryOptions = {}
): GameDefinition[] {
    const records = parseTextAppInfo(appInfoText, wantedAppIds);
    const definitions: GameDefinition[] = [];
    for (const record of records.values()) {
        const definition = definitionFromRecord(record, steamRoot, options);
        if (definition) definitions.push(definition);
    }
    definitions.sort((left, right) => right.quotaBytes - left.quotaBytes
        || right.maxFiles - left.maxFiles
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    return definitions;
}

function jsonToVdfValue(value: unknown): VdfValue | null {
    if (typeof value === 'string' || typeof value === 'number') return value;
    if (typeof value === 'bigint') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const object: VdfObject = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = jsonToVdfValue(child);
        if (normalized !== null) object[key] = normalized;
    }
    return object;
}

export function discoverSteamCloudGamesFromJsonAppInfo(
    payload: unknown,
    steamRoot: string,
    wantedAppIds: Set<string> | null = null,
    options: AppInfoDiscoveryOptions = {}
): GameDefinition[] {
    const root = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    if (!root) return [];

    const possibleData = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
        ? root.data as Record<string, unknown>
        : root;
    const definitions: GameDefinition[] = [];

    for (const [appId, rawRecord] of Object.entries(possibleData)) {
        if (!/^\d+$/.test(appId)) continue;
        if (wantedAppIds && !wantedAppIds.has(appId)) continue;
        const normalized = jsonToVdfValue(rawRecord);
        const data = objectValue(normalized ?? undefined);
        if (!data) continue;
        const definition = definitionFromRecord({ appId, data }, steamRoot, options);
        if (definition) definitions.push(definition);
    }

    definitions.sort((left, right) => right.quotaBytes - left.quotaBytes
        || right.maxFiles - left.maxFiles
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    return definitions;
}

export async function appInfoRecordsFromAppInfoFile(
    appInfoPath: string,
    wantedAppIds: Set<string> | null = null
): Promise<Record<string, Record<string, unknown>>> {
    let buffer: Buffer;
    try {
        buffer = await fsp.readFile(appInfoPath);
    } catch {
        return {};
    }

    const records = parseAppInfo(buffer, wantedAppIds);
    const output: Record<string, Record<string, unknown>> = {};
    for (const [appId, record] of records) {
        output[appId] = jsonSafeVdfValue(record.data) as Record<string, unknown>;
    }
    return output;
}

export async function cachedAppIdsFromAppInfoFile(
    appInfoPath: string,
    wantedAppIds: Set<string>
): Promise<Set<string>> {
    let buffer: Buffer;
    try {
        buffer = await fsp.readFile(appInfoPath);
    } catch {
        return new Set();
    }
    return new Set(parseAppInfo(buffer, wantedAppIds).keys());
}

export async function discoverSteamCloudGamesFromAppInfoFile(
    appInfoPath: string,
    steamRoot: string,
    wantedAppIds: Set<string> | null = null,
    options: AppInfoDiscoveryOptions = {}
): Promise<GameDefinition[]> {
    let buffer: Buffer;
    try {
        buffer = await fsp.readFile(appInfoPath);
    } catch {
        return [];
    }

    const records = parseAppInfo(buffer, wantedAppIds);
    const definitions: GameDefinition[] = [];
    for (const record of records.values()) {
        const definition = definitionFromRecord(record, steamRoot, options);
        if (definition) definitions.push(definition);
    }

    definitions.sort((left, right) => right.quotaBytes - left.quotaBytes
        || right.maxFiles - left.maxFiles
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    return definitions;
}

async function collectLibraryCacheAppIds(directory: string, ids: Set<string>): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const match = /^(\d+)(?:\.json)?$/i.exec(entry.name);
        if (match) ids.add(match[1]);
    }
}

function appIdSetSignature(ids: Set<string>): string {
    let hash = 2166136261;
    for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) {
        for (let index = 0; index < id.length; index += 1) {
            hash ^= id.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        hash ^= 44;
        hash = Math.imul(hash, 16777619);
    }
    return `${ids.size}:${(hash >>> 0).toString(16)}`;
}

async function locallyReferencedAppIds(
    steamRoot: string,
    libraries: string[],
    steamId64: string | null
): Promise<Set<string>> {
    const ids = new Set<string>();

    await Promise.all(libraries.map(async (library) => {
        const steamapps = path.join(library, 'steamapps');
        try {
            const names = await fsp.readdir(steamapps);
            for (const name of names) {
                const match = /^appmanifest_(\d+)\.acf$/i.exec(name);
                if (match) ids.add(match[1]);
            }
        } catch {
        }
    }));

    const accountId = steam3AccountId(steamId64);
    if (accountId) {
        const userdata = path.join(steamRoot, 'userdata', accountId);
        try {
            const entries = await fsp.readdir(userdata, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && /^\d+$/.test(entry.name)) ids.add(entry.name);
            }
        } catch {
        }

        await collectLibraryCacheAppIds(path.join(userdata, 'config', 'librarycache'), ids);
    }

    return ids;
}

export async function discoverSteamCloudGames(
    steamRoot: string | null,
    libraries: string[],
    steamId64: string | null
): Promise<GameDefinition[]> {
    if (!steamRoot) return [];

    const appInfoPath = path.join(steamRoot, 'appcache', 'appinfo.vdf');
    const libraryKey = [...libraries].sort().join('|');
    const scopeKey = `${appInfoPath}|${libraryKey}|${steamId64 ?? ''}|${process.platform}`;
    const cachedForScope = () => discoveryCache?.scopeKey === scopeKey ? discoveryCache.games : [];

    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
        stat = await fsp.stat(appInfoPath);
    } catch {
        return cachedForScope();
    }

    const referencedIds = await locallyReferencedAppIds(steamRoot, libraries, steamId64);
    const cacheKey = `${scopeKey}|${stat.size}|${stat.mtimeMs}|${appIdSetSignature(referencedIds)}`;
    if (discoveryCache?.key === cacheKey) return discoveryCache.games;

    let buffer: Buffer;
    try {
        buffer = await fsp.readFile(appInfoPath);
    } catch {
        return cachedForScope();
    }

    const records = parseAppInfo(buffer, referencedIds);
    const definitionsByAppId = new Map<string, GameDefinition>();
    for (const record of records.values()) {
        const definition = definitionFromRecord(record, steamRoot, { discoverySource: 'local' });
        if (definition) definitionsByAppId.set(definition.appId, definition);
    }

    for (const previous of cachedForScope()) {
        if (!definitionsByAppId.has(previous.appId) && referencedIds.has(previous.appId)) {
            definitionsByAppId.set(previous.appId, { ...previous, discoverySource: 'local' });
        }
    }

    const definitions = [...definitionsByAppId.values()];
    definitions.sort((left, right) => right.quotaBytes - left.quotaBytes
        || right.maxFiles - left.maxFiles
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    discoveryCache = { key: cacheKey, scopeKey, games: definitions };
    return definitions;
}
