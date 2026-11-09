import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CONTEXT_NOTES_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import {
	type BuildSessionContextOptions,
	buildSessionContext,
	buildSessionContextFromLeafPath,
	getReadableCompactionEntry,
	type SessionContext,
	selectSessionContextEntriesFromLeafPath,
	sessionContextEntryMetadata,
} from "@oh-my-pi/pi-coding-agent/session/session-context";
import type {
	ModelUsageEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const ISO = "2026-10-26T00:00:00.000Z";
const COLLAPSED: BuildSessionContextOptions = { transcript: true, collapseCompactedHistory: true };

function bundled(provider: "openai" | "anthropic", modelId: string): Model {
	const model = getBundledModel(provider, modelId);
	if (!model) throw new Error(`Expected bundled ${provider}/${modelId}`);
	return model;
}

const gpt = bundled("openai", "gpt-5.4");
const claude = bundled("anthropic", "claude-opus-5-5");

let clock = 0;

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: ++clock };
}

function reply(): AssistantMessage {
	return { ...makeAssistantMessage(), timestamp: ++clock };
}

function toolResult(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: `call-${clock}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ++clock,
	};
}

function message(id: string, parentId: string, text: string): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: ISO, message: user(text) };
}

function usage(id: string, parentId: string, activeLeafId: string): ModelUsageEntry {
	return {
		type: "model_usage",
		id,
		parentId,
		activeLeafId,
		timestamp: ISO,
		purpose: "title",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: makeAssistantMessage().usage,
		stopReason: "stop",
	};
}

/**
 * The index keeps the provider and collapsed-display selections and extends
 * them in place on an append; selecting from every entry at once is the
 * reference they must match. The context branch is their ordered union for the
 * leaf itself, while the context of an unavailable leaf is the replayed leaf's,
 * as the canonical builder's is.
 */
async function expectFreshSelection(session: SessionManager, step: string): Promise<void> {
	await session.flush();
	const entries = session.getEntries();
	const leaf = session.getLeafId();
	const leafFirst = session.getBranch().reverse().map(sessionContextEntryMetadata);
	const selectedIds = new Set(
		[undefined, COLLAPSED].flatMap(options =>
			selectSessionContextEntriesFromLeafPath(leafFirst, id => session.getEntry(id)!, options).map(
				entry => entry.id,
			),
		),
	);
	expect({ step, branch: session.getContextBranch() }).toEqual({
		step,
		branch: leafFirst
			.toReversed()
			.filter(metadata => selectedIds.has(metadata.id))
			.map(metadata => session.getEntry(metadata.id)!),
	});
	for (const options of [undefined, COLLAPSED]) {
		expect({ step, context: session.buildSessionContext(options) }).toEqual({
			step,
			context: buildSessionContext(entries, leaf, undefined, options),
		});
	}
}

async function appendEveryKind(session: SessionManager): Promise<void> {
	const first = session.appendMessage(user("first"));
	await expectFreshSelection(session, "user message");
	session.appendMessage(reply());
	await expectFreshSelection(session, "reply the model is inferred from");
	session.appendMessage(user("second"));
	session.appendMessage(reply());
	await expectFreshSelection(session, "newer reply the model is inferred from");
	session.appendModelChange("anthropic/claude-sonnet-4-20250514", "smol");
	await expectFreshSelection(session, "role model change");
	session.appendModelChange("anthropic/claude-sonnet-4-20250514");
	await expectFreshSelection(session, "explicit default model change");
	session.appendMessage(reply());
	await expectFreshSelection(session, "reply after an explicit default");
	session.appendThinkingLevelChange("high");
	await expectFreshSelection(session, "thinking level change");
	session.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, { version: 1, text: "notes" });
	await expectFreshSelection(session, "notebook");
	const kept = session.appendMessage(user("kept"));
	session.appendMessage(reply());
	session.appendCompaction("summary", undefined, kept, 1000);
	await expectFreshSelection(session, "compaction");
	session.appendMessage(user("after compaction"));
	await expectFreshSelection(session, "message after compaction");
	session.appendModelUsage(
		{
			purpose: "title",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: makeAssistantMessage().usage,
			stopReason: "stop",
		},
		{ sessionId: session.getSessionId(), parentId: first },
	);
	await expectFreshSelection(session, "late usage");
	session.appendResetBoundary();
	await expectFreshSelection(session, "reset boundary");
	session.appendMessage(user("after reset"));
	await expectFreshSelection(session, "message after reset");
	session.branch(kept);
	const branched = session.appendMessage(user("another branch"));
	await expectFreshSelection(session, "append on another branch");

	// A replica can receive an entry before its parent, and usage naming a
	// leaf it has not received yet.
	session.ingestReplicatedEntry(message("orphan", "late-parent", "orphan"));
	await expectFreshSelection(session, "entry whose parent is missing");
	session.ingestReplicatedEntry(usage("late-parent", branched, "orphan"));
	await expectFreshSelection(session, "missing parent arriving");
	session.ingestReplicatedEntry(usage("early-usage", "orphan", "pending"));
	await expectFreshSelection(session, "leaf not received yet");
	session.ingestReplicatedEntry(message("pending", "orphan", "pending"));
	await expectFreshSelection(session, "missing leaf arriving");
}

describe("SessionManager context selection memo", () => {
	it("matches a fresh selection after every kind of append in memory", async () => {
		const session = SessionManager.inMemory();
		try {
			await appendEveryKind(session);
		} finally {
			await session.close();
		}
	});

	it("matches a fresh selection after every kind of append on disk", async () => {
		using dir = TempDir.createSync("@context-selection-memo-");
		const session = SessionManager.create(dir.path(), dir.path());
		try {
			await appendEveryKind(session);
		} finally {
			await session.close();
		}
	});

	it("changes the graph revision when the entry graph is rewritten, and only then", async () => {
		using dir = TempDir.createSync("@context-graph-revision-");
		const session = SessionManager.create(dir.path(), dir.path());
		try {
			const first = session.appendMessage(user("first"));
			const discarded = session.appendMessage(reply());
			const tier = session.appendServiceTierChange(null);
			const unchanged = session.graphRevision;
			session.appendCustomEntry("probe");
			session.branch(first);
			session.branch(tier);
			expect(session.graphRevision).toBe(unchanged);

			// Recovery's discard moves the tier change onto `first`; a memo anchored
			// on the tier change still finds its anchor on the branch.
			await session.discardEntryDurably(discarded);
			expect(session.getBranch().map(entry => entry.id)).not.toContain(discarded);
			expect(session.iterateBranchAfter(tier)).toBeDefined();
			const discardedRevision = session.graphRevision;
			expect(discardedRevision).not.toBe(unchanged);

			const moved = session.getEntry(tier);
			if (!moved) throw new Error("Missing tier change");
			moved.parentId = null;
			session.updateEntry(moved);
			expect(session.graphRevision).not.toBe(discardedRevision);
		} finally {
			await session.close();
		}
	});

	it("moves a held entry edited onto another parent in its branch, children and graph revision", async () => {
		const session = SessionManager.inMemory();
		try {
			const first = session.appendMessage(user("first"));
			const probe = session.appendCustomEntry("probe");
			const last = session.appendMessage(user("last"));
			const ids = (entries: readonly SessionEntry[]) => entries.map(entry => entry.id);
			expect(ids(session.getBranch())).toEqual([first, probe, last]);
			const unchanged = session.graphRevision;

			const relabelled = session.getEntry(probe);
			if (relabelled?.type !== "custom") throw new Error("Missing probe entry");
			relabelled.customType = "relabelled";
			expect(session.graphRevision).toBe(unchanged);

			// Edited in place, then announced: either way the entry has moved once.
			const tail = session.getEntry(last);
			if (!tail) throw new Error("Missing tail");
			tail.parentId = first;
			for (const step of ["edited in place", "announced"]) {
				expect({
					step,
					branch: ids(session.getBranch()),
					underFirst: ids(session.getChildren(first)),
					underProbe: ids(session.getChildren(probe)),
				}).toEqual({ step, branch: [first, last], underFirst: [probe, last], underProbe: [] });
				session.updateEntry(tail);
			}
			const moved = session.graphRevision;
			expect(moved).not.toBe(unchanged);

			// A replacement object takes the old one's place on the branch.
			const replacement = { ...tail };
			session.updateEntry(replacement);
			expect(session.getBranch().at(-1)).toBe(replacement);
			expect(session.graphRevision).toBe(moved);
		} finally {
			await session.close();
		}
	});

	it("keeps the replayed leaf's selection in memory while the leaf is unavailable", async () => {
		using dir = TempDir.createSync("@context-selection-unavailable-leaf-");
		const session = SessionManager.create(dir.path(), dir.path());
		try {
			const first = session.appendMessage(user("first"));
			const answered = session.appendMessage(reply());
			await session.flush();
			const expected = structuredClone(session.buildSessionContext());
			// The leaf a late entry captured was rolled back, or a replica has not received it yet.
			session.ingestReplicatedEntry(usage("late-usage", first, "removed-entry"));
			await session.flush();
			expect(session.getLeafId()).toBe("removed-entry");

			// Blank the context's records in the journal, so reading one back fails.
			const file = session.getSessionFile();
			if (!file) throw new Error("Expected a session file");
			const journal = await Bun.file(file).bytes();
			const fd = fs.openSync(file, "r+");
			try {
				let start = 0;
				for (const line of new TextDecoder().decode(journal).split("\n")) {
					const length = Buffer.byteLength(line);
					if (line.includes(`"id":"${first}"`) || line.includes(`"id":"${answered}"`))
						fs.writeSync(fd, Buffer.alloc(length, " "), 0, length, start);
					start += length + 1;
				}
			} finally {
				fs.closeSync(fd);
			}
			Bun.gc(true);
			for (const call of ["first", "second"]) {
				expect({ call, context: session.buildSessionContext() }).toEqual({ call, context: expected });
			}
		} finally {
			await session.close();
		}
	});

	it("reselects after an announced edit of a selection input outside the metadata", async () => {
		using dir = TempDir.createSync("@context-selection-payload-edit-");
		const session = SessionManager.create(dir.path(), dir.path());
		const file = session.getSessionFile();
		if (!file) throw new Error("Expected a session file");
		let live: SessionContext | undefined;
		try {
			const defaultModel = session.appendModelChange("anthropic/claude-sonnet-4-20250514");
			session.appendMessage(user("ORIGINAL REQUEST"));
			const answered = session.appendMessage(reply());
			const kept = session.appendMessage(toolResult("KEPT RESULT"));
			const compactionId = session.appendCompaction("summary", undefined, kept, 1000);
			await expectFreshSelection(session, "compaction keeping the tool result");

			// Each edit changes what the selection reads from a payload, not its metadata.
			const compaction = session.getEntry(compactionId);
			if (compaction?.type !== "compaction") throw new Error("Missing compaction");
			compaction.details = { kind: "experimental-context-rollover" };
			session.updateEntry(compaction);
			await expectFreshSelection(session, "rollover kind");
			compaction.preserveData = { openaiRemoteCompaction: { provider: "openai", replacementHistory: [] } };
			compaction.providerReplayThroughEntryId = answered;
			session.updateEntry(compaction);
			await expectFreshSelection(session, "provider replay through the reply");
			const change = session.getEntry(defaultModel);
			if (change?.type !== "model_change") throw new Error("Missing model change");
			change.role = "smol";
			session.updateEntry(change);
			await expectFreshSelection(session, "default model change made a role model change");
			// Producers make announced edits durable with a rewrite.
			await session.rewriteEntries();
			live = session.buildSessionContext();
		} finally {
			await session.close();
		}
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			expect(reopened.buildSessionContext()).toEqual(live!);
		} finally {
			await reopened.close();
		}
	});

	it("infers the default model past a synthetic error reply after a compaction, in memory and reopened", async () => {
		using dir = TempDir.createSync("@context-selection-synthetic-reply-");
		const session = SessionManager.create(dir.path(), dir.path());
		const file = session.getSessionFile();
		if (!file) throw new Error("Expected a session file");
		try {
			session.appendMessage(reply());
			const kept = session.appendMessage(user("kept"));
			session.appendCompaction("Earlier work.", undefined, kept, 1000);
			await expectFreshSelection(session, "compacted");
			session.appendMessage({ ...reply(), model: "<synthetic>", stopReason: "error", errorMessage: "API Error" });
			await expectFreshSelection(session, "synthetic error appended");
			expect(session.buildSessionContext().models.default).toBe("anthropic/claude-sonnet-4-20250514");
		} finally {
			await session.close();
		}
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			await expectFreshSelection(reopened, "reopened");
			expect(reopened.buildSessionContext().models.default).toBe("anthropic/claude-sonnet-4-20250514");
		} finally {
			await reopened.close();
		}
	});

	it("selects the history behind a compaction the reading model cannot replay, on a reopened session", async () => {
		using dir = TempDir.createSync("@context-selection-readable-boundary-");
		const session = SessionManager.create(dir.path(), dir.path());
		const file = session.getSessionFile();
		if (!file) throw new Error("Expected a session file");
		try {
			session.appendMessage(user("BEHIND THE COMPACTION"));
			const kept = session.appendMessage(reply());
			// Only the OpenAI lane that wrote it can replay a remote compaction's payload.
			session.appendCompaction("Remote compaction placeholder.", undefined, kept, 1000, {
				method: "remote",
				preserveData: { openaiRemoteCompaction: { provider: gpt.provider, replacementHistory: [] } },
			});
			session.appendMessage(user("after the compaction"));
		} finally {
			await session.close();
		}
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			// Each model reads what the canonical builder gives it from every entry, before and after an
			// append extends the selections; Claude again reuses the selection it was given first.
			for (const step of ["reopened", "after an append"]) {
				if (step === "after an append") reopened.appendMessage(user("after the reopen"));
				await reopened.flush();
				const entries = reopened.getEntries();
				const leaf = reopened.getLeafId();
				for (const model of [claude, gpt, claude]) {
					const expected = {
						step,
						model: model.id,
						context: buildSessionContext(entries, leaf, undefined, { model }),
					};
					expect({ step, model: model.id, context: reopened.buildSessionContext({ model }) }).toEqual(expected);
					const branch = reopened.getContextBranch(model).toReversed();
					expect({ step, model: model.id, context: buildSessionContextFromLeafPath(branch, { model }) }).toEqual(
						expected,
					);
				}
			}
			expect(JSON.stringify(reopened.buildSessionContext({ model: claude }).messages)).toContain(
				"BEHIND THE COMPACTION",
			);
			expect(JSON.stringify(reopened.buildSessionContext({ model: gpt }).messages)).not.toContain(
				"BEHIND THE COMPACTION",
			);
		} finally {
			await reopened.close();
		}
	});

	it("finds the compaction each model reads from the index as a scan of the branch does", async () => {
		using dir = TempDir.createSync("@context-selection-readable-compaction-");
		const session = SessionManager.create(dir.path(), dir.path());
		const file = session.getSessionFile();
		if (!file) throw new Error("Expected a session file");
		let local: string;
		let remote: string;
		try {
			const first = session.appendMessage(user("first"));
			session.appendMessage(reply());
			local = session.appendCompaction("Local summary any model reads.", undefined, first, 1000);
			const second = session.appendMessage(user("second"));
			session.appendMessage(reply());
			remote = session.appendCompaction("Remote compaction placeholder.", undefined, second, 1000, {
				method: "remote",
				preserveData: { openaiRemoteCompaction: { provider: gpt.provider, replacementHistory: [] } },
			});
			session.appendMessage(user("after the compactions"));
		} finally {
			await session.close();
		}
		const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			const branch = reopened.getBranch();
			for (const [model, expected] of [
				[claude, local],
				[gpt, remote],
				[undefined, remote],
			] as const) {
				const name = model?.id ?? "no model";
				expect({ name, id: reopened.getReadableCompactionEntry(model)?.id }).toEqual({ name, id: expected });
				expect(getReadableCompactionEntry(branch, model)?.id).toBe(expected);
			}
		} finally {
			await reopened.close();
		}
	});
});
