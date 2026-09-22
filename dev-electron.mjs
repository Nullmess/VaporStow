import { spawn } from 'node:child_process';
import electron from 'electron';

const hiddenPatterns = [
    /^Fontconfig warning:/,
    /\bERROR:ui\/gl\/gl_surface_presentation_helper\.cc:\d+\].*GetVSyncParametersIfAvailable\(\) failed/
];

let stderrBuffer = '';
let hideTraceHint = false;

function writeStderrLine(line) {
    const value = line.trimStart();

    if (/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/.test(value)) {
        hideTraceHint = true;
        return;
    }

    if (hideTraceHint && /^\(Use `electron --trace-warnings /.test(value)) {
        hideTraceHint = false;
        return;
    }

    hideTraceHint = false;
    if (hiddenPatterns.some((pattern) => pattern.test(value))) return;
    process.stderr.write(`${line}\n`);
}

const child = spawn(electron, ['.'], {
    env: {
        ...process.env,
        NODE_NO_WARNINGS: '1'
    },
    stdio: ['inherit', 'pipe', 'pipe']
});

child.stdout.pipe(process.stdout);
child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) writeStderrLine(line);
});

child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});

child.on('close', (code) => {
    if (stderrBuffer) writeStderrLine(stderrBuffer);
    process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (!child.killed) child.kill(signal);
    });
}
