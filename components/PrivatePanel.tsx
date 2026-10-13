"use client";

import { Fragment, useState } from "react";
import type { PrivateMessage, Reply, Seat, Table } from "@/lib/types";
import { excerpt, formatDuration } from "@/lib/ui/format";
import { STOPPED } from "@/lib/ui/storage";
import { useStickToBottom } from "@/lib/ui/useStickToBottom";
import { latestReply, seatColor, seatDisplayName, seatName } from "@/lib/ui/view";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ReplyError } from "./Thread";
import { cx, HostAvatar, IconButton, SeatAvatar, ToolChips } from "./ui";

export function PrivatePanel({
  table,
  seat,
  busy,
  replying,
  onSend,
  onStop,
  onClose,
}: {
  table: Table;
  seat: Seat;
  busy: boolean; // the table is busy with a round or another private reply
  replying: boolean; // this seat is replying privately
  onSend: (text: string) => boolean; // false when the store did not start the reply
  onStop: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const { scrollRef, contentRef } = useStickToBottom();
  const messages = table.privateThreads[seat.id] ?? [];
  const latest = latestReply(table, seat.id);
  const canSend = !busy && text.trim() !== "";
  const name = seatName(seat);

  function send() {
    if (!canSend) return;
    if (onSend(text.trim())) setText("");
  }

  return (
    <aside className="panel private" aria-label={`Private conversation with Agent ${seat.id}`}>
      <div className="panel-head tall">
        <SeatAvatar id={seat.id} color={seatColor(seat)} />
        <div className="panel-who">
          <div className="panel-name">{seatDisplayName(seat)}</div>
          <div className="panel-sub">
            {name ? `Agent ${seat.id} · ${seat.modelName} · Private conversation` : `Agent ${seat.id} · Private conversation`}
          </div>
        </div>
        <IconButton icon="x" label="Close the private conversation" onClick={onClose} />
      </div>
      <p className="panel-status private-status">
        <Icon name="lock" size={12} />
        {name ? `Only Agent ${seat.id} (${name}) sees this conversation.` : `Only Agent ${seat.id} sees this conversation.`}
      </p>

      <div className="private-scroll" ref={scrollRef}>
        <div className="private-list" ref={contentRef}>
          {latest ? (
            <blockquote className="quote">
              <b>
                Agent {seat.id}, round {latest.round.number}
              </b>
              {quoteText(latest.reply)}
            </blockquote>
          ) : null}
          {messages.map((m, i) => (
            <Fragment key={m.id}>
              {i === 0 || messages[i - 1].afterRound !== m.afterRound ? (
                <p className="pm-after">After round {m.afterRound}</p>
              ) : null}
              <PrivateMessageView message={m} seat={seat} />
            </Fragment>
          ))}
        </div>
      </div>

      <div className="panel-foot">
        <div className="box small">
          <textarea
            rows={2}
            value={text}
            aria-label={`Message to Agent ${seat.id}`}
            placeholder={`Message Agent ${seat.id}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="box-bar">
            <span className="box-space" />
            {/* Send and Stop share a place, so each ignores clicks for a moment after it appears. */}
            {replying ? (
              <IconButton key="stop" icon="stop" label="Stop the reply" onClick={onStop} className="bordered arm" />
            ) : (
              <IconButton
                key="send"
                icon="arrowUp"
                label={`Send to Agent ${seat.id}`}
                onClick={send}
                disabled={!canSend}
                className="solid arm"
              />
            )}
          </div>
        </div>
        <button type="button" className="btn back" onClick={onClose}>
          <Icon name="arrowLeft" />
          Back to the table
        </button>
      </div>
    </aside>
  );
}

function PrivateMessageView({ message, seat }: { message: PrivateMessage; seat: Seat }) {
  if (message.role === "host") {
    return (
      <div className="pm">
        <HostAvatar small />
        <div className="pm-main">
          <div className="pm-n">You</div>
          <div className="msg-text host-text">{message.text}</div>
        </div>
      </div>
    );
  }
  const duration = message.status === "done" ? formatDuration(message.durationMs) : "";
  return (
    <div className={cx("pm")} aria-busy={message.status === "streaming" || undefined}>
      <SeatAvatar id={seat.id} color={seatColor(seat)} small />
      <div className="pm-main">
        <div className="pm-n">
          {seatDisplayName(seat)}
          {duration ? (
            <>
              {" · "}
              <span className="mono">{duration}</span>
            </>
          ) : null}
          {message.status === "streaming" || message.status === "queued" ? (
            <span className="msg-state live">
              <span className="pulse" aria-hidden="true" />
              Writing
            </span>
          ) : null}
        </div>
        <ToolChips tools={message.tools} />
        {message.text ? <Markdown text={message.text} className="msg-text" /> : null}
        {message.status === "error" ? <ReplyError error={message.error} hasText={Boolean(message.text)} kind="seat" /> : null}
      </div>
    </div>
  );
}

// The quoted reply at the top of the panel.
function quoteText(reply: Reply): string {
  if (reply.text) return excerpt(reply.text);
  if (reply.status === "error") return reply.error === STOPPED ? "Stopped before it started." : (reply.error ?? "Could not answer.");
  return "No reply yet.";
}
