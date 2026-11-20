import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  requestConfirmDialog,
  requestConfirmDialogChoice,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "./confirmDialog";

const mountHost = () => subscribeConfirmDialogHost(() => {});

function requireConfirmation<T>(confirmation: Promise<T> | undefined): Promise<T> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = mountHost();
    const labels = { confirm: "Restart now", cancel: "Cancel", alternative: "Restart when idle" };
    const first = requireConfirmation(
      requestConfirmDialog("Delete the project?", { initialFocus: "confirm" }),
    );
    const second = requireConfirmation(requestConfirmDialogChoice("Restart T3 Code?", { labels }));

    respondToConfirmDialog("cancel");
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete the project?",
      variant: "default",
      initialFocus: "confirm",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Restart T3 Code?",
      variant: "default",
      labels,
    });

    respondToConfirmDialog("alternative");
    await expect(second).resolves.toBe("alternative");
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = mountHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("has no host until one subscribes", () => {
    expect(requestConfirmDialog("Continue?")).toBeUndefined();
    const unsubscribe = mountHost();
    expect(requestConfirmDialog("Continue?")).toBeDefined();
    unsubscribe();
    expect(requestConfirmDialog("Continue?")).toBeUndefined();
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = mountHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?"));

    respondToConfirmDialog("confirm");
    respondToConfirmDialog("cancel");
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toBe(true);
  });
});
