// Portable browser-open commands for the manual OMP Stats link (Alt+W `o` and
// /workflow-stats). Lifecycle, probing, and syncing are delegated to the native
// `omp stats` command by workflow-stats-runtime.ts; nothing here touches the
// network or spawns processes.

export type BrowserCommand = { command: string; args: string[] };

export function isWslEnvironment(env: Record<string, string | undefined>): boolean {
	return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV);
}

const SAFE_BROWSER_URL = /^https?:\/\/[^\s"'`<>\\]+$/i;

/**
 * Portable browser-open commands. The URL is always passed as a separate
 * argument, never interpolated into a shell string. Windows uses PowerShell
 * Start-Process with an encoded command, then `cmd /c start` as fallback;
 * WSL tries `wslview` before the Linux openers.
 */
export function browserCommands(
	platform: string,
	env: Record<string, string | undefined>,
	url: string,
): BrowserCommand[] {
	if (!SAFE_BROWSER_URL.test(url)) return [];
	if (platform === "darwin") return [{ command: "open", args: [url] }];
	if (platform === "win32") {
		const systemRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || "C:\\Windows";
		const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
		const script = `$ErrorActionPreference='Stop';Start-Process '${url.replaceAll("'", "''")}'`;
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		return [
			{ command: powershell, args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] },
			{ command: "cmd", args: ["/c", "start", "", url] },
		];
	}
	const commands: BrowserCommand[] = [];
	if (isWslEnvironment(env)) commands.push({ command: "wslview", args: [url] });
	commands.push(
		{ command: "xdg-open", args: [url] },
		{ command: "gio", args: ["open", url] },
		{ command: "sensible-browser", args: [url] },
	);
	return commands;
}
