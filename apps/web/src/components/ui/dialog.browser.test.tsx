import { createRef } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import {
  type ConfirmDialogChoice,
  requestConfirmDialogChoice,
  resetConfirmDialogForTests,
} from "~/confirmDialog";
import { act, render } from "../../../test/render";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { getDesktopUpdateInstallDialog } from "../desktopUpdate.logic";
import { Button } from "./button";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

const updateInstallDialog = (installWhenIdle: boolean) =>
  getDesktopUpdateInstallDialog({
    availableVersion: "1.2.3",
    downloadedVersion: "1.2.3",
    ...(installWhenIdle ? { installWhenIdle: true } : {}),
  }).options;

describe("dialog initial focus", () => {
  it.each([
    { label: "generic", options: undefined, focused: "Cancel", choice: "cancel" },
    {
      label: "destructive opt-in",
      options: { variant: "destructive", initialFocus: "confirm" },
      focused: "Cancel",
      choice: "cancel",
    },
    {
      label: "opt-in",
      options: { initialFocus: "confirm" },
      focused: "Confirm",
      choice: "confirm",
    },
    {
      label: "restart update",
      options: updateInstallDialog(false),
      focused: "Cancel",
      choice: "cancel",
    },
    {
      label: "queued restart",
      options: updateInstallDialog(true),
      focused: "Keep waiting",
      choice: "cancel",
    },
  ] as const)(
    "focuses $focused for a $label confirmation",
    async ({ options, focused, choice }) => {
      resetConfirmDialogForTests();
      await using _screen = await render(<ConfirmDialogHost />);
      let confirmation: Promise<ConfirmDialogChoice> | undefined;
      await act(() => {
        confirmation = requestConfirmDialogChoice("Continue?", options);
      });

      await expect.element(page.getByRole("button", { name: focused, exact: true })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect(confirmation).resolves.toBe(choice);
    },
  );

  it("focuses the dialog action and keeps the caller's popup ref", async () => {
    const popup = createRef<HTMLDivElement>();
    await using _screen = await render(
      <Dialog>
        <DialogTrigger>Open retry</DialogTrigger>
        <DialogPopup ref={popup}>
          <DialogTitle>Import failed</DialogTitle>
          <DialogClose>Cancel</DialogClose>
          <DialogAction>Try again</DialogAction>
        </DialogPopup>
      </Dialog>,
    );
    await act(() => page.getByRole("button", { name: "Open retry" }).element().focus());
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByRole("button", { name: "Try again" })).toHaveFocus();
    expect(popup.current).toBe(page.getByRole("dialog").element());
  });

  it.each(["disabled action", "caller initialFocus"] as const)(
    "falls back to Cancel for a %s",
    async (reason) => {
      const cancel = createRef<HTMLButtonElement>();
      await using _screen = await render(
        <Dialog defaultOpen>
          <DialogPopup {...(reason === "caller initialFocus" ? { initialFocus: cancel } : {})}>
            <DialogTitle>Install update?</DialogTitle>
            <DialogClose ref={cancel} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <DialogAction disabled={reason === "disabled action"}>Install</DialogAction>
          </DialogPopup>
        </Dialog>,
      );

      await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
    },
  );

  it("focuses the popup instead of the action when opened by touch", async () => {
    await using _screen = await render(
      <Dialog>
        <DialogTrigger>Open installer</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Install relay client</DialogTitle>
          <DialogClose>Cancel</DialogClose>
          <DialogAction>Install</DialogAction>
        </DialogPopup>
      </Dialog>,
    );

    const trigger = page.getByRole("button", { name: "Open installer" }).element();
    await act(() => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
      );
      trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
      trigger.dispatchEvent(
        new PointerEvent("click", { bubbles: true, pointerType: "touch", detail: 1 }),
      );
    });

    await expect.element(page.getByRole("dialog")).toHaveFocus();
  });
});
