# Changelog

## [1.0.1]

- Reworked the home screen around the Steam Cloud list returned by the backend.
- Added centered `All`, `Favorites`, `Installed`, and `Not installed` Cloud filters above the Cloud cards.
- Added an animated magnifier control that expands into `Search cloud...` when clicked and filters Clouds by game, volume, AppID, or Cloud pattern.
- Added persistent favorite buttons on Cloud cards.
- Kept cached file search available with `Ctrl+Shift+F`; `Ctrl+F` expands and focuses Cloud search.
- Removed the home `VaporStow`/`Steam Clouds` headings so the main view stays focused on filters and cards; the product title remains in the information modal.
- Added responsive empty states and mobile layouts for the new home controls.
- Made the one/two-Cloud carousel visually circular: one visible Cloud is repeated on both sides (`A · A · A`), while two visible Clouds mirror the opposite Cloud on both sides (`B · A · B`), so dragging, wheel, click, and keyboard navigation never expose an empty edge.

## [1.0.0]

- First stable public release.
- Steam Cloud browser and manager.
- Supports NekoDice, Asteroid, Hunt For Gods and World of Shooting.
- Automatic Steam detection, restore and synchronization.
- Import, create, search, reveal and delete files and folders.
- Home and Cloud search with `Ctrl+F` / `Cmd+F`.
- Cloud usage, file limits and transfer progress.
- Large-file splitting and reconstruction.
- Auto-sync on close and inactivity.
- Big Picture carousel and animated Cloud transitions.
- Fullscreen controls and contributor information.
- Windows, Linux and macOS support.
- Refined home alignment: larger filter controls remain fully visible, stay fixed when no cards are visible, and the Steam status sits closer to the filter row.
- Game artwork frames now follow each image's real aspect ratio instead of forcing a square container.
- Fixed live-resize card geometry: cards now keep a stable aspect ratio, fit the real remaining carousel height, use a compact layout on short windows, and no longer clip when the window is reduced vertically.
- Improved low-height responsive mode: cards now shrink artwork and spacing first while keeping home-card text readable instead of becoming tiny.
- Stabilized home scaling across window sizes: cards keep a consistent target size, side cards may clip on narrow windows, and the carousel no longer grows vertically on large displays.
- Rebalanced the home-card interior without changing outer card geometry: larger artwork, proportional title/usage/action sizing, and stable bottom action placement across window sizes.
- Centered the home carousel vertically inside the full remaining viewport on tall windows while keeping the filter row anchored.
- Moved the Steam status indicator into the Linux window-control cluster, immediately to the left of the Information button.
- Restored the home-screen Ctrl/Cmd+F shortcut to the global cached-file search modal; Cloud-name search now opens only from the home loupe.
- Reworked startup sequencing into one persistent splash and one whole-app reveal, removing duplicate boot animations and flashes of Steam controls, filters, and cards.
- Preload GitHub contributor avatars during startup and use direct avatar CDN URLs so the Info modal opens with profile images already cached.
- Expanded the opened Cloud workspace upward on Linux by collapsing the unused header gap beneath the fixed Steam/info/fullscreen/close controls.
- Centered the home carousel on the true viewport Y midpoint on normal/tall windows, with compact-height fallback to prevent overlap.
- Fixed true fullscreen Y-centering of home cards by removing the lingering stage transform that made fixed carousel positioning relative to the stage instead of the viewport.
- Prevented home filter/card overlap at intermediate window heights by constraining the carousel center against the live filter-row bounds while preserving true viewport centering whenever space allows.
- Kept the selected home card pinned to its exact carousel position while opening/synchronizing a Cloud; entering operation mode no longer resets or repositions the carousel.
