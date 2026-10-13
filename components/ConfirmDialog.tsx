"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { settleConfirm, useConfirmRequest, type ConfirmRequest } from "@/lib/ui/confirm";

// Shows the confirmation the app is waiting on, if any. Escape and the
// backdrop answer no. Focus starts on the action and returns afterwards.
export function ConfirmDialog() {
  const request = useConfirmRequest();
  if (!request) return null;
  return <Dialog key={request.message} request={request} />;
}

function Dialog({ request }: { request: ConfirmRequest }) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const textId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    actionRef.current?.focus();
    return () => opener?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      settleConfirm(false);
    } else if (e.key === "Tab") {
      // Only two buttons, so Tab moves between them.
      e.preventDefault();
      (document.activeElement === actionRef.current ? cancelRef.current : actionRef.current)?.focus();
    }
  }

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settleConfirm(false);
      }}
    >
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-describedby={textId} onKeyDown={onKeyDown}>
        <p id={textId} className="confirm-text">
          {request.message}
        </p>
        <div className="confirm-actions">
          <button type="button" className="btn ghost" ref={cancelRef} onClick={() => settleConfirm(false)}>
            Cancel
          </button>
          <button type="button" className="btn primary" ref={actionRef} onClick={() => settleConfirm(true)}>
            {request.action}
          </button>
        </div>
      </div>
    </div>
  );
}
