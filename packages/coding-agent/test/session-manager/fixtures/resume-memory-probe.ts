import assert from "node:assert/strict";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const MiB = 1024 * 1024;
const RESULT_COUNT = 64;
const RESULT_BYTES = 2 * MiB;
const timestamp = "2026-01-01T00:00:00.000Z";
const mode = process.argv.at(-1);
assert(mode === "compacted" || mode === "uncompacted");

function payload(index: number): string {
	// Distinct strings, with a UTF-8 prefix before every later byte offset.
	return `результат 🐈 ${index}\n${String.fromCharCode(65 + (index % 26)).repeat(RESULT_BYTES)}\nконец ${index}`;
}

async function writeJournal(file: string, cwd: string): Promise<void> {
	const writer = Bun.file(file).writer();
	const write = (entry: unknown) => writer.write(`${JSON.stringify(entry)}\n`);
	write({ type: "session", version: 3, id: "heap-resume", timestamp, cwd });
	write({
		type: "message",
		id: "root",
		parentId: null,
		timestamp,
		message: { role: "user", content: "original request", timestamp: 1 },
	});
	for (let index = 0; index < RESULT_COUNT; index++) {
		write({
			type: "message",
			id: `result-${index}`,
			parentId: index === 0 ? "root" : `result-${index - 1}`,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: payload(index) }],
				isError: false,
				timestamp: index + 2,
			},
		});
		// Fixture generation itself never owns the complete 128 MiB journal.
		await writer.flush();
	}
	write({
		type: "message",
		id: "kept",
		parentId: `result-${RESULT_COUNT - 1}`,
		timestamp,
		message: { role: "user", content: "keep this request", timestamp: 100 },
	});
	if (mode === "compacted") {
		write({
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp,
			firstKeptEntryId: "kept",
			summary: "old results summarized",
			tokensBefore: 100000,
		});
	}
	await writer.end();
}

async function liveBytes(): Promise<number> {
	Bun.gc(true);
	await setImmediate();
	Bun.gc(true);
	const memory = process.memoryUsage();
	// JSC's large strings may be externally allocated. heapUsed alone is not
	// an ownership oracle; the uncompacted control checks this metric too.
	return Math.max(memory.heapUsed, memory.external);
}

function readHistoricalPayloads(session: SessionManager): number {
	for (let index = 0; index < RESULT_COUNT; index++) {
		const entry = session.getEntry(`result-${index}`);
		assert(entry?.type === "message" && entry.message.role === "toolResult");
		assert.deepEqual(entry.message.content, [{ type: "text", text: payload(index) }]);
	}
	// Both explicit history consumers must let go of their full-object result
	// when the consumer frame returns, rather than installing a strong cache.
	assert.equal(session.getBranch(`result-${RESULT_COUNT - 1}`).length, RESULT_COUNT + 1);
	assert.equal(session.getTree()[0].entry.id, "root");
	return RESULT_COUNT;
}

using dir = TempDir.createSync("@resume-heap-probe-");
const file = path.join(dir.path(), "session.jsonl");
await writeJournal(file, dir.path());
const fixtureBytes = Bun.file(file).size;
const baseline = await liveBytes();
const session = await SessionManager.open(file, dir.path(), undefined, {
	throwIfMissing: true,
	suppressBreadcrumb: true,
});
try {
	const context = session.buildSessionContext();
	assert.deepEqual(session.getInjectedTtsrRules(), []);
	assert.equal(session.getCredentialPins().size, 0);
	assert.equal(session.getLastModelChangeRole(), undefined);
	const retainedAfterOpenBytes = Math.max(0, (await liveBytes()) - baseline);
	const contextResultCount = context.messages.filter(message => message.role === "toolResult").length;
	assert.equal(contextResultCount, mode === "compacted" ? 0 : RESULT_COUNT);
	if (mode === "compacted") {
		assert.equal(context.messages.length, 2);
		assert.equal(context.messages[0].role, "compactionSummary");
		assert.deepEqual(context.messages[1], { role: "user", content: "keep this request", timestamp: 100 });
	}
	const exactDemandCount = mode === "compacted" ? readHistoricalPayloads(session) : 0;
	const retainedAfterDemandBytes = Math.max(0, (await liveBytes()) - baseline);
	// Keep both manager and active context live through the second measurement.
	assert.deepEqual(session.buildSessionContext().messages, context.messages);
	await Bun.write(
		Bun.stdout,
		JSON.stringify({
			fixtureBytes,
			payloadBytes: RESULT_COUNT * RESULT_BYTES,
			resultCount: RESULT_COUNT,
			retainedAfterOpenBytes,
			retainedAfterDemandBytes,
			exactDemandCount,
			contextResultCount,
		}),
	);
} finally {
	await session.close();
}
