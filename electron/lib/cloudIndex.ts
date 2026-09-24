import { app } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GameDefinition, GameId } from '../games';
import { auditRoot, SPLIT_STORAGE_FOLDER } from './cloudFs';

export type CloudIndexEntryType = 'file' | 'directory';

export type CloudIndexSnapshotEntry = {
    path: string;
    parentPath: string;
    name: string;
    type: CloudIndexEntryType;
    size: number;
};

export type CloudIndexSnapshot = {
    gameId: GameId;
    gameName: string;
    volumeName: string;
    cachedAt: string;
    entries: CloudIndexSnapshotEntry[];
};

export type CloudIndexSearchEntry = CloudIndexSnapshotEntry & {
    gameId: GameId;
    gameName: string;
    volumeName: string;
    cachedAt: string;
};

let database: DatabaseSync | null = null;

export function databasePath(): string {
    // En développement, garder la DB à la racine du projet : npm run clean peut
    // ainsi la supprimer sans toucher au reste des données Electron de l'utilisateur.
    if (!app.isPackaged) return path.join(app.getAppPath(), 'cloud-index.db');
    return path.join(app.getPath('userData'), 'cloud-index.db');
}

export function initialize(): void {
    if (database) return;

    const file = databasePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });

    database = new DatabaseSync(file, {
        enableForeignKeyConstraints: true
    });

    // DELETE évite les fichiers persistants -wal/-shm : hors transaction, le cache
    // reste matérialisé par un seul fichier cloud-index.db.
    database.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA temp_store = MEMORY;

        CREATE TABLE IF NOT EXISTS cloud_games (
            game_id TEXT PRIMARY KEY,
            game_name TEXT NOT NULL,
            volume_name TEXT NOT NULL,
            cached_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS cloud_entries (
            id INTEGER PRIMARY KEY,
            game_id TEXT NOT NULL,
            path TEXT NOT NULL,
            parent_path TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('file', 'directory')),
            size INTEGER NOT NULL CHECK(size >= 0),
            FOREIGN KEY(game_id) REFERENCES cloud_games(game_id) ON DELETE CASCADE,
            UNIQUE(game_id, path)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_cloud_entries_name
            ON cloud_entries(name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_cloud_entries_path
            ON cloud_entries(path COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_cloud_entries_game
            ON cloud_entries(game_id);
    `);
}

export function close(): void {
    if (!database) return;
    database.close();
    database = null;
}

function db(): DatabaseSync {
    initialize();
    return database!;
}

function portablePath(root: string, absolute: string): string {
    return path.relative(root, absolute).split(path.sep).filter(Boolean).join('/');
}

function parentPortablePath(relativePath: string): string {
    const parts = relativePath.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function isInternalRootEntry(name: string): boolean {
    return name === SPLIT_STORAGE_FOLDER || name.startsWith(`${SPLIT_STORAGE_FOLDER}.staging-`);
}

export async function snapshotGame(game: GameDefinition, cloudRoot: string): Promise<CloudIndexSnapshot> {
    const root = auditRoot(cloudRoot);
    const entries: CloudIndexSnapshotEntry[] = [];

    if (fs.existsSync(root)) {
        // Steam Cloud ne persiste pas les dossiers vides. On indexe donc un dossier
        // uniquement s'il contient au moins un fichier, directement ou plus bas.
        const walk = async (directory: string, isRoot = false): Promise<boolean> => {
            const dirents = await fsp.readdir(directory, { withFileTypes: true });
            let containsFile = false;

            for (const dirent of dirents) {
                if (isRoot && isInternalRootEntry(dirent.name)) continue;
                if (!dirent.isDirectory() && !dirent.isFile()) continue;

                const absolute = path.join(directory, dirent.name);
                const relative = portablePath(root, absolute);
                if (!relative) continue;

                if (dirent.isDirectory()) {
                    const childContainsFile = await walk(absolute);
                    if (!childContainsFile) continue;

                    entries.push({
                        path: relative,
                        parentPath: parentPortablePath(relative),
                        name: dirent.name,
                        type: 'directory',
                        size: 0
                    });
                    containsFile = true;
                    continue;
                }

                const stat = await fsp.stat(absolute);
                entries.push({
                    path: relative,
                    parentPath: parentPortablePath(relative),
                    name: dirent.name,
                    type: 'file',
                    size: stat.size
                });
                containsFile = true;
            }

            return containsFile;
        };

        await walk(root, true);
    }

    return {
        gameId: game.id,
        gameName: game.name,
        volumeName: game.volumeName,
        cachedAt: new Date().toISOString(),
        entries
    };
}

export function commitSnapshot(snapshot: CloudIndexSnapshot): void {
    const connection = db();
    const upsertGame = connection.prepare(`
        INSERT INTO cloud_games (game_id, game_name, volume_name, cached_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET
            game_name = excluded.game_name,
            volume_name = excluded.volume_name,
            cached_at = excluded.cached_at
    `);
    const clearEntries = connection.prepare('DELETE FROM cloud_entries WHERE game_id = ?');
    const insertEntry = connection.prepare(`
        INSERT INTO cloud_entries (game_id, path, parent_path, name, type, size)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    connection.exec('BEGIN IMMEDIATE');
    try {
        upsertGame.run(snapshot.gameId, snapshot.gameName, snapshot.volumeName, snapshot.cachedAt);
        clearEntries.run(snapshot.gameId);

        for (const entry of snapshot.entries) {
            insertEntry.run(
                snapshot.gameId,
                entry.path,
                entry.parentPath,
                entry.name,
                entry.type,
                Math.max(0, Math.floor(entry.size))
            );
        }

        connection.exec('COMMIT');
    } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
    }
}

export async function rebuildGame(game: GameDefinition, cloudRoot: string): Promise<number> {
    const snapshot = await snapshotGame(game, cloudRoot);
    commitSnapshot(snapshot);
    return snapshot.entries.length;
}

function escapeLike(value: string): string {
    return value.replace(/[\%_]/g, (match) => `\${match}`);
}

export function search(query: string, limit = 120): CloudIndexSearchEntry[] {
    const connection = db();
    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 120;
    const safeLimit = Math.max(1, Math.min(240, normalizedLimit));
    const term = query.trim();

    if (!term) {
        const statement = connection.prepare(`
            SELECT
                e.path,
                e.parent_path AS parentPath,
                e.name,
                e.type,
                e.size,
                g.game_id AS gameId,
                g.game_name AS gameName,
                g.volume_name AS volumeName,
                g.cached_at AS cachedAt
            FROM cloud_entries e
            JOIN cloud_games g ON g.game_id = e.game_id
            WHERE e.type = 'file'
               OR EXISTS (
                    SELECT 1
                    FROM cloud_entries f
                    WHERE f.game_id = e.game_id
                      AND f.type = 'file'
                      AND substr(f.path, 1, length(e.path) + 1) = e.path || '/'
               )
            ORDER BY
                g.cached_at DESC,
                CASE e.type WHEN 'directory' THEN 0 ELSE 1 END,
                e.name COLLATE NOCASE,
                e.path COLLATE NOCASE
            LIMIT ?
        `);
        return statement.all(safeLimit) as CloudIndexSearchEntry[];
    }

    const escaped = escapeLike(term);
    const contains = `%${escaped}%`;
    const prefix = `${escaped}%`;
    const statement = connection.prepare(`
        SELECT
            e.path,
            e.parent_path AS parentPath,
            e.name,
            e.type,
            e.size,
            g.game_id AS gameId,
            g.game_name AS gameName,
            g.volume_name AS volumeName,
            g.cached_at AS cachedAt
        FROM cloud_entries e
        JOIN cloud_games g ON g.game_id = e.game_id
        WHERE (
                e.type = 'file'
                OR EXISTS (
                    SELECT 1
                    FROM cloud_entries f
                    WHERE f.game_id = e.game_id
                      AND f.type = 'file'
                      AND substr(f.path, 1, length(e.path) + 1) = e.path || '/'
                )
              )
          AND (
                e.name LIKE ? ESCAPE '\\' COLLATE NOCASE
             OR e.path LIKE ? ESCAPE '\\' COLLATE NOCASE
             OR g.game_name LIKE ? ESCAPE '\\' COLLATE NOCASE
             OR g.volume_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              )
        ORDER BY
            CASE
                WHEN e.name = ? COLLATE NOCASE THEN 0
                WHEN e.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1
                WHEN e.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 2
                ELSE 3
            END,
            CASE e.type WHEN 'directory' THEN 0 ELSE 1 END,
            e.name COLLATE NOCASE,
            e.path COLLATE NOCASE
        LIMIT ?
    `);

    return statement.all(
        contains,
        contains,
        contains,
        contains,
        term,
        prefix,
        contains,
        safeLimit
    ) as CloudIndexSearchEntry[];
}
