import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
    console.error("VaporStow macOS DMG packaging must run on macOS.");
    console.error("Use GitHub Actions > Build release, or run npm run build-mac on a Mac.");
    process.exit(1);
}

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(command, ["run", "build:mac-native"], {
    stdio: "inherit"
});

process.exit(result.status ?? 1);
