"use client";

import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@/lib/types";
import { filesToAttachments, IMAGE_ACCEPT, imageFilesFromClipboard, MAX_ATTACHMENTS } from "@/lib/ui/images";
import { Icon } from "./Icon";
import { AttachmentChip, cx, IconButton } from "./ui";

// The message box at the bottom of the thread. Ctrl or ⌘ with Enter sends.
// Images can be picked, pasted or dropped onto the box.
//
// The composer owns its draft. To hand it a message, such as the one a rewind
// returns, give it `initial` and a new key: it starts again with that text and
// those images, and takes the focus.
export function Composer({
  first,
  nextRound,
  busy,
  allOff,
  initial,
  onSend,
  onStop,
}: {
  first: boolean; // the table has no rounds yet
  nextRound: number;
  busy: boolean;
  allOff: boolean; // every agent is switched off, so a round cannot start
  initial?: { text: string; attachments: Attachment[] };
  onSend: (text: string, attachments: Attachment[]) => boolean; // false when the round did not start
  onStop: () => void;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>(initial?.attachments ?? []);
  const field = useRef<HTMLTextAreaElement>(null);
  const focusOnMount = useRef(Boolean(initial));

  // A handed-over draft takes the focus, with the caret after its text.
  useEffect(() => {
    const el = field.current;
    if (!focusOnMount.current || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(0); // images still being read and resized
  const input = useRef<HTMLInputElement>(null);

  const hasContent = text.trim() !== "" || attachments.length > 0;
  const canSend = !busy && !allOff && preparing === 0 && (!first || hasContent);

  function send() {
    if (!canSend) return;
    if (!onSend(text.trim(), attachments)) return;
    setText("");
    setAttachments([]);
    setError(null);
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    setPreparing((n) => n + 1);
    try {
      const result = await filesToAttachments(files, room);
      setAttachments((a) => [...a, ...result.attachments].slice(0, MAX_ATTACHMENTS));
      setError(result.error ?? null);
    } finally {
      setPreparing((n) => n - 1);
    }
  }

  const label = first ? "Send" : "Next round";

  return (
    <div className="composer">
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div
        className={cx("box", dragging && "drop")}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {attachments.length || preparing ? (
          <div className="att-list">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                onRemove={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              />
            ))}
            {preparing ? (
              <span className="att preparing" role="status">
                <span className="pulse" aria-hidden="true" />
                Preparing image
              </span>
            ) : null}
          </div>
        ) : null}
        <textarea
          ref={field}
          rows={2}
          value={text}
          aria-label={first ? "First message" : `Note for round ${nextRound}`}
          placeholder={first ? "Write the first message" : `Add a note for round ${nextRound} (optional)`}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = imageFilesFromClipboard(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="box-bar">
          <input
            ref={input}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void addFiles(files);
            }}
          />
          <IconButton
            icon="paperclip"
            label="Attach images"
            onClick={() => input.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
          />
          <span className="box-space" />
          {/* The two buttons share a place, so each ignores clicks for a moment
              after it appears. A click meant for Stop as a round ends then does
              not start the next round, and a double click on Next round does not stop it. */}
          {busy ? (
            <button key="stop" type="button" className="btn arm" onClick={onStop}>
              <Icon name="stop" />
              Stop
            </button>
          ) : (
            <button
              key="send"
              type="button"
              className="btn primary arm"
              onClick={send}
              disabled={!canSend}
              title={allOff ? "All agents are off." : undefined}
            >
              <Icon name={first ? "arrowUp" : "arrowRight"} />
              {label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
