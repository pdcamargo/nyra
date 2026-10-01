#!/usr/bin/env node
/**
 * `tauri dev`, passive unless told otherwise.
 *
 * This was `NYRA_DEV_PASSIVE=1 tauri dev` in package.json, which is POSIX shell
 * syntax: on Windows npm runs scripts through `cmd.exe`, which reads the whole
 * thing as a command called `NYRA_DEV_PASSIVE=1`. Setting the variable here
 * works the same everywhere. `--active` drops it, for `npm run dev:active`.
 *
 * Signals are passed on, so stopping this stops Tauri with it rather than
 * leaving the dev binary and everything it spawned behind.
 */
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const active = args.includes('--active')
const env = { ...process.env }
if (active) delete env.NYRA_DEV_PASSIVE
else env.NYRA_DEV_PASSIVE = '1'

// Dev and the installed app share an identifier, so on Windows they would share
// one WebView2 profile under %LOCALAPPDATA%\com.nyra.app. WebView2 will not open
// a second app on a profile already in use with different options: the dev
// window stays hidden and never loads. Its own folder sidesteps that.
if (process.platform === 'win32' && !env.WEBVIEW2_USER_DATA_FOLDER && env.LOCALAPPDATA) {
  env.WEBVIEW2_USER_DATA_FOLDER = `${env.LOCALAPPDATA}\\com.nyra.app.dev\\EBWebView`
}

// npm puts node_modules/.bin on PATH; a shell is what resolves `tauri.cmd` there.
const child = spawn('tauri', ['dev', ...args.filter((a) => a !== '--active')], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
