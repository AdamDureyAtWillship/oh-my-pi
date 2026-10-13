import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	hasFileAsPathComponent,
	loadSessionFile,
	loadSessionMessagesReadOnly,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	vi.restoreAllMocks();
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
});

// Windows reports ENOENT (not ENOTDIR) when a path component is a regular
// file; all session loaders must keep the ENOTDIR rejection POSIX produces so
// a malformed session path is not masked as a missing session.
describe("loadSessionFile path errors", () => {
	it("detects a file component by inspecting the leaf and climbing", async () => {
		await using dir = await TempDir.create("omp-session-enotdir-");
		const file = path.join(dir.path(), "plain-file.txt");
		await Bun.write(file, "not a directory");
		// A component below the file, and the file named as a directory
		// (trailing separator), both resolve to a non-directory leaf.
		expect(await hasFileAsPathComponent(path.join(file, "sub", "session.jsonl"))).toBe(true);
		expect(await hasFileAsPathComponent(`${file}${path.sep}`)).toBe(true);
		expect(await hasFileAsPathComponent(path.join(dir.path(), "missing", "session.jsonl"))).toBe(false);
	});

	it("rejects a session path with a regular-file component", async () => {
		await using dir = await TempDir.create("omp-session-enotdir-");
		const file = path.join(dir.path(), "plain-file.txt");
		await Bun.write(file, "not a directory");
		const sessionPath = path.join(file, "sub", "session.jsonl");
		await expect(loadSessionFile(sessionPath)).rejects.toMatchObject({ code: "ENOTDIR" });
		await expect(loadSessionFile(sessionPath, undefined, { throwIfMissing: true })).rejects.toMatchObject({
			code: "ENOTDIR",
		});
		for (const throwIfMissing of [false, true]) {
			await expect(
				SessionManager.open(sessionPath, dir.path(), undefined, { throwIfMissing, suppressBreadcrumb: true }),
			).rejects.toMatchObject({ code: "ENOTDIR" });
		}
		await expect(loadSessionMessagesReadOnly(sessionPath)).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	it("normalizes Windows ENOENT for a regular-file component when resuming or reading history", async () => {
		await using dir = await TempDir.create("omp-session-enotdir-");
		const file = path.join(dir.path(), "plain-file.txt");
		await Bun.write(file, "not a directory");
		const sessionPath = path.join(file, "sub", "session.jsonl");
		const realOpenSync = fs.openSync;
		const missing = Object.assign(new Error("ENOENT: no such file or directory, open"), {
			code: "ENOENT",
			path: sessionPath,
			syscall: "open",
		});
		if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		const open = vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
			if (String(filePath) === sessionPath) throw missing;
			return realOpenSync(filePath, flags, mode);
		});

		for (const throwIfMissing of [false, true]) {
			await expect(
				SessionManager.open(sessionPath, dir.path(), undefined, { throwIfMissing, suppressBreadcrumb: true }),
			).rejects.toMatchObject({ code: "ENOTDIR", path: sessionPath });
		}
		await expect(loadSessionMessagesReadOnly(sessionPath)).rejects.toMatchObject({
			code: "ENOTDIR",
			path: sessionPath,
		});
		expect(open).toHaveBeenCalledWith(sessionPath, "r");
	});

	it("keeps ordinary missing-session behavior on Windows", async () => {
		await using dir = await TempDir.create("omp-session-enotdir-");
		const sessionPath = path.join(dir.path(), "missing", "session.jsonl");
		if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });

		expect((await loadSessionFile(sessionPath)).entries).toEqual([]);
		await expect(loadSessionFile(sessionPath, undefined, { throwIfMissing: true })).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await loadSessionMessagesReadOnly(sessionPath)).toEqual([]);
		await expect(
			SessionManager.open(sessionPath, dir.path(), undefined, { throwIfMissing: true, suppressBreadcrumb: true }),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await Bun.file(sessionPath).exists()).toBe(false);

		const manager = await SessionManager.open(sessionPath, dir.path(), undefined, {
			initialCwd: dir.path(),
			throwIfMissing: false,
			suppressBreadcrumb: true,
		});
		try {
			expect(manager.getSessionFile()).toBe(path.resolve(sessionPath));
			expect(await Bun.file(sessionPath).exists()).toBe(true);
		} finally {
			await manager.close();
		}
	});
});
