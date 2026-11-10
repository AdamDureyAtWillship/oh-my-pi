/**
 * Automatic compaction must append its entry to the session file, not replace
 * the file. A whole-file rewrite of a long session serializes its entire body
 * in memory (about 1.3 GB extra for a 477 MB journal), so one per compaction
 * multiplies memory and disk writes across every long-running agent.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

describe("automatic compaction on a file-backed session", () => {
	const originalAgentDir = getAgentDir();
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		closeModelCache();
		await tempDir?.remove();
	});

	it("appends the compaction to the same file and keeps the corrected tokensAfter in memory", async () => {
		tempDir = TempDir.createSync("@pi-compaction-keeps-file-");
		setAgentDir(path.join(tempDir.path(), "agent"));
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: Settings.isolated() });
		const registered = modelRegistry.find("anthropic", "claude-haiku-5-5");
		if (!registered) throw new Error("Expected anthropic/claude-haiku-5-5 model in registry");
		// The turn sizes and the 32k bound below assume this window.
		const model = { ...registered, contextWindow: 100_000 };

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdPercent": 40,
				"compaction.thresholdTokens": -1,
				"compaction.keepRecentTokens": 20_000,
				"compaction.reserveTokens": 16_384,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
			}),
			modelRegistry,
			toolRegistry: new Map(),
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "concise summary of earlier turns",
			shortSummary: "concise summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		// In a live agent the eval-state snapshot lands right after the compaction
		// entry, so the post-commit context is larger than the commit-time projection
		// and `tokensAfter` gets corrected after the commit.
		const appendCompaction = sessionManager.appendCompaction.bind(sessionManager);
		vi.spyOn(sessionManager, "appendCompaction").mockImplementation((...args) => {
			const id = appendCompaction(...args);
			sessionManager.appendCustomMessageEntry("eval-state-context", "kernel state ".repeat(2_000), false);
			return id;
		});
		// Turns grow 18k -> 36k -> 54k on a 100k window with a 40% trigger: turn 3 compacts.
		let inodeBeforeCompaction: number | undefined;
		const turnUsages = [18_000, 36_000, 54_000];
		for (let idx = 0; idx < turnUsages.length; idx++) {
			const total = turnUsages[idx];
			const userMsg: Message = {
				role: "user",
				content: [{ type: "text", text: "abc".repeat(4_000) }],
				timestamp: idx * 2 + 1,
			};
			const assistantMsg: Message = {
				role: "assistant",
				content: [{ type: "text", text: "abc".repeat(4_000) }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: total - 9_000,
					output: 9_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: total,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: idx * 2 + 2,
			};
			session.agent.emitExternalEvent({ type: "message_end", message: userMsg });
			if (idx === turnUsages.length - 1) {
				await sessionManager.flush();
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected a session file before the compacting turn");
				inodeBeforeCompaction = fs.statSync(sessionFile).ino;
			}
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
			await session.waitForIdle();
		}
		await sessionManager.flush();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || inodeBeforeCompaction === undefined) throw new Error("Expected a session file");
		expect(fs.statSync(sessionFile).ino).toBe(inodeBeforeCompaction);

		const onDisk = fs
			.readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter(line => line.includes('"type":"compaction"'));
		expect(onDisk).toHaveLength(1);
		const live = sessionManager.getBranch().filter((e): e is CompactionEntry => e.type === "compaction");
		expect(live).toHaveLength(1);
		expect(live[0].tokensAfter).toBeDefined();
		expect(live[0].tokensAfter!).toBeLessThan(live[0].tokensBefore);
		expect(live[0].tokensAfter!).toBeLessThanOrEqual(Math.floor(40_000 * 0.8));
	});
});
