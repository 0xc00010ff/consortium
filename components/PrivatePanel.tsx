"use client";

import { Fragment, useState } from "react";
import type { PrivateMessage, Reply, Table, ThreadPrivacy } from "@/lib/types";
import { excerpt, formatDuration } from "@/lib/ui/format";
import { STOPPED } from "@/lib/ui/storage";
import { useStickToBottom } from "@/lib/ui/useStickToBottom";
import { latestReply, type Participant } from "@/lib/ui/view";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ReplyError } from "./Thread";
import { ArbiterAvatar, cx, HostAvatar, IconButton, type Resize, ResizeHandle, SeatAvatar, Switch, ToolChips } from "./ui";

export function PrivatePanel({
  table,
  participant,
  busy,
  replying,
  privacy,
  onPrivacy,
  onSend,
  onStop,
  onClose,
  resize,
}: {
  table: Table;
  participant: Participant; // the agent or arbiter, as it is at the table now
  busy: boolean; // the table is busy with a round or another side-conversation reply
  replying: boolean; // this agent or arbiter is replying in the side conversation
  privacy: ThreadPrivacy; // who reads this side conversation
  onPrivacy: (privacy: ThreadPrivacy) => void;
  onSend: (text: string) => boolean; // false when the store did not start the reply
  onStop: () => void;
  onClose: () => void;
  resize?: Resize; // present while the panel sits beside the conversation
}) {
  const [text, setText] = useState("");
  const { scrollRef, contentRef } = useStickToBottom();
  const p = participant;
  const messages = table.privateThreads[p.id] ?? [];
  const latest = latestReply(table, p.id);
  const canSend = !busy && text.trim() !== "";
  const sub =
    p.kind === "arbiter"
      ? `Arbiter · ${p.modelName} · Side conversation`
      : p.hostName
        ? `${p.label} · ${p.modelName} · Side conversation`
        : `${p.label} · Side conversation`;
  const only = p.hostName ? `${p.label} (${p.hostName})` : p.label;
  const kept = privacy === "private";

  function send() {
    if (!canSend) return;
    if (onSend(text.trim())) setText("");
  }

  return (
    <aside className="panel private" aria-label={`Side conversation with ${p.label}`}>
      {resize ? <ResizeHandle edge="start" label="Resize the panel" resize={resize} /> : null}
      <div className="panel-head tall">
        <ParticipantAvatar participant={p} />
        <div className="panel-who">
          <div className="panel-name">{p.name}</div>
          <div className="panel-sub">{sub}</div>
        </div>
        <IconButton icon="x" label="Close the side conversation" onClick={onClose} />
      </div>
      <div className="panel-status private-status">
        <Icon name={kept ? "lock" : "message"} size={12} />
        <span>{kept ? `Only ${only} reads this.` : "The other participants read this from the next round on."}</span>
        <Switch checked={kept} onChange={(on) => onPrivacy(on ? "private" : "shared")} label="Private" />
      </div>

      <div className="private-scroll" ref={scrollRef}>
        <div className="private-list" ref={contentRef}>
          {latest ? (
            <blockquote className="quote">
              <b>
                {p.label}, round {latest.round.number}
              </b>
              {quoteText(latest.reply)}
            </blockquote>
          ) : null}
          {messages.map((m, i) => (
            <Fragment key={m.id}>
              {i === 0 || messages[i - 1].afterRound !== m.afterRound ? (
                <p className="pm-after">After round {m.afterRound}</p>
              ) : null}
              <PrivateMessageView message={m} participant={p} />
            </Fragment>
          ))}
        </div>
      </div>

      <div className="panel-foot">
        <div className="box small">
          <textarea
            rows={2}
            value={text}
            aria-label={`Message to ${p.label}`}
            placeholder={`Message ${p.label}`}
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
                label={`Send to ${p.label}`}
                onClick={send}
                disabled={!canSend}
                className="solid arm"
              />
            )}
          </div>
        </div>
        <button type="button" className="btn back" onClick={onClose}>
          <Icon name="arrowLeft" />
          Back to the conversation
        </button>
      </div>
    </aside>
  );
}

function ParticipantAvatar({ participant, small }: { participant: Participant; small?: boolean }) {
  if (participant.kind === "arbiter") return <ArbiterAvatar small={small} />;
  return <SeatAvatar id={participant.id} color={participant.color ?? "blue"} small={small} />;
}

function PrivateMessageView({ message, participant }: { message: PrivateMessage; participant: Participant }) {
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
      <ParticipantAvatar participant={participant} small />
      <div className="pm-main">
        <div className="pm-n">
          {participant.name}
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
        {message.status === "error" ? <ReplyError
            error={message.error}
            hasText={Boolean(message.text)}
            kind={participant.kind === "arbiter" ? "arbiter" : "seat"}
          /> : null}
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
