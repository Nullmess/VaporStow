# Changelog

- Fixed startup sequencing so the splash finishes before the home cards reveal and controls become interactive.
## Unreleased
- Redesign Cloud loading and explorer views to match the Big Picture home visual language and smooth phase transitions.
- Fixed startup sequencing so Cloud cards stay hidden until their reveal animation begins.
- Refine the Linux Big Picture shell with fullscreen controls, staged startup cards, and lightweight ambient motion.
- Simplify the install modal and present required disk space as a clear addition with a separated total.
- Fix side-card clicks so the exact clicked card is centered in the infinite carousel.
- Rebuild the home carousel around a centered Big Picture-style spring, click-to-focus cards and inertial snap navigation.
- Make carousel focus interpolate continuously from viewport position during drag and inertia.

- Add inertial infinite Cloud carousel with three focused cards
- Fade non-focused cards and stabilize the initial carousel position
- Fix card buttons so drag gestures no longer steal clicks
- Refresh modal styling and actions

## [1.0.0]

- First stable public release
- Browse and manage supported Steam Cloud files
- Support for Asteroid (`2020850`) and World of Shooting (`1678150`)
- Automatic Steam detection, Cloud restore and synchronization
- Auto-sync on window close and after 10 minutes of inactivity
- Import, create, navigate and delete files and folders
- Cached Cloud search from the home screen
- Large-file support above 100 MiB with automatic splitting and reconstruction
- Real Steam Cloud transfer progress with speed and ETA
- Storage usage and available file-slot tracking
- Windows, Linux and macOS support
- Center Cloud loading feedback, animate status direction, and reverse the card morph when returning home.
