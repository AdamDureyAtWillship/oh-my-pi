import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { buildSessionData } from "@oh-my-pi/pi-coding-agent/export/html";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import {
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { MODEL_MENTION_ENTRY_TYPE, ModelMentionRegistry } from "@oh-my-pi/pi-coding-agent/session/model-mentions";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type {
	CompactionEntry,
	FileEntry,
	SessionEntry,
	SessionMessageEntry,
	SessionTreeNode,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { PositionedSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { migrateSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	createTodoHudStateData,
	getLatestTodoPhasesFromEntries,
	getTodoHudVisibility,
	isTodoStateEntryMetadata,
	TODO_HUD_STATE_CUSTOM_TYPE,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const timestamp = "2026-01-01T00:00:00.000Z";
const MiB = 1024 * 1024;

function user(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: text, timestamp: 1 } };
}

function assistant(id: string, parentId: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			...makeAssistantMessage(),
			content: [{ type: "text", text }],
			timestamp: new Date(timestamp).getTime() + 1000,
		},
	};
}

function tool(id: string, parentId: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 3,
		},
	};
}

function compact(id: string, parentId: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp,
		firstKeptEntryId,
		summary: `summary-${id}`,
		tokensBefore: 1000,
	};
}

function threeCompactions(oldPayloadChars = MiB): SessionEntry[] {
	return [
		{ type: "model_change", id: "model", parentId: null, timestamp, model: "anthropic/explicit-model" },
		{
			type: "thinking_level_change",
			id: "thinking",
			parentId: "model",
			timestamp,
			thinkingLevel: "high",
			configured: "auto",
		},
		{ type: "mode_change", id: "mode", parentId: "thinking", timestamp, mode: "plan", data: { reason: "old state" } },
		{ type: "ttsr_injection", id: "rules", parentId: "mode", timestamp, injectedRules: ["old-rule"] },
		{ type: "model_change", id: "smol", parentId: "rules", timestamp, model: "openai/small-model", role: "smol" },
		{ type: "credential_pin", id: "pin", parentId: "smol", timestamp, provider: "anthropic", hash: "old-account" },
		user("root", "pin", "первый запрос 🐈\n多字节"),
		tool("old-large", "root", `архив 🐈 ${"x".repeat(oldPayloadChars)}\nконец`),
		{ ...compact("c1", "old-large", "root"), preserveData: { archiveMarker: "первый" } },
		user("kept", "c1", "kept before the second compaction — 🐈"),
		assistant("reply", "kept", "kept reply"),
		compact("c2", "reply", "kept"),
		user("middle", "c2", "between compactions"),
		// c3 keeps a range that crosses c2, not merely the entries after c2.
		compact("c3", "middle", "kept"),
		// A physically newer compaction is on a sibling, not the active path.
		user("sibling", "c1", "sibling request"),
		compact("sibling-compaction", "sibling", "sibling"),
		user("sibling-tail", "sibling-compaction", "sibling continuation"),
		user("tail", "c3", "active continuation"),
	];
}

async function writeJournal(dir: string, entries: SessionEntry[]): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	await Bun.write(
		file,
		[{ type: "session", version: 3, id: "resume-memory", timestamp, cwd: dir }, ...entries]
			.map(entry => JSON.stringify(entry))
			.join("\n") + "\n",
	);
	return file;
}

function treeEdges(nodes: SessionTreeNode[]): [string, string | null][] {
	const edges: [string, string | null][] = [];
	const stack = nodes.map(node => ({ node, parentId: null as string | null }));
	while (stack.length > 0) {
		const { node, parentId } = stack.pop()!;
		edges.push([node.entry.id, parentId]);
		stack.push(...node.children.map(child => ({ node: child, parentId: node.entry.id })));
	}
	return edges.sort(([a], [b]) => a.localeCompare(b));
}

interface HeapProbeResult {
	fixtureBytes: number;
	payloadBytes: number;
	resultCount: number;
	retainedAfterOpenBytes: number;
	retainedAfterDemandBytes: number;
	exactDemandCount: number;
	contextResultCount: number;
}

async function runHeapProbe(mode: "compacted" | "uncompacted" | "agent"): Promise<HeapProbeResult> {
	const probe = path.join(import.meta.dir, "fixtures", "resume-memory-probe.ts");
	const proc = Bun.spawn([process.execPath, "--smol", probe, mode], {
		cwd: path.resolve(import.meta.dir, "../../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as HeapProbeResult;
}

class PublishedRewriteStorage extends FileSessionStorage {
	published = Promise.withResolvers<void>();
	release = Promise.withResolvers<void>();
	armed = false;
	override async writeLinesAtomic(
		file: string,
		content: readonly string[],
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		await super.writeLinesAtomic(file, content, options);
		if (this.armed) {
			this.armed = false;
			this.published.resolve();
			await this.release.promise;
		}
	}
}

describe("bounded resume memory", () => {
	it("does not reread historical tool results while sanitizing resumed assistant metadata", async () => {
		using dir = TempDir.createSync("@resume-sanitize-filter-");
		const file = await writeJournal(dir.path(), threeCompactions(1024));
		const read = spyOn(sessionLoader, "readPositionedSessionEntry");
		let session: SessionManager | undefined;
		try {
			session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
			expect(read.mock.calls.filter(([, position]) => position.id === "old-large")).toHaveLength(0);
			expect(read.mock.calls.some(([, position]) => position.messageRole === "assistant")).toBe(true);
		} finally {
			await session?.close();
			read.mockRestore();
		}
	});

	it("reopens three compactions with an exact kept tail across an older compaction and old replay state", async () => {
		using dir = TempDir.createSync("@resume-three-compactions-");
		const entries = threeCompactions();
		const file = await writeJournal(dir.path(), entries);
		const session = await SessionManager.open(file, dir.path(), undefined, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
		});
		try {
			const context = session.buildSessionContext();
			expect(context).toEqual(buildSessionContext(entries, "tail"));
			expect(context.messages.map(message => message.role)).toEqual([
				"compactionSummary",
				"user",
				"assistant",
				"user",
				"user",
			]);
			expect(context.messages[1]).toMatchObject({ content: "kept before the second compaction — 🐈" });
			expect(context.models).toEqual({ default: "anthropic/explicit-model", smol: "openai/small-model" });
			expect(context.thinkingLevel).toBe("high");
			expect(context.configuredThinkingLevel).toBe("auto");
			expect(session.getLastModelChangeRole()).toBe("smol");
			expect(session.getCredentialPins().get("anthropic")).toEqual({
				hash: "old-account",
				lastUsedAt: new Date(timestamp).getTime() + 1000,
			});
			expect(context.modeData).toEqual({ reason: "old state" });
			expect(context.injectedTtsrRules).toEqual(["old-rule"]);
			expect(session.buildSessionContext({ transcript: true, collapseCompactedHistory: true })).toEqual(
				buildSessionContext(entries, "tail", undefined, { transcript: true, collapseCompactedHistory: true }),
			);
		} finally {
			await session.close();
		}
	});

	it("demand-reads old UTF-8 payloads and restores old and sibling tree branches without changing active context", async () => {
		using dir = TempDir.createSync("@resume-old-branches-");
		const entries = threeCompactions();
		const file = await writeJournal(dir.path(), entries);
		const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			expect(session.getEntry("old-large")).toEqual(entries.find(entry => entry.id === "old-large"));
			expect(session.getEntry("c1")).toEqual(entries.find(entry => entry.id === "c1"));
			expect(session.getEntry("missing")).toBeUndefined();
			expect(treeEdges(session.getTree())).toEqual(
				entries
					.map(entry => [entry.id, entry.parentId] as [string, string | null])
					.sort(([a], [b]) => a.localeCompare(b)),
			);
			expect(session.getBranch("old-large")).toEqual(
				entries.slice(0, entries.findIndex(entry => entry.id === "old-large") + 1),
			);
			const all = session.getEntries();
			expect(all).toEqual(entries);
			all.length = 0;
			expect(session.getEntries()).toEqual(entries);
			expect(session.getLeafId()).toBe("tail");
			for (const leaf of ["old-large", "c1", "sibling-tail", "tail"]) {
				session.branch(leaf);
				expect(session.buildSessionContext()).toEqual(buildSessionContext(entries, leaf));
				expect(session.buildSessionContext({ transcript: true })).toEqual(
					buildSessionContext(entries, leaf, undefined, { transcript: true }),
				);
			}
			expect(() => session.branch("missing")).toThrow("not found");
			expect(session.getLeafId()).toBe("tail");
			expect(session.buildSessionContext()).toEqual(buildSessionContext(entries, "tail"));
		} finally {
			await session.close();
		}
	});

	it("recovers the rollover request outside the kept tail but never resurrects it after a reset boundary", async () => {
		using dir = TempDir.createSync("@resume-rollover-reset-");
		const entries: SessionEntry[] = [
			user("request", null, "original request 🐈"),
			{
				type: "custom",
				id: "notes",
				parentId: "request",
				timestamp,
				customType: "experimental_context_notes",
				data: { version: 1, text: "Keep rollback plan 🐈" },
			},
			tool("discarded", "notes", "discarded tool output"),
			tool("keep", "discarded", "retained tool output"),
			{ ...compact("rollover", "keep", "keep"), details: { kind: "experimental-context-rollover" } },
			assistant("after-rollover", "rollover", "continuation"),
			{ ...compact("rollover2", "after-rollover", "keep"), details: { kind: "experimental-context-rollover" } },
			assistant("after-rollover2", "rollover2", "second continuation"),
			{ type: "reset_boundary", id: "reset", parentId: "after-rollover2", timestamp },
			user("fresh", "reset", "post-reset request"),
			compact("newer-compaction", "fresh", "fresh"),
			user("newer-tail", "newer-compaction", "after newer compaction"),
		];
		const file = await writeJournal(dir.path(), entries);
		const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			session.branch("fresh");
			expect(session.buildSessionContext()).toEqual(buildSessionContext(entries, "fresh"));
			expect(session.buildSessionContext().messages).toEqual([
				{ role: "user", content: "post-reset request", timestamp: 1 },
			]);
			for (const leaf of ["after-rollover", "after-rollover2"]) {
				session.branch(leaf);
				const rolled = session.buildSessionContext();
				expect(rolled).toEqual(buildSessionContext(entries, leaf));
				expect(rolled.messages.find(message => message.role === "user")).toMatchObject({
					content: "original request 🐈",
				});
				expect(rolled.messages.find(message => message.role === "custom")).toBeDefined();
				expect(rolled.messages.find(message => message.role === "toolResult")).toMatchObject({
					content: [{ type: "text", text: "retained tool output" }],
				});
			}
			session.branch("newer-tail");
			expect(session.buildSessionContext()).toEqual(buildSessionContext(entries, "newer-tail"));
			expect(session.buildSessionContext().messages.map(message => message.role)).toEqual([
				"compactionSummary",
				"user",
				"user",
			]);
			session.branch("fresh");
			expect(session.buildSessionContext({ transcript: true })).toEqual(
				buildSessionContext(entries, "fresh", undefined, { transcript: true }),
			);
		} finally {
			await session.close();
		}
	});

	for (const boundary of ["missing", "sibling", "tail", "anthropic-snapshot", "openai-snapshot", "openai-kept"]) {
		it(`preserves model and collapsed transcript semantics for ${boundary} compaction boundaries`, async () => {
			using dir = TempDir.createSync("@resume-provider-boundary-");
			const reply = assistant("reply", "root", "retained response");
			if (reply.message.role !== "assistant") throw new Error("Expected assistant fixture");
			reply.message.content = [
				{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "sig" },
				{ type: "toolCall", id: "call-result", name: "read", arguments: {} },
				{ type: "toolCall", id: "dangling", name: "read", arguments: {} },
			];
			const native = boundary === "anthropic-snapshot";
			const remote = boundary.startsWith("openai-");
			const snapshot = boundary.endsWith("snapshot");
			const compaction: CompactionEntry = {
				...compact("compact", "result", snapshot ? "" : remote ? "reply" : boundary),
				...(snapshot ? { providerReplayThroughEntryId: "root" } : {}),
				preserveData: native
					? {
							anthropicCompaction: { provider: "anthropic", content: "native summary", signature: "native-sig" },
						}
					: remote
						? {
								openaiRemoteCompaction: {
									provider: "openai",
									replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
								},
							}
						: undefined,
			};
			const entries: SessionEntry[] = [
				user("root", null, "summarized request 🐈"),
				reply,
				tool("result", "reply", "paired result"),
				user("sibling", "root", "off-path kept ID"),
				compaction,
				user("tail", "compact", "post-compaction"),
			];
			const file = await writeJournal(dir.path(), entries);
			const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
			try {
				const model = session.buildSessionContext();
				const collapsed = session.buildSessionContext({ transcript: true, collapseCompactedHistory: true });
				expect(model).toEqual(buildSessionContext(entries, "tail"));
				expect(collapsed).toEqual(
					buildSessionContext(entries, "tail", undefined, { transcript: true, collapseCompactedHistory: true }),
				);
				const modelHasRawTail = snapshot;
				const transcriptHasRawTail = native || boundary === "openai-kept";
				expect(model.messages.map(message => message.role)).toEqual(
					modelHasRawTail
						? ["compactionSummary", "assistant", "toolResult", "user"]
						: ["compactionSummary", "user"],
				);
				expect(collapsed.messages.map(message => message.role)).toEqual(
					transcriptHasRawTail
						? ["assistant", "toolResult", "compactionSummary", "user"]
						: ["compactionSummary", "user"],
				);
				if (boundary === "openai-snapshot") {
					expect(session.getContextBranch().map(entry => entry.id)).toEqual([
						"root",
						"reply",
						"result",
						"compact",
						"tail",
					]);
				}
				if (native) {
					const summary = model.messages[0];
					if (summary.role !== "compactionSummary") throw new Error("Expected summary");
					expect(summary.historyRewriteAt).toBeLessThan(new Date(reply.timestamp).getTime());
				}
				session.branch("reply");
				expect(session.buildSessionContext()).toEqual(buildSessionContext(entries, "reply"));
				expect(session.buildSessionContext({ transcript: true })).toEqual(
					buildSessionContext(entries, "reply", undefined, { transcript: true }),
				);
			} finally {
				await session.close();
			}
		});
	}

	for (const tail of ["valid-no-newline", "malformed-final"]) {
		it(`preserves old and sibling records through UTF-8 title slots, malformed middle, ${tail}, append and rewrite`, async () => {
			using dir = TempDir.createSync("@resume-jsonl-boundaries-");
			// Baseline persistence truncates strings above 500,000 chars; this
			// rewrite/offset oracle stays below that independent canonical policy.
			const entries = threeCompactions(128 * 1024);
			const file = path.join(dir.path(), "session.jsonl");
			const lines = [
				JSON.stringify({ type: "session", version: 3, id: "resume-memory", timestamp, cwd: dir.path() }),
				...entries.map(entry => JSON.stringify(entry)),
			];
			lines.splice(4, 0, "{ malformed middle 🐈");
			const slot = serializeTitleSlot({ title: "история 🐈", source: "user", updatedAt: timestamp });
			await Bun.write(file, slot + lines.join("\n") + (tail === "malformed-final" ? "\n{ incomplete tail" : ""));
			const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
			let appended: string;
			let newRoot: string;
			try {
				expect(session.getSessionName()).toBe("история 🐈");
				expect(session.getEntries()).toEqual(entries);
				session.branch("sibling-tail");
				appended = session.appendMessage({ role: "user", content: "new sibling continuation", timestamp: 200 });
				expect(session.getEntry(appended)?.parentId).toBe("sibling-tail");
				session.resetLeaf();
				expect(session.buildSessionContext()).toEqual(buildSessionContext(entries, null));
				newRoot = session.appendMessage({ role: "user", content: "new root", timestamp: 201 });
				expect(session.getEntry(newRoot)?.parentId).toBeNull();
				await session.rewriteEntries();
			} finally {
				await session.close();
			}
			const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
			try {
				for (const entry of entries) expect(reopened.getEntry(entry.id)).toEqual(entry);
				expect(reopened.getEntries()).toHaveLength(entries.length + 2);
				expect(reopened.getEntry(appended!)?.parentId).toBe("sibling-tail");
				expect(reopened.getLeafId()).toBe(newRoot!);
				expect(reopened.buildSessionContext().messages).toEqual([
					{ role: "user", content: "new root", timestamp: 201 },
				]);
			} finally {
				await reopened.close();
			}
		});
	}

	it("exports a cloneable compacted session snapshot with exact historical and sibling payloads and tree identities after demand reads", async () => {
		using dir = TempDir.createSync("@resume-export-clone-");
		const entries = threeCompactions();
		const file = await writeJournal(dir.path(), entries);
		const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			// Keep demand-returned plain historical objects live across direct
			// public-data clones and the export snapshot.
			const historical = session.getEntry("old-large");
			const sibling = session.getEntry("sibling-compaction");
			expect(structuredClone(historical)).toEqual(historical);
			expect(structuredClone(session.getEntries())).toEqual(entries);
			expect(structuredClone(session.getBranch())).toEqual(session.getBranch());
			expect(structuredClone(session.getBranchView())).toEqual(session.getBranch());
			expect(structuredClone(session.getTree())).toEqual(session.getTree());
			expect(structuredClone(session.buildSessionContext())).toEqual(session.buildSessionContext());
			const cloned = structuredClone(buildSessionData(session));
			expect(cloned.header).toEqual({
				type: "session",
				version: 3,
				id: "resume-memory",
				timestamp,
				cwd: dir.path(),
			});
			expect(cloned.leafId).toBe("tail");
			expect(cloned.entries).toEqual(entries);
			expect(cloned.entries.find(entry => entry.id === "old-large")).toEqual(
				entries.find(entry => entry.id === "old-large"),
			);
			expect(cloned.entries.find(entry => entry.id === "sibling-compaction")).toEqual(
				entries.find(entry => entry.id === "sibling-compaction"),
			);
			expect(cloned.entries.map(entry => [entry.id, entry.parentId])).toEqual(
				entries.map(entry => [entry.id, entry.parentId]),
			);
			expect(buildSessionContext(cloned.entries, cloned.leafId)).toEqual(buildSessionContext(entries, "tail"));
			// Neither public reads nor export copies mutate caller-owned records.
			expect(historical?.id).toBe("old-large");
			expect(sibling?.id).toBe("sibling-compaction");
		} finally {
			await session.close();
		}
	});

	it("read-only collapsed history matches the pure three-compaction transcript without taking the live writer lock", async () => {
		using dir = TempDir.createSync("@resume-readonly-parity-");
		const entries = threeCompactions();
		const file = await writeJournal(dir.path(), entries);
		const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			expect(await loadSessionMessagesReadOnly(file)).toEqual(
				buildSessionContext(entries, "tail", undefined, { transcript: true, collapseCompactedHistory: true })
					.messages,
			);
		} finally {
			await session.close();
		}
	});

	it("persists a registered historical update after the caller frame returns, awaits and garbage collection", async () => {
		using dir = TempDir.createSync("@resume-weak-mutation-");
		const entries = threeCompactions();
		const rootIndex = entries.findIndex(entry => entry.id === "root");
		entries[rootIndex].parentId = "old-assistant";
		entries.splice(
			rootIndex,
			0,
			{
				type: "credential_pin",
				id: "openai-pin",
				parentId: "pin",
				timestamp,
				provider: "openai",
				hash: "openai-account",
			},
			assistant("old-assistant", "openai-pin", "historical assistant"),
		);
		const file = await writeJournal(dir.path(), entries);
		const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		function mutateHistorical(): void {
			const old = session.getEntry("old-large");
			if (old?.type !== "message" || old.message.role !== "toolResult")
				throw new Error("Expected historical result");
			const block = old.message.content[0];
			if (block.type !== "text") throw new Error("Expected historical text");
			block.text = "edited historical payload 🐈";
			session.updateEntry(old);
			const historicalAssistant = session.getEntry("old-assistant");
			if (historicalAssistant?.type !== "message" || historicalAssistant.message.role !== "assistant")
				throw new Error("Expected old assistant");
			historicalAssistant.message.provider = "openai";
			historicalAssistant.message.timestamp = new Date(timestamp).getTime() + 9000;
			session.updateEntry(historicalAssistant);
		}
		try {
			mutateHistorical();
			expect(Object.fromEntries(session.getCredentialPins())).toEqual({
				anthropic: { hash: "old-account", lastUsedAt: new Date(timestamp).getTime() + 1000 },
				openai: { hash: "openai-account", lastUsedAt: new Date(timestamp).getTime() + 9000 },
			});
			session.branch("old-assistant");
			expect(session.buildSessionContext().messages.find(message => message.role === "assistant")).toMatchObject({
				provider: "openai",
				timestamp: new Date(timestamp).getTime() + 9000,
			});
			session.branch("tail");
			await setImmediate();
			Bun.gc(true);
			await setImmediate();
			Bun.gc(true);
			await session.rewriteEntries();
		} finally {
			await session.close();
		}
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			const edited = reopened.getEntry("old-large");
			if (edited?.type !== "message" || edited.message.role !== "toolResult")
				throw new Error("Expected edited historical result");
			expect(edited.message.content.length).toBe(1);
			expect(edited.message.content[0].type).toBe("text");
			if (edited.message.content[0].type !== "text") throw new Error("Expected edited text block");
			expect(edited.message.content[0].text).toBe("edited historical payload 🐈");
			const sibling = reopened.getEntry("sibling-compaction");
			if (sibling?.type !== "compaction") throw new Error("Expected sibling compaction");
			expect(sibling.summary).toBe("summary-sibling-compaction");
			const historicalAssistant = reopened.getEntry("old-assistant");
			if (historicalAssistant?.type !== "message" || historicalAssistant.message.role !== "assistant")
				throw new Error("Expected old assistant");
			expect(historicalAssistant.message.provider).toBe("openai");
			expect(historicalAssistant.message.timestamp).toBe(new Date(timestamp).getTime() + 9000);
			expect(reopened.getCredentialPins().get("openai")).toEqual({
				hash: "openai-account",
				lastUsedAt: new Date(timestamp).getTime() + 9000,
			});
		} finally {
			await reopened.close();
		}
	});

	for (const reference of ["self", "forward"]) {
		it(`preserves eager migration semantics for v1 ${reference} compaction references on resume and demand`, async () => {
			using dir = TempDir.createSync("@resume-v1-reference-");
			const raw = [
				{ type: "session", id: "v1", timestamp, cwd: dir.path() },
				{ type: "message", timestamp, message: { role: "user", content: "legacy request 🐈", timestamp: 1 } },
				{
					type: "compaction",
					timestamp,
					summary: "legacy summary",
					firstKeptEntryIndex: reference === "self" ? 2 : 3,
					firstKeptEntryId: "unmapped-forward",
					tokensBefore: 1000,
				},
				{ type: "message", timestamp, message: { role: "user", content: "legacy continuation", timestamp: 2 } },
			];
			const oracle = structuredClone(raw) as FileEntry[];
			migrateSessionEntries(oracle);
			const oracleEntries = oracle.slice(1) as SessionEntry[];
			const file = path.join(dir.path(), "session.jsonl");
			await Bun.write(file, raw.map(entry => JSON.stringify(entry)).join("\n"));
			const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
			try {
				expect(session.buildSessionContext()).toEqual(buildSessionContext(oracleEntries));
				const entries = session.getEntries();
				const compaction = entries.find(entry => entry.type === "compaction");
				if (compaction?.type !== "compaction") throw new Error("Expected migrated compaction");
				expect(compaction.firstKeptEntryId).toBe(reference === "self" ? compaction.id : "unmapped-forward");
				await setImmediate();
				Bun.gc(true);
				expect(session.getEntry(compaction.id)).toEqual(compaction);
				expect(session.getBranch()).toEqual(entries);
			} finally {
				await session.close();
			}
		});
	}

	it("binds initial scan positions and historical demand to the same inode when the source path is atomically replaced during scanning", async () => {
		using dir = TempDir.createSync("@resume-init-inode-race-");
		const original = threeCompactions();
		const file = await writeJournal(dir.path(), original);
		const replacement = structuredClone(original);
		const old = replacement.find(entry => entry.id === "old-large");
		if (old?.type !== "message" || old.message.role !== "toolResult") throw new Error("Expected replacement result");
		old.message.content = [{ type: "text", text: "different inode, shorter payload" }];
		const replacementFile = path.join(dir.path(), "replacement.jsonl");
		await Bun.write(
			replacementFile,
			[{ type: "session", version: 3, id: "replacement-session", timestamp, cwd: dir.path() }, ...replacement]
				.map(entry => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		const positions: PositionedSessionEntry[] = [];
		let replaced = false;
		const loaded = await sessionLoader.visitSessionFileForResume(file, (_entry, position) => {
			positions.push(position);
			if (!replaced) {
				replaced = true;
				fs.renameSync(replacementFile, file);
			}
		});
		if (loaded.sourceFd === undefined) throw new Error("Initial scan did not return its owned source descriptor");
		try {
			const demanded = positions.map(position =>
				sessionLoader.readPositionedSessionEntry(loaded.sourceFd!, position),
			);
			expect(demanded).toEqual(original);
			expect(buildSessionContext(demanded, "tail")).toEqual(buildSessionContext(original, "tail"));
			expect(
				buildSessionContext(demanded, "tail", undefined, { transcript: true, collapseCompactedHistory: true }),
			).toEqual(
				buildSessionContext(original, "tail", undefined, { transcript: true, collapseCompactedHistory: true }),
			);
		} finally {
			fs.closeSync(loaded.sourceFd);
		}
	});

	it("demand-reads historical UTF-8 entries from the original inode while an atomic rewrite has published", async () => {
		using dir = TempDir.createSync("@resume-inode-rewrite-");
		const entries = threeCompactions();
		const file = await writeJournal(dir.path(), entries);
		const storage = new PublishedRewriteStorage();
		const session = await SessionManager.open(file, dir.path(), storage, { suppressBreadcrumb: true });
		let rewrite: Promise<void> | undefined;
		try {
			// Removing the large physical record moves every subsequent byte offset.
			const old = session.getEntry("old-large");
			if (old?.type !== "message" || old.message.role !== "toolResult")
				throw new Error("Expected historical result");
			old.message.content = [{ type: "text", text: "short replacement" }];
			session.updateEntry(old);
			storage.armed = true;
			rewrite = session.rewriteEntries();
			await storage.published.promise;
			expect(session.getEntry("c1")).toEqual(entries.find(entry => entry.id === "c1"));
			expect(session.getEntry("sibling-compaction")).toEqual(
				entries.find(entry => entry.id === "sibling-compaction"),
			);
			function editSharedContextPayload(): void {
				const message = session.buildSessionContext().messages.find(candidate => candidate.role === "assistant");
				if (message?.role !== "assistant" || message.content[0].type !== "text")
					throw new Error("Expected shared context assistant");
				const entry = session
					.getContextBranch()
					.find(candidate => candidate.type === "message" && candidate.message === message);
				if (entry?.type !== "message" || entry.message.role !== "assistant")
					throw new Error("Expected context owner");
				// The setter is authoritative by id, even while the serialized object stays live.
				session.updateEntry({
					...entry,
					message: {
						...entry.message,
						content: [{ type: "text", text: "raw context edit during published rewrite 🐈" }],
					},
				});
			}
			editSharedContextPayload();
			storage.release.resolve();
			await rewrite;
			Bun.gc(true);
			expect(session.getEntry("c1")).toEqual(entries.find(entry => entry.id === "c1"));
			const shortened = session.getEntry("old-large");
			if (shortened?.type !== "message" || shortened.message.role !== "toolResult")
				throw new Error("Expected shortened result");
			expect(shortened.message.content.length).toBe(1);
			expect(shortened.message.content[0].type).toBe("text");
			if (shortened.message.content[0].type !== "text") throw new Error("Expected shortened text");
			expect(shortened.message.content[0].text).toBe("short replacement");
			await setImmediate();
			Bun.gc(true);
			await session.rewriteEntries();
		} finally {
			storage.release.resolve();
			await rewrite;
			await session.close();
		}
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			const reply = reopened.getEntry("reply");
			if (reply?.type !== "message" || reply.message.role !== "assistant") throw new Error("Expected edited reply");
			expect(reply.message.content.length).toBe(1);
			expect(reply.message.content[0].type).toBe("text");
			if (reply.message.content[0].type !== "text") throw new Error("Expected edited reply text");
			expect(reply.message.content[0].text).toBe("raw context edit during published rewrite 🐈");
			const contextReply = reopened.buildSessionContext().messages.find(message => message.role === "assistant");
			if (contextReply?.role !== "assistant") throw new Error("Expected edited context reply");
			expect(contextReply.content.length).toBe(1);
			expect(contextReply.content[0].type).toBe("text");
			if (contextReply.content[0].type !== "text") throw new Error("Expected edited context text");
			expect(contextReply.content[0].text).toBe("raw context edit during published rewrite 🐈");
		} finally {
			await reopened.close();
		}
	});

	it("persists an explicit historical update through publication and GC", async () => {
		using dir = TempDir.createSync("@resume-nested-context-rewrite-");
		const file = await writeJournal(dir.path(), threeCompactions());
		const storage = new PublishedRewriteStorage();
		const session = await SessionManager.open(file, dir.path(), storage, { suppressBreadcrumb: true });
		let rewrite: Promise<void> | undefined;
		try {
			expect(session.getContextBranch().some(entry => entry.id === "old-large")).toBe(false);
			function historicalTextBlock(): TextContent {
				const message = session
					.buildSessionContext({ transcript: true })
					.messages.find(
						candidate => candidate.role === "toolResult" && candidate.toolCallId === "call-old-large",
					);
				if (message?.role !== "toolResult" || message.content[0].type !== "text")
					throw new Error("Expected historical context text block");
				return message.content[0];
			}
			// No context, message, or entry reference escapes the helper.
			const block = historicalTextBlock();
			expect(structuredClone(block)).toEqual(block);
			storage.armed = true;
			rewrite = session.rewriteEntries();
			await storage.published.promise;
			block.text = "nested historical edit during published rewrite 🐈";
			const owner = session.getEntry("old-large");
			if (owner?.type !== "message" || owner.message.role !== "toolResult")
				throw new Error("Expected historical context owner");
			owner.message.content = [block];
			session.updateEntry(owner);
			await setImmediate();
			Bun.gc(true);
			await setImmediate();
			Bun.gc(true);
			storage.release.resolve();
			await rewrite;
			expect(block.text).toBe("nested historical edit during published rewrite 🐈");
		} finally {
			storage.release.resolve();
			await rewrite;
			await session.close();
		}
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			const historical = reopened.getEntry("old-large");
			if (historical?.type !== "message" || historical.message.role !== "toolResult")
				throw new Error("Expected rewritten historical result");
			expect(historical.message.content).toEqual([
				{ type: "text", text: "nested historical edit during published rewrite 🐈" },
			]);
		} finally {
			await reopened.close();
		}
	});

	it("keeps published inode offsets and new revisions recoverable after a live image comparison fails", async () => {
		using dir = TempDir.createSync("@resume-compare-blob-failure-");
		const entries = threeCompactions();
		const kept = entries.find(entry => entry.id === "kept");
		if (kept?.type !== "message" || kept.message.role !== "user") throw new Error("Expected kept user");
		kept.message.content = [{ type: "image", data: "aW5pdGlhbA==", mimeType: "image/png" }];
		const file = await writeJournal(dir.path(), entries);
		const storage = new PublishedRewriteStorage();
		const session = await SessionManager.open(file, dir.path(), storage, { suppressBreadcrumb: true });
		const changedImage = Buffer.alloc(2048, 7).toString("base64");
		const failure = Object.assign(new Error("Post-publication blob write failed"), { code: "ENOSPC" });
		const put = spyOn(BlobStore.prototype, "putSync");
		let rewrite: Promise<void> | undefined;
		try {
			const imageEntry = session.getEntry("kept");
			if (
				imageEntry?.type !== "message" ||
				imageEntry.message.role !== "user" ||
				!Array.isArray(imageEntry.message.content) ||
				imageEntry.message.content[0].type !== "image"
			)
				throw new Error("Expected live image block");
			const image = imageEntry.message.content[0];
			const early = session.getEntry("old-large");
			if (early?.type !== "message" || early.message.role !== "toolResult")
				throw new Error("Expected early historical result");
			early.message.content = [{ type: "text", text: "short replacement" }];
			session.updateEntry(early);
			storage.armed = true;
			rewrite = session.rewriteEntries();
			await storage.published.promise;
			// The serialized image is still tiny; only the live comparison needs a blob.
			image.data = changedImage;
			put.mockImplementationOnce(() => {
				throw failure;
			});
			function announceLaterRevision(): void {
				const later = session.getEntry("sibling");
				if (later?.type !== "message" || later.message.role !== "user")
					throw new Error("Expected later historical sibling");
				later.message.content = "announced while publication was pending";
				session.updateEntry(later);
			}
			announceLaterRevision();
			await setImmediate();
			Bun.gc(true);
			storage.release.resolve();
			await expect(rewrite).rejects.toBe(failure);
			expect(put).toHaveBeenCalledTimes(1);
			put.mockRestore();
			// This historical record was never loaded or retained by the caller.
			expect(session.getEntry("sibling-compaction")).toEqual(
				entries.find(entry => entry.id === "sibling-compaction"),
			);
			expect(session.getEntry("sibling")).toMatchObject({
				message: { content: "announced while publication was pending" },
			});
			await session.recoverPersistenceFromCurrentState();
		} finally {
			put.mockRestore();
			storage.release.resolve();
			await rewrite?.catch(() => undefined);
			await session.close();
		}
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			expect(reopened.getEntry("kept")).toMatchObject({
				message: { content: [{ type: "image", data: changedImage, mimeType: "image/png" }] },
			});
			expect(reopened.getEntry("old-large")).toMatchObject({
				message: { content: [{ type: "text", text: "short replacement" }] },
			});
			expect(reopened.getEntry("sibling")).toMatchObject({
				message: { content: "announced while publication was pending" },
			});
			expect(reopened.getEntry("sibling-compaction")).toEqual(
				entries.find(entry => entry.id === "sibling-compaction"),
			);
		} finally {
			await reopened.close();
		}
	});

	for (const position of ["before", "after"]) {
		it(`recovers a dangling tool call ${position} compaction once even when selected-model fallback scans again`, async () => {
			using dir = TempDir.createSync("@resume-interrupted-compaction-");
			const pending = assistant("pending", position === "before" ? "root" : "compact", "unfinished");
			if (pending.message.role !== "assistant") throw new Error("Expected interrupted assistant");
			pending.message.content = [
				{ type: "toolCall", id: "interrupted-read", name: "read", arguments: { path: "unfinished.txt" } },
			];
			pending.message.stopReason = "toolUse";
			const compaction = compact("compact", position === "before" ? "pending" : "root", "");
			const entries: SessionEntry[] = [
				user("root", null, "inspect unfinished file"),
				...(position === "before" ? [pending, compaction] : [compaction, pending]),
				{
					type: "custom",
					id: "exit",
					parentId: position === "before" ? "compact" : "pending",
					timestamp,
					customType: SESSION_EXIT_CUSTOM_TYPE,
					data: { reason: "exit", kind: "process_exit", recordedAt: timestamp },
				},
			];
			const file = await writeJournal(dir.path(), entries);
			const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
			try {
				expect(describePendingToolCalls(session.iterateBranch())).toContain("unfinished.txt");
				const aborted = createInterruptedTurnAbortMessage(session.iterateBranch());
				if (!aborted) throw new Error("Missing interrupted-turn terminal record");
				const results = createInterruptedToolResults(session.iterateBranch());
				expect(results).toHaveLength(1);
				expect(results[0]).toMatchObject({
					role: "toolResult",
					toolCallId: "interrupted-read",
					toolName: "read",
					isError: true,
				});
				for (const result of results) session.appendMessage(result);
				const abortId = session.appendMessage(aborted);
				const terminal = session.getEntry(abortId);
				if (terminal?.type !== "message" || terminal.message.role !== "assistant")
					throw new Error("Expected terminal assistant");
				expect(terminal.message.content.length).toBe(0);
				expect(terminal.message.stopReason).toBe("aborted");
				expect(session.getEntries()).toHaveLength(entries.length + 2);
				const repeated = createInterruptedTurnAbortMessage(session.iterateBranch(), {
					api: "anthropic-messages",
					provider: "anthropic",
					model: "selected-fallback-model",
				});
				expect(repeated).toBeUndefined();
				expect(createInterruptedToolResults(session.iterateBranch())).toEqual([]);
				expect(describePendingToolCalls(session.iterateBranch())).toBeUndefined();
				expect(session.getEntries()).toHaveLength(entries.length + 2);
			} finally {
				await session.close();
			}
		});
	}

	it("retains less than 32 MiB after resuming 128 MiB of compacted tool results and after demand-reading them all", async () => {
		const result = await runHeapProbe("compacted");
		const evidence = JSON.stringify(result);
		expect(result.fixtureBytes, evidence).toBeGreaterThan(128 * MiB);
		expect(result.payloadBytes).toBe(128 * MiB);
		expect(result.resultCount).toBe(64);
		expect(result.contextResultCount).toBe(0);
		expect(result.exactDemandCount).toBe(64);
		// An index plus a tiny context has ample headroom; retaining even one
		// quarter of the old 128 MiB payload violates this bound.
		expect(result.retainedAfterOpenBytes, evidence).toBeLessThan(32 * MiB);
		expect(result.retainedAfterDemandBytes, evidence).toBeLessThan(32 * MiB);
	}, 60_000);

	it("retains less than 32 MiB after an agent session resumes 128 MiB of compacted tool results", async () => {
		const result = await runHeapProbe("agent");
		const evidence = JSON.stringify(result);
		expect(result.contextResultCount).toBe(0);
		expect(result.exactDemandCount).toBe(64);
		// Building the session's tools looks up the prompt the restored reply was
		// sent with; neither that lookup nor any other must hold the old results.
		expect(result.retainedAfterOpenBytes, evidence).toBeLessThan(32 * MiB);
		expect(result.retainedAfterDemandBytes, evidence).toBeLessThan(32 * MiB);
	}, 60_000);

	it("keeps all 128 MiB of uncompacted tool results in model context as the heap measurement negative control", async () => {
		const result = await runHeapProbe("uncompacted");
		expect(result.contextResultCount).toBe(64);
		// The same fixture without compaction must remain live. This also
		// detects a heap metric that cannot see the large string payloads.
		expect(result.retainedAfterOpenBytes, JSON.stringify(result)).toBeGreaterThan(64 * MiB);
	}, 60_000);
});

describe("todo state from a metadata-filtered branch", () => {
	const phasesA = [{ name: "Phase A", tasks: [{ content: "Task A", status: "pending" as const }] }];
	const phasesB = [{ name: "Phase B", tasks: [{ content: "Task B", status: "in_progress" as const }] }];
	const phasesSibling = [{ name: "Sibling", tasks: [{ content: "Elsewhere", status: "pending" as const }] }];

	function todoResult(
		id: string,
		parentId: string,
		phases: unknown,
		extra: Record<string, unknown> = {},
	): SessionEntry {
		return {
			type: "message",
			id,
			parentId,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: `call-${id}`,
				toolName: "todo",
				content: [{ type: "text", text: "ok" }],
				details: { op: "set", phases },
				isError: false,
				timestamp: 3,
				...extra,
			},
		} as SessionEntry;
	}

	it("selects only todo snapshots and HUD choices, replaying identically to the full branch", async () => {
		using dir = TempDir.createSync("@resume-todo-branch-");
		const entries: SessionEntry[] = [
			user("root", null, "plan it"),
			todoResult("t1", "root", phasesA),
			tool("big", "t1", "y".repeat(MiB)),
			todoResult("t-error", "big", phasesSibling, { isError: true }),
			{
				type: "custom",
				id: "hud",
				parentId: "t-error",
				timestamp,
				customType: TODO_HUD_STATE_CUSTOM_TYPE,
				data: { sourceEntryId: "t2", fingerprint: JSON.stringify(phasesB), visibility: "dismissed" },
			},
			{
				type: "custom",
				id: "t2",
				parentId: "hud",
				timestamp,
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: phasesB },
			},
			{ type: "custom", id: "other", parentId: "t2", timestamp, customType: "unrelated", data: {} },
			todoResult("t-sibling", "t1", phasesSibling),
			user("tail", "other", "continue"),
		];
		const file = await writeJournal(dir.path(), entries);
		const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			const filtered = session.getBranchMatching(isTodoStateEntryMetadata);
			expect(filtered.map(entry => entry.id)).toEqual(["t1", "t-error", "hud", "t2"]);
			const full = session.getBranch();
			expect(getLatestTodoPhasesFromEntries(filtered)).toEqual(getLatestTodoPhasesFromEntries(full));
			expect(getLatestTodoPhasesFromEntries(filtered)).toEqual(phasesB);
			expect(getTodoHudVisibility(filtered, phasesB)).toBe("dismissed");
			expect(createTodoHudStateData(filtered, phasesB, "revealed")).toEqual(
				createTodoHudStateData(full, phasesB, "revealed"),
			);

			// Entries appended live carry the same metadata as entries scanned from disk.
			session.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: phasesA });
			const appended = session.getBranchMatching(isTodoStateEntryMetadata);
			expect(appended).toHaveLength(5);
			expect(getLatestTodoPhasesFromEntries(appended)).toEqual(phasesA);

			session.branch("t-sibling");
			expect(session.getBranchMatching(isTodoStateEntryMetadata).map(entry => entry.id)).toEqual([
				"t1",
				"t-sibling",
			]);
		} finally {
			await session.close();
		}
	});
});

describe("lookups by metadata after resume", () => {
	it("find the newest compaction and the model mentions without reading older compactions or other custom entries", async () => {
		using dir = TempDir.createSync("@resume-metadata-lookups-");
		const mention = { agent: "m1", selector: "b/y", name: "Y" };
		const entries: SessionEntry[] = [
			user("root", null, "first request"),
			compact("c1", "root", "root"),
			{ type: "custom", id: "unrelated", parentId: "c1", timestamp, customType: "unrelated", data: {} },
			{
				type: "custom",
				id: "mention",
				parentId: "unrelated",
				timestamp,
				customType: MODEL_MENTION_ENTRY_TYPE,
				data: mention,
			},
			user("middle", "mention", "second request"),
			compact("c2", "middle", "middle"),
			user("tail", "c2", "continue"),
		];
		const file = await writeJournal(dir.path(), entries);
		const session = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		const auth = await AuthStorage.create(":memory:");
		try {
			// Blank the records neither lookup needs in the journal, so reading one back fails.
			const fd = fs.openSync(file, "r+");
			try {
				let offset = Buffer.byteLength(
					`${JSON.stringify({ type: "session", version: 3, id: "resume-memory", timestamp, cwd: dir.path() })}\n`,
				);
				for (const entry of entries) {
					const length = Buffer.byteLength(JSON.stringify(entry));
					if (entry.id === "c1" || entry.id === "unrelated")
						fs.writeSync(fd, Buffer.alloc(length, " "), 0, length, offset);
					offset += length + 1;
				}
			} finally {
				fs.closeSync(fd);
			}
			Bun.gc(true);

			expect(session.getLatestCompactionEntry()?.id).toBe("c2");
			const mentions = new ModelMentionRegistry({
				sessionManager: session,
				modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
				scopedModels: () => [],
			});
			mentions.syncFromBranch();
			expect(mentions.mentions).toEqual([mention]);
		} finally {
			auth.close();
			await session.close();
		}
	});
});
