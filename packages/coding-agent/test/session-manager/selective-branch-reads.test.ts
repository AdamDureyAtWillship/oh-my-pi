import { expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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
