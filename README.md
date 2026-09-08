# <h1 align="center">VaporStow</h1>

> ☁️ Cross-platform Steam Cloud file manager for supported games.

![VaporStow desktop preview](assets/desktop.png)

---

## ✨ Features

- Browse files in supported Steam Cloud locations
- Manage files and folders through a local desktop interface
- Automatic handling of large files within supported file-size limits
- Incremental synchronization to avoid unnecessary data transfers
- SHA-256 integrity checks
- Steam Cloud upload and download progress
- Transfer speed, ETA, and current-file tracking
- Storage usage and available file-slot tracking
- Automatic Steam detection, launch, and synchronization
- Open or reveal files in the system file manager

## 🎮 Supported Games

- Asteroid (`2020850`)
- World of Shooting (`1678150`)

---

## 🚀 Usage

VaporStow development uses **Node.js 22.x**.

### Normal workflow

```shell
fnm use 22
npm install
npm run dev
```

### Run the built desktop app

```shell
npm run app
```

### Build

```shell
npm run build
```

### Platform packages

#### Windows

```shell
npm run build-win
```

#### Linux

```shell
npm run build-lin
```

#### macOS

```shell
npm run build-mac
```

#### All targets

```shell
npm run build-all
```

### Clean

Remove generated files and installed dependencies:

```shell
npm run clean
```

---

## ⚖️ Disclaimer and Intended Use

VaporStow is an independent open-source project and is not affiliated with,
endorsed by, or sponsored by Valve Corporation or Steam.

VaporStow manages files through Steam Cloud locations associated with supported
games and relies on Steam's own synchronization mechanisms.

VaporStow operates within the storage quotas, file limits, and synchronization
mechanisms provided by Steam and supported games. It does not modify Steam,
Steam Cloud quotas, or Steam authentication data.

Users are responsible for ensuring that files managed with VaporStow comply
with applicable Steam policies, game-specific requirements, and applicable
laws.

The authors are not responsible for misuse of the software or for content
stored, uploaded, downloaded, or synchronized by users.

The software is provided "as is", without warranty of any kind, as described
in the MIT License.

---

## 👥 Authors

- [Nullmess](https://github.com/Nullmess)
- [Ybucaille](https://github.com/Ybucaille)

Give a ⭐️ if VaporStow helped you!

---

## 📝 License

Copyright © 2026 [Nullmess](https://github.com/Nullmess) & [Ybucaille](https://github.com/Ybucaille).<br />
This project is licensed under the MIT License.
