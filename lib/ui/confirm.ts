"use client";

// A confirmation the app asks itself, in place of window.confirm, which some
// browsers answer with false without showing anything. confirm() resolves
// when the person presses the action or Cancel, and ConfirmDialog renders
// the pending request.

import { useSyncExternalStore } from "react";

export interface ConfirmRequest {
  message: string;
  action: string; // the label of the button that goes ahead, such as "Delete"
}

interface Pending {
  request: ConfirmRequest;
  resolve: (ok: boolean) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function set(next: Pending | null) {
  pending = next;
  for (const listener of listeners) listener();
}

export function confirm(request: ConfirmRequest): Promise<boolean> {
  pending?.resolve(false); // one question at a time
  return new Promise((resolve) => set({ request, resolve }));
}

export function settleConfirm(ok: boolean): void {
  const current = pending;
  if (!current) return;
  set(null);
  current.resolve(ok);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useConfirmRequest(): ConfirmRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => pending?.request ?? null,
    () => null,
  );
}
