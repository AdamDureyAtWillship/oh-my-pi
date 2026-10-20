import { expect, test } from "bun:test";
import { getPruningBranch } from "../src/session/pruning-branch";
import type { SessionEntry, SessionMessageEntry } from "../src/session/session-entries";

function fixture(entries: SessionEntry[]) {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const reads: string[] = [];
	return {
		reads,
		getLeafId: () => entries.at(-1)?.id ?? null,
		getEntry(id: string) {
			reads.push(id);
			return byId.get(id);
		},
	};
}

const timestamp = new Date(0).toISOString();
function note(id: string, parentId: string | null): SessionEntry {
	return { id, parentId, timestamp, type: "custom", customType: "test", data: {} };
}
function message(id: string, parentId: string | null, body: SessionMessageEntry["message"]): SessionMessageEntry {
	return { id, parentId, timestamp, type: "message", message: body };
}
function compact(parentId: string, firstKeptEntryId: string): SessionEntry {
	return {
		id: "compact",
		parentId,
		timestamp,
		type: "compaction",
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

test("does not read summarized entries before a valid boundary", () => {
	const source = fixture([note("old", null), note("kept", "old"), compact("kept", "kept"), note("tail", "compact")]);
	expect(getPruningBranch(source).map(entry => entry.id)).toEqual(["kept", "compact", "tail"]);
	expect(source.reads).toEqual(["tail", "compact", "kept"]);
});

test("retains a pre-boundary call required by a kept tool result", () => {
	const call = message("call", "old", {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "SKILL.md" } }],
	});
	const result = message("result", "call", {
		role: "toolResult",
		toolCallId: "read-call",
		toolName: "read",
		content: [{ type: "text", text: "protected instructions" }],
		isError: false,
		timestamp: 0,
	});
	const source = fixture([note("old", null), call, result, compact("result", "result")]);
	expect(getPruningBranch(source).map(entry => entry.id)).toEqual(["call", "result", "compact"]);
	expect(source.reads).toEqual(["compact", "result", "call"]);
});

test("preserves the whole branch without a compaction or with a missing boundary", () => {
	const entries = [note("old", null), note("tail", "old")];
	expect(getPruningBranch(fixture(entries))).toEqual(entries);
	const invalidBoundary = [...entries, compact("tail", "missing")];
	expect(getPruningBranch(fixture(invalidBoundary))).toEqual(invalidBoundary);
});
