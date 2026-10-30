import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession persistence-keys cache", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let authDir: TempDir;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authDir = TempDir.createSync("@pi-cache-auth-");
		authStorage = await AuthStorage.create(authDir.join("auth.db"));
		modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		authDir.removeSync();
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-cache-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const tools: AgentTool[] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("bundled model claude-sonnet-4-5 not found");
		}
		const agent = new Agent({
			getApiKey: () => "fake-key",
			initialState: { model, systemPrompt: [], tools },
		});

		sessionManager = SessionManager.create(tempDir, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});

		session.subscribe(() => {});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("does not duplicate a message on re-persist attempts", async () => {
		const msg: AgentMessage = { role: "user", content: [{ type: "text", text: "Hello cache" }], timestamp: 1000 };

		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		const count1 = sessionManager.getBranch().filter(e => e.type === "message").length;
		expect(count1).toBe(1);

		// Re-emit should be ignored due to cache
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		const count2 = sessionManager.getBranch().filter(e => e.type === "message").length;
		expect(count2).toBe(1);
	});

	it("caches missing-key checks across a growing branch", async () => {
		const getBranch = spyOn(sessionManager, "iterateBranch");

		try {
			for (let i = 0; i < 25; i++) {
				const msg: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: `Cache perf ${i}` }],
					timestamp: 2000 + i,
				};
				session.agent.emitExternalEvent({ type: "message_end", message: msg });
				await sessionManager.flush();
				for (let spin = 0; spin < 5; spin++) {
					await Promise.resolve();
				}
			}

			expect(getBranch).toHaveBeenCalledTimes(1);
		} finally {
			getBranch.mockRestore();
		}

		const entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(25);
	});

	it("reads only new entries when other entries land between messages", async () => {
		const iterateBranch = spyOn(sessionManager, "iterateBranch");

		try {
			for (let i = 0; i < 25; i++) {
				// Tool starts, model changes and extension entries all move the leaf.
				sessionManager.appendCustomEntry("cache-test", { i });
				const msg: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: `Interleaved ${i}` }],
					timestamp: 3000 + i,
				};
				session.agent.emitExternalEvent({ type: "message_end", message: msg });
				await sessionManager.flush();
				for (let spin = 0; spin < 5; spin++) {
					await Promise.resolve();
				}
			}

			expect(iterateBranch).toHaveBeenCalledTimes(1);
		} finally {
			iterateBranch.mockRestore();
		}

		const entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(25);
	});

	it("does not duplicate a message another writer appended after the keys were read", async () => {
		const first: AgentMessage = { role: "user", content: [{ type: "text", text: "First" }], timestamp: 4000 };
		session.agent.emitExternalEvent({ type: "message_end", message: first });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		const direct: AgentMessage = { role: "user", content: [{ type: "text", text: "Direct" }], timestamp: 4001 };
		sessionManager.appendCustomEntry("cache-test", {});
		sessionManager.appendMessage(direct);
		session.agent.emitExternalEvent({ type: "message_end", message: direct });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		const entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.map(entry => entry.message)).toEqual([first, direct]);
	});

	it("does not duplicate a message whose persisted identity was edited in place", async () => {
		const message: AgentMessage = { role: "user", content: [{ type: "text", text: "Edited" }], timestamp: 101 };
		session.agent.emitExternalEvent({ type: "message_end", message });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		const persisted = sessionManager.getBranch().find(entry => entry.type === "message");
		if (persisted?.type !== "message") throw new Error("Missing persisted message");

		// An edit announced before another entry moves the leaf, then one announced with the leaf still.
		for (const [timestamp, moveLeaf] of [
			[102, true],
			[103, false],
		] as const) {
			persisted.message.timestamp = timestamp;
			sessionManager.updateEntry(persisted);
			if (moveLeaf) sessionManager.appendCustomEntry("cache-test", {});
			session.agent.emitExternalEvent({ type: "message_end", message: { ...message, timestamp } });
			await sessionManager.flush();
			for (let i = 0; i < 5; i++) await Promise.resolve();
		}

		const entries = sessionManager.getBranch().filter(entry => entry.type === "message");
		expect(entries.map(entry => entry.message.timestamp)).toEqual([103]);
	});

	it("persists a mid-run turn whose key was superseded by two announced identity edits", async () => {
		await session.dispose();
		sessionManager = SessionManager.inMemory(tempDir);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing bundled model");
		let networkAttempts = 0;
		const agent = new Agent({
			initialState: { model, systemPrompt: [], tools: [] },
			streamFn: () => {
				networkAttempts++;
				throw new Error("Unexpected provider request");
			},
		});
		const setOnTurnEnd = spyOn(agent, "setOnTurnEnd");
		try {
			session = new AgentSession({
				agent,
				sessionManager,
				modelRegistry,
				settings: Settings.isolated({
					"compaction.enabled": true,
					"compaction.midTurnEnabled": true,
					"compaction.asyncEnabled": false,
					"compaction.idleEnabled": false,
					"compaction.autoContinue": false,
					"compaction.thresholdTokens": 100,
					"compaction.keepRecentTokens": 100_000,
					"contextPromotion.enabled": false,
				}),
			});
			const onTurnEnd = setOnTurnEnd.mock.calls[0]?.[0];
			if (!onTurnEnd) throw new Error("Missing turn-end callback");
			session.subscribe(() => {});
			const original = { ...createAssistantMessage("Original"), timestamp: 101 };
			agent.emitExternalEvent({ type: "message_end", message: original });
			await sessionManager.flush();
			for (let i = 0; i < 5; i++) await Promise.resolve();
			const persisted = sessionManager.getBranch().find(entry => entry.type === "message");
			if (persisted?.type !== "message") throw new Error("Missing persisted message");
			persisted.message.timestamp = 102;
			sessionManager.updateEntry(persisted);
			agent.emitExternalEvent({
				type: "message_end",
				message: { role: "user", content: "Catch up the memo", timestamp: 201 },
			});
			await sessionManager.flush();
			for (let i = 0; i < 5; i++) await Promise.resolve();
			persisted.message.timestamp = 103;
			sessionManager.updateEntry(persisted);
			sessionManager.appendCustomEntry("cache-test", {});
			const current = { ...createAssistantMessage("Missing turn"), timestamp: 102 };
			current.usage.input = 200_000;
			agent.replaceMessages([current]);
			await onTurnEnd(agent.state.messages, undefined, {
				message: current,
				toolResults: [],
				willContinue: true,
			});
			expect(
				sessionManager
					.getBranch()
					.filter(entry => entry.type === "message" && entry.message.role === "assistant")
					.map(entry => entry.type === "message" && entry.message.timestamp),
			).toEqual([103, 102]);
			expect(networkAttempts).toBe(0);
		} finally {
			setOnTurnEnd.mockRestore();
		}
	});

	it("reflects the NEW branch after a rewind (stale cache would wrongly skip)", async () => {
		// 1. Send first message (assistant)
		const msg1: AssistantMessage = createAssistantMessage("Msg 1");
		session.agent.emitExternalEvent({ type: "message_end", message: msg1 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// 2. Send second message (user)
		const msg2: AgentMessage = { role: "user", content: [{ type: "text", text: "Msg 2" }], timestamp: 1002 };
		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		let entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(2);

		// 3. Rewind to msg1 (by navigating to the assistant message msg1)
		// This sets the leaf exactly to msg1.
		const msg1EntryId = entries[0].id;
		const navResult = await session.navigateTree(msg1EntryId, { summarize: false });
		expect(navResult.cancelled).toBe(false);

		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Confirm rewind occurred (only msg1 remains)
		entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(1);
		expect(entries[0].message.role).toBe("assistant");

		// 4. Send msg2 AGAIN
		// If cache wasn't invalidated on rewind, it remembers msg2 and wrongly skips it.
		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Cache must be invalidated, so the re-persist succeeds.
		entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(2);
		expect(entries[1].message.role).toBe("user");
	});
});
