# Changelog

## [1.0.0]

- First stable public release
- Desktop browser and file manager for supported Steam Cloud locations
- Asteroid (`2020850`) and World of Shooting (`1678150`) support
- Automatic Steam detection, launch, cloud restore and synchronization
- Warn on Cloud open that the game may appear briefly and must be left open for VaporStow to manage
- Auto-sync Cloud sessions on window close and after 10 minutes of inactivity
- File and folder import, creation, navigation and deletion
- Compact single-row Cloud toolbar with contextual back navigation and inline actions
- Centered empty-folder state and minimal SVG actions for Import, New folder and Synchronize
- Warn before manual synchronization when the Cloud contains only empty folders; automatic synchronization proceeds silently
- Exclude empty folders from the cached Cloud index and global search
- Remove empty local folders after a successful synchronization so the local mirror matches what Steam Cloud can persist
- Large-file splitting above 100 MiB with automatic reconstruction
- Incremental chunk synchronization for large files
- SHA-256 integrity verification for split files
- Real Steam Cloud upload and download progress with speed and ETA
- Storage usage and available file-slot tracking
- Windows, Linux and macOS targets
- Retry game launch after Steam updates can consume the initial launch request.
