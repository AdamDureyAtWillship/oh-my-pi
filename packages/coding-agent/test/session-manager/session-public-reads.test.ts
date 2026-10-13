import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile, loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const timestamp = "2026-01-01T00:00:00.000Z";

const expectedFileIds = ["u1", "a1", "c1", "c2", "tail"];

/** Shared semantic plain-value oracle: cloneable and equal to the plain expected value. */
function expectPlainValue<T>(value: T, expected: T): T {
	const cloned = structuredClone(value);
	expect(Bun.deepEquals(cloned, expected)).toBe(true);
	return cloned;
}

function plainBranchIds(entries: SessionEntry[], leafId: string): string[] {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const ids: string[] = [];
	let current = byId.get(leafId);
	while (current) {
		ids.push(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return ids.reverse();
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

function findNode(nodes: SessionTreeNode[], id: string): SessionTreeNode | undefined {
	for (const node of nodes) {
		if (node.entry.id === id) return node;
		const found = findNode(node.children, id);
		if (found) return found;
	}
	return undefined;
}

describe("session public plain reads", () => {
	it("every public read surface returns plain cloneable data matching the persisted copy across reopen", async () => {
		using dir = TempDir.createSync("@public-reads-");
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "plain-reads hello", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp,
				message: {
					...makeAssistantMessage(),
					content: [{ type: "text", text: "plain-reads hi" }],
					timestamp: new Date(timestamp).getTime() + 1000,
				},
			},
			{
				type: "custom",
				id: "c1",
				parentId: "a1",
				timestamp,
				customType: "test-handoff",
				data: {
					items: [
						{ id: "n1", tags: ["a", "b"], payload: { deep: [1, 2, 3] } },
						{ id: "n2", tags: ["c"], payload: { deep: [] } },
					],
					nested: { arr: [1, 2, 3], flag: true },
				},
			},
			{
				type: "custom",
				id: "c2",
				parentId: "a1",
				timestamp,
				customType: "test-handoff",
				data: { items: [], note: "sibling" },
			},
			{
				type: "message",
				id: "tail",
				parentId: "c1",
				timestamp,
				message: { role: "user", content: "plain-reads tail", timestamp: 2 },
			},
		];
		const file = path.join(dir.path(), "session.jsonl");
		await Bun.write(
			file,
			[{ type: "session", version: 3, id: "public-reads", timestamp, cwd: dir.path() }, ...entries]
				.map(entry => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		const plainFileEntries = (await loadEntriesFromFile(file)).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
		const plainById = new Map(plainFileEntries.map(entry => [entry.id, entry]));
		const plainC1 = plainById.get("c1")!;
		const expectedBranchIds = plainBranchIds(plainFileEntries, "tail");
		const expectedBranchC2Ids = plainBranchIds(plainFileEntries, "c2");
		const expectedEdges = plainFileEntries
			.map(entry => [entry.id, entry.parentId] as [string, string | null])
			.sort(([a], [b]) => a.localeCompare(b));

		const session = await SessionManager.open(file, dir.path(), undefined, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
		});
		let clonedHistorical: SessionEntry | undefined;
		let probeId = "";
		let atomicId = "";
		try {
			// Raw reads agree with the persisted plain copy; entries stay chronological.
			expect(session.getEntries().map(entry => entry.id)).toEqual(expectedFileIds);
			expect(Bun.deepEquals(session.getEntries(), plainFileEntries)).toBe(true);
			expect(Bun.deepEquals(session.getEntry("c1"), plainC1)).toBe(true);
			expect(session.getChildren("a1")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "c1", customType: "test-handoff" }),
					expect.objectContaining({ id: "c2", customType: "test-handoff" }),
				]),
			);

			// Demand-loaded historical nested custom payload is plain and cloneable.
			clonedHistorical = expectPlainValue(session.getEntry("c1"), plainC1);
			expect(clonedHistorical).toMatchObject({
				customType: "test-handoff",
				data: { nested: { arr: [1, 2, 3] } },
			});

			// Entry/navigation surfaces match the plain persisted copy.
			expectPlainValue(session.getLeafEntry(), plainById.get("tail"));
			expectPlainValue(
				session.getChildren("a1"),
				plainFileEntries.filter(entry => entry.parentId === "a1"),
			);
			expectPlainValue(session.getEntries(), plainFileEntries);
			expectPlainValue(
				session.getBranch(),
				expectedBranchIds.map(id => plainById.get(id)!),
			);
			expectPlainValue(
				session.getBranch("c2"),
				expectedBranchC2Ids.map(id => plainById.get(id)!),
			);
			const contextEntries = expectPlainValue(
				session.getContextBranch(),
				session.getContextBranch().map(entry => plainById.get(entry.id)!),
			);
			const contextIds = contextEntries.map(entry => entry.id);
			expect(contextIds).toContain("tail");
			for (const id of contextIds) expect(expectedBranchIds).toContain(id);
			expectPlainValue(
				session.getBranchMatching(() => true),
				expectedBranchIds.map(id => plainById.get(id)!),
			);

			// Tree shape is checked by edges against the plain seed, and the nested
			// c1 subtree payload is compared where it actually lives.
			const tree = structuredClone(session.getTree());
			expect(treeEdges(tree)).toEqual(expectedEdges);
			expectPlainValue(findNode(tree, "c1")!.entry, plainC1);
			expectPlainValue(findNode(tree, "c2")!.entry, plainById.get("c2")!);

			// Streaming reads yield plain cloneable entries.
			expectPlainValue([...session.iterateEntries()], plainFileEntries);
			expectPlainValue(
				[...session.iterateBranch()],
				expectedBranchIds.map(id => plainById.get(id)!),
			);
			expectPlainValue([...session.iterateBranch("custom")], [plainC1]);

			// Selected messages equal the plain canonical build; no bare existence checks.
			const canonical = buildSessionContext(plainFileEntries, "tail");
			expectPlainValue(session.buildSessionContext(), canonical);
			const canonicalTranscript = buildSessionContext(plainFileEntries, "tail", undefined, {
				transcript: true,
				collapseCompactedHistory: true,
			}).messages;
			expectPlainValue(await loadSessionMessagesReadOnly(file), canonicalTranscript);

			// Copy/snapshot boundaries are detached plain data.
			const snapshot = expectPlainValue(session.captureState(), {
				...session.captureState(),
				header: structuredClone(session.captureState().header),
				entries: plainFileEntries,
			});
			expect(snapshot.header.id).toBe("public-reads");
			expect(snapshot.entries.map(entry => entry.id)).toEqual(expectedFileIds);
			const clone = session.cloneCurrentSession({ persist: false });
			try {
				expectPlainValue(clone.getEntries(), plainFileEntries);
			} finally {
				await clone.close();
			}
			expectPlainValue(session.snapshotForReplication(), {
				header: structuredClone(session.snapshotForReplication().header),
				entries: plainFileEntries,
			});
			const copy = await session.persistCopy({
				sessionDir: path.join(dir.path(), "copy"),
				suppressBreadcrumb: true,
			});
			try {
				expectPlainValue(copy.getEntries(), plainFileEntries);
			} finally {
				await copy.close();
			}

			// Callback payloads delivered to callers are plain and cloneable.
			const observed: SessionEntry[] = [];
			session.onEntryAppended = entry => {
				observed.push(entry);
			};
			probeId = session.appendCustomEntry("test-probe", { items: [1, 2, 3] });
			atomicId = await session.appendEntriesAtomically(() => session.appendCustomEntry("test-atomic", { ok: true }));
			const clonedObserved = structuredClone(observed);
			expect(clonedObserved.map(entry => entry.id)).toEqual(expect.arrayContaining([probeId, atomicId]));

			// Fork boundary reopens with cloneable plain entries.
			const forked = await session.fork();
			if (!forked) throw new Error("fork returned nothing");
			const forkedSession = await SessionManager.open(forked.newSessionFile, dir.path(), undefined, {
				suppressBreadcrumb: true,
			});
			try {
				const forkedIds = structuredClone(forkedSession.getEntries()).map(entry => entry.id);
				expect(forkedIds).toEqual(expect.arrayContaining([...expectedFileIds, probeId, atomicId]));
			} finally {
				await forkedSession.close();
			}
		} finally {
			await session.close();
		}

		// Second reopen preserves the demand payload and the appended records.
		const reopened = await SessionManager.open(file, dir.path(), undefined, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
		});
		try {
			expectPlainValue(reopened.getEntry("c1"), clonedHistorical!);
			expect(reopened.getEntry(probeId)?.id).toBe(probeId);
			expect(reopened.getEntry(atomicId)?.id).toBe(atomicId);
		} finally {
			await reopened.close();
		}
	});
});
