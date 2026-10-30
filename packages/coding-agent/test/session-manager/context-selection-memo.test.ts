import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { CONTEXT_NOTES_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import {
	type BuildSessionContextOptions,
	buildSessionContext,
	type SessionContext,
	selectSessionContextEntriesFromLeafPath,
	sessionContextEntryMetadata,
} from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { ModelUsageEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const ISO = "2026-10-26T00:00:00.000Z";
const COLLAPSED: BuildSessionContextOptions = { transcript: true, collapseCompactedHistory: true };

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
});
