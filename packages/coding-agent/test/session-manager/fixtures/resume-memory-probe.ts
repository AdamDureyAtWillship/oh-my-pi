import assert from "node:assert/strict";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../helpers";

const MiB = 1024 * 1024;
const RESULT_COUNT = 64;
const RESULT_BYTES = 2 * MiB;
const timestamp = "2026-01-01T00:00:00.000Z";
const mode = process.argv.at(-1);
assert(mode === "compacted" || mode === "uncompacted" || mode === "agent");
// "agent" resumes the compacted journal through an AgentSession, with a kept
// reply whose prompt digest the session's tools look up as they are built.
const compacted = mode !== "uncompacted";

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
	if (compacted) {
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
	if (mode === "agent") {
		write({
			type: "message",
			id: "reply",
			parentId: "compact",
			timestamp,
			message: { ...makeAssistantMessage(), timestamp: 101 },
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
let authStorage: AuthStorage | undefined;
let agentSession: AgentSession | undefined;
try {
	const context = session.buildSessionContext();
	if (mode === "agent") {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		assert(model);
		authStorage = await AuthStorage.create(":memory:");
		agentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "unused",
				initialState: { model, systemPrompt: [], tools: [], messages: context.messages },
			}),
			sessionManager: session,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
		});
	}
	assert.deepEqual(session.getInjectedTtsrRules(), []);
	assert.equal(session.getCredentialPins().size, 0);
	assert.equal(session.getLastModelChangeRole(), undefined);
	const retainedAfterOpenBytes = Math.max(0, (await liveBytes()) - baseline);
	const contextResultCount = context.messages.filter(message => message.role === "toolResult").length;
	assert.equal(contextResultCount, compacted ? 0 : RESULT_COUNT);
	if (compacted) {
		assert.equal(context.messages.length, mode === "agent" ? 3 : 2);
		assert.equal(context.messages[0].role, "compactionSummary");
		assert.deepEqual(context.messages[1], { role: "user", content: "keep this request", timestamp: 100 });
	}
	const exactDemandCount = compacted ? readHistoricalPayloads(session) : 0;
	const retainedAfterDemandBytes = Math.max(0, (await liveBytes()) - baseline);
	// Keep the manager, the agent session and the active context live through the second measurement.
	assert.deepEqual(session.buildSessionContext().messages, context.messages);
	assert.equal(agentSession?.messages.length, mode === "agent" ? 3 : undefined);
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
	await agentSession?.dispose();
	authStorage?.close();
	await session.close();
}
