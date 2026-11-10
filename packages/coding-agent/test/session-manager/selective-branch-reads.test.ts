import { expect, it } from "bun:test";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { EVAL_STATE_CONTEXT_TYPE } from "@oh-my-pi/pi-coding-agent/eval/state";
import { movesConversation } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

it("refreshes retained metadata and parent changes after repeated branch selections", async () => {
	const manager = SessionManager.inMemory();
	try {
		const first = manager.appendCustomEntry("checkpoint", { revision: 1 });
		const middle = manager.appendCustomEntry("unrelated", {});
		const last = manager.appendCustomEntry("checkpoint", { revision: 2 });
		const select = () =>
			manager.getBranchMatching(metadata => metadata.customType === "checkpoint").map(entry => entry.id);
		expect(select()).toEqual([first, last]);
		expect(select()).toEqual([first, last]);
		const retained = manager.getEntry(middle);
		if (!retained || retained.type !== "custom") throw new Error("Missing custom entry");
		retained.customType = "checkpoint";
		expect(select()).toEqual([first, middle, last]);
		const tail = manager.getEntry(last);
		if (!tail) throw new Error("Missing tail");
		tail.parentId = first;
		expect(select()).toEqual([first, last]);
		expect(select()).toEqual([first, last]);
		manager.branch(middle);
		expect(select()).toEqual([first, middle]);
	} finally {
		await manager.close();
	}
});

it("refreshes retained metadata before a filtered journal read", async () => {
	const manager = SessionManager.inMemory();
	try {
		const first = manager.appendCustomEntry("checkpoint", { revision: 1 });
		const middle = manager.appendCustomEntry("unrelated", {});
		const select = () =>
			Array.from(
				manager.iterateEntries("custom", { matching: metadata => metadata.customType === "checkpoint" }),
				entry => entry.id,
			);
		expect(select()).toEqual([first]);
		const retained = manager.getEntry(middle);
		if (!retained || retained.type !== "custom") throw new Error("Missing custom entry");
		retained.customType = "checkpoint";
		expect(select()).toEqual([first, middle]);
		expect(Array.from(manager.iterateEntries("custom", { newestFirst: true }), entry => entry.id)).toEqual([
			middle,
			first,
		]);
	} finally {
		await manager.close();
	}
});

it("finds the conversation tip of a reopened session as a scan of every entry does", async () => {
	using dir = TempDir.createSync("@conversation-tip-");
	const session = SessionManager.create(dir.path(), dir.path());
	const file = session.getSessionFile();
	if (!file) throw new Error("Expected a session file");
	const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
	const reply = (): AssistantMessage => makeAssistantMessage();
	let asked: string;
	let answered: string;
	try {
		asked = session.appendMessage(user("question"));
		answered = session.appendMessage(reply());
		// An eval-state snapshot is a conversation entry type that does not move the conversation.
		session.appendCustomMessageEntry(EVAL_STATE_CONTEXT_TYPE, "eval state", false);
	} finally {
		await session.close();
	}
	const reopened = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
	try {
		const expectReferenceTip = (step: string) => {
			const branchTip = reopened.getBranch().findLast(movesConversation);
			const newest = reopened.getEntries().findLast(movesConversation);
			const expected = branchTip && branchTip === newest ? branchTip.id : undefined;
			expect({ step, tip: reopened.getConversationTip()?.id }).toEqual({ step, tip: expected });
		};
		expectReferenceTip("reply behind an eval-state snapshot");
		expect(reopened.getConversationTip()?.id).toBe(answered);
		reopened.branch(asked);
		const retried = reopened.appendMessage(reply());
		expectReferenceTip("reply on another branch");
		expect(reopened.getConversationTip()?.id).toBe(retried);
		reopened.branch(answered);
		expectReferenceTip("older branch");
		expect(reopened.getConversationTip()).toBeUndefined();
	} finally {
		await reopened.close();
	}
});
