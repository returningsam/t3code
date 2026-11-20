import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

export type ConfirmDialogChoice = "confirm" | "alternative" | "cancel";

/** `alternative` adds a third button between Cancel and Confirm. */
export interface ConfirmDialogLabels {
  readonly confirm: string;
  readonly cancel: string;
  readonly alternative: string;
}

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly initialFocus: ConfirmDialogOptions["initialFocus"];
      readonly labels: ConfirmDialogLabels | undefined;
    }
  | {
      readonly status: "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly initialFocus: ConfirmDialogOptions["initialFocus"];
      readonly labels: ConfirmDialogLabels | undefined;
    };

type PendingConfirmation = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly initialFocus: ConfirmDialogOptions["initialFocus"];
  readonly labels: ConfirmDialogLabels | undefined;
  readonly resolve: (choice: ConfirmDialogChoice) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(choice: ConfirmDialogChoice): void {
  activeConfirmation?.resolve(choice);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(choice);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

/**
 * Only themed hosts subscribe, so a subscriber is a mounted host. When the last
 * one leaves, pending confirmations resolve as cancelled.
 */
export function subscribeConfirmDialogHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    resolvePendingConfirmations("cancel");
    publish(idleState);
  };
}

/** Undefined means no themed host is available. */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  return requestConfirmDialogChoice(message, options)?.then((choice) => choice === "confirm");
}

/** Undefined means no themed host is available. */
export function requestConfirmDialogChoice(
  message: string,
  options?: ConfirmDialogOptions & { readonly labels?: ConfirmDialogLabels },
): Promise<ConfirmDialogChoice> | undefined {
  if (listeners.size === 0) return undefined;

  const confirmation = new Promise<ConfirmDialogChoice>((resolve) => {
    const pending = {
      message,
      variant: options?.variant ?? "default",
      initialFocus: options?.initialFocus,
      labels: options?.labels,
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({
      status: "confirming",
      message,
      variant: pending.variant,
      initialFocus: pending.initialFocus,
      labels: pending.labels,
    });
  });

  return confirmation;
}

export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function respondToConfirmDialog(choice: ConfirmDialogChoice): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(choice);
  publish({
    status: "closing",
    message: state.message,
    variant: state.variant,
    initialFocus: state.initialFocus,
    labels: state.labels,
  });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({
    status: "confirming",
    message: next.message,
    variant: next.variant,
    initialFocus: next.initialFocus,
    labels: next.labels,
  });
}

export function resetConfirmDialogForTests(): void {
  listeners.clear();
  resolvePendingConfirmations("cancel");
  publish(idleState);
}
