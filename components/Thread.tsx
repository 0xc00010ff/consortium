"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Reply, Round, SeatId, Table } from "@/lib/types";
import { copyToClipboard } from "@/lib/ui/download";
import { plural, replyStats } from "@/lib/ui/format";
import { STOPPED } from "@/lib/ui/storage";
import type { StickToBottom } from "@/lib/ui/useStickToBottom";
import {
  arbiterIn,
  isBusy,
  isSeatId,
  modeLabel,
  modeOf,
  privateAfter,
  roundReplyCount,
  seatColor,
  seatDisplayName,
  seatIn,
  seatName,
} from "@/lib/ui/view";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ArbiterAvatar, cx, HostAvatar, SeatAvatar, Thumbs, ToolChips } from "./ui";

// A reply body is capped at about 12 lines of message text (15 px at a
// line height of 1.6 is 1.5rem per line).
const CAP_REM = 18;

export function Thread({
  table,
  activeSeat,
  highlightReplyId,
  onOpenPrivate,
  onVote,
  onRewind,
  stick,
}: {
  table: Table;
  activeSeat: SeatId | null;
  highlightReplyId: string | null;
  onOpenPrivate: (seatId: SeatId) => void;
  onVote: (replyId: string, delta: number) => void;
  onRewind: (roundNumber: number) => void;
  stick: StickToBottom;
}) {
  const { scrollRef, contentRef, hasNew, jump, hold } = stick;
  // Rounds the host opened or closed. Others follow the default: earlier
  // finished rounds are collapsed, the latest round is open. The key includes
  // the time of the host message, so a round sent again after a rewind starts
  // from the default.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  // Replies the host expanded or collapsed. Agent replies start capped and
  // arbiter replies start open, so a reply with no entry follows its kind.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = useCallback((id: string, next: boolean) => setExpanded((e) => ({ ...e, [id]: next })), []);

  const last = table.rounds.length;
  const busy = isBusy(table);
  const mixed = table.rounds.some((r) => table.rounds[0] && modeOf(r) !== modeOf(table.rounds[0]));

  return (
    <div className="thread-wrap">
      <div className="thread-scroll" ref={scrollRef}>
        <div className="thread" ref={contentRef}>
          {table.rounds.length === 0 ? (
            <div className="empty">
              <Icon name="message" size={24} />
              <h2>Start the table</h2>
              <p>Write the first message, and every agent will answer it.</p>
            </div>
          ) : (
            table.rounds.map((round) => {
              const finished = round.status !== "running";
              const key = `${round.number}:${round.host.createdAt}`;
              const collapsed = finished && (toggled[key] ?? round.number < last);
              return (
                <RoundView
                  key={round.number}
                  round={round}
                  table={table}
                  latest={round.number === last}
                  collapsed={collapsed}
                  showInteraction={mixed}
                  activeSeat={activeSeat}
                  highlightReplyId={highlightReplyId}
                  expanded={expanded}
                  onToggleExpanded={toggleExpanded}
                  onHold={hold}
                  onToggle={finished ? () => setToggled((t) => ({ ...t, [key]: !collapsed })) : undefined}
                  onOpenPrivate={onOpenPrivate}
                  onVote={onVote}
                  onRewind={finished && !busy ? () => onRewind(round.number) : undefined}
                />
              );
            })
          )}
        </div>
      </div>
      {hasNew ? (
        <button type="button" className="btn to-newest" onClick={jump}>
          <Icon name="arrowDown" />
          Scroll to newest
        </button>
      ) : null}
    </div>
  );
}

// ---------- a round ----------

function RoundView({
  round,
  table,
  latest,
  collapsed,
  showInteraction,
  activeSeat,
  highlightReplyId,
  expanded,
  onToggleExpanded,
  onHold,
  onToggle,
  onOpenPrivate,
  onVote,
  onRewind,
}: {
  round: Round;
  table: Table;
  latest: boolean;
  collapsed: boolean;
  showInteraction: boolean;
  activeSeat: SeatId | null;
  highlightReplyId: string | null;
  expanded: Record<string, boolean>;
  onToggleExpanded: (id: string, next: boolean) => void;
  onHold: () => void;
  onToggle?: () => void;
  onOpenPrivate: (seatId: SeatId) => void;
  onVote: (replyId: string, delta: number) => void;
  onRewind?: () => void;
}) {
  const status = round.status === "running" ? "Running" : round.status === "stopped" ? "Stopped" : null;
  const interaction = modeLabel(round);
  const count = plural(roundReplyCount(round), "reply", "replies");
  // A spoken name with pauses, since the visible parts sit side by side.
  const label = [`Round ${round.number}`, showInteraction && interaction, status, onToggle && count].filter(Boolean).join(", ");
  const heading = (
    <>
      <span className="round-n">Round {round.number}</span>
      {showInteraction ? <span className="round-tag">{interaction}</span> : null}
      {status ? <span className={cx("round-tag", round.status)}>{status}</span> : null}
      <span className="round-rule" />
      {onToggle ? (
        <>
          <span className="round-c">{count}</span>
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={14} />
        </>
      ) : null}
    </>
  );

  return (
    <section className="round" aria-label={`Round ${round.number}`}>
      <h2 className="round-h" aria-label={label}>
        {onToggle ? (
          <button type="button" className="round-btn" aria-label={label} aria-expanded={!collapsed} onClick={onToggle}>
            {heading}
          </button>
        ) : (
          <span className="round-btn">{heading}</span>
        )}
        {onRewind ? (
          <button
            type="button"
            className="ibtn sm round-act"
            aria-label={`Rewind to round ${round.number}`}
            title={`Rewind to round ${round.number}`}
            onClick={onRewind}
          >
            <Icon name="rewind" size={14} />
          </button>
        ) : null}
      </h2>
      {collapsed ? null : (
        <>
          <HostMessage round={round} />
          {round.replies.map((reply) => {
            const seatId = isSeatId(reply.participantId) ? reply.participantId : null;
            const atTable = seatId !== null && table.seats.some((s) => s.id === seatId);
            const privateCount = seatId ? privateAfter(table, seatId, round.number).length : 0;
            const canReply = latest && round.status !== "running" && atTable && seatId !== activeSeat;
            // The agent as it was in this round, so earlier rounds keep their names and colors.
            const seat = seatIn(round, table, reply.participantId);
            const agent = `Agent ${reply.participantId}`;
            const who = seat && seatName(seat) ? `${agent} · ${seat.modelName}` : agent;
            return (
              <ReplyView
                key={reply.id}
                kind="seat"
                reply={reply}
                name={seat ? seatDisplayName(seat) : agent}
                meta={atTable ? who : `${who} · Removed`}
                avatar={<SeatAvatar id={reply.participantId} color={seatColor(seat ?? { id: seatId ?? "A" })} />}
                highlighted={reply.id === highlightReplyId}
                expanded={expanded[reply.id]}
                onToggleExpanded={onToggleExpanded}
                onHold={onHold}
                onVote={onVote}
                onReplyPrivately={seatId && canReply ? () => onOpenPrivate(seatId) : undefined}
                privateChip={
                  seatId && privateCount > 0 ? (
                    <div className="acts">
                      <button type="button" className="chip" onClick={() => onOpenPrivate(seatId)}>
                        <Icon name="lock" size={14} />
                        Private conversation · {plural(privateCount, "message")}
                      </button>
                    </div>
                  ) : null
                }
              />
            );
          })}
          {round.arbiterReplies.map((reply, i) => {
            const arbiter = arbiterIn(round, table, reply.participantId);
            return (
              <ReplyView
                key={reply.id}
                kind="arbiter"
                waitsFor={i === 0 ? "agents" : "arbiter"}
                reply={reply}
                name={arbiter?.name ?? "Arbiter"}
                meta={arbiter ? `Arbiter · ${arbiter.modelName}` : "Arbiter"}
                avatar={<ArbiterAvatar />}
                expanded={expanded[reply.id]}
                onToggleExpanded={onToggleExpanded}
                onHold={onHold}
                onVote={onVote}
              />
            );
          })}
        </>
      )}
    </section>
  );
}

function HostMessage({ round }: { round: Round }) {
  const { text, attachments } = round.host;
  return (
    <article className="msg host">
      <HostAvatar />
      <div className="msg-main">
        <div className="msg-h">
          <span className="msg-n">You</span>
          {round.number > 1 ? <span className="msg-m">Note for round {round.number}</span> : null}
        </div>
        {text ? (
          <div className="msg-text host-text">{text}</div>
        ) : (
          <p className="msg-quiet">No note.</p>
        )}
        <Thumbs attachments={attachments} />
      </div>
    </article>
  );
}

// ---------- a reply ----------

function ReplyView({
  kind,
  waitsFor = "agents",
  reply,
  name,
  meta,
  avatar,
  highlighted,
  expanded: choice,
  onToggleExpanded,
  onHold,
  onVote,
  onReplyPrivately,
  privateChip,
}: {
  kind: "seat" | "arbiter";
  waitsFor?: "agents" | "arbiter"; // what a queued arbiter is waiting for
  reply: Reply;
  name: string;
  meta: string;
  avatar: React.ReactNode;
  highlighted?: boolean;
  expanded?: boolean; // the host's choice, if they pressed expand or collapse
  onToggleExpanded: (id: string, next: boolean) => void;
  onHold: () => void;
  onVote: (replyId: string, delta: number) => void;
  onReplyPrivately?: () => void;
  privateChip?: React.ReactNode;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const clampRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [overflows, setOverflows] = useState(false);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Agent replies are capped until the host expands them. An arbiter sums
  // up the round, so its reply shows in full.
  const expanded = choice ?? kind === "arbiter";

  // Whether the text is taller than the cap. A ResizeObserver reports the
  // first size as soon as it starts, again as the text streams in, and when
  // the cap itself changes size.
  useEffect(() => {
    const inner = innerRef.current;
    const clamp = clampRef.current;
    if (!inner || !clamp) return;
    const observer = new ResizeObserver(() => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setOverflows(inner.offsetHeight > CAP_REM * rem + 1);
    });
    observer.observe(inner);
    observer.observe(clamp);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  function toggle() {
    onHold();
    // Collapsing a reply whose top is scrolled past brings its header back into view.
    const article = articleRef.current;
    const scroller = article?.closest(".thread-scroll");
    if (expanded && article && scroller) {
      const offset = article.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
      if (offset < 0) scroller.scrollTop += offset;
    }
    onToggleExpanded(reply.id, !expanded);
  }

  async function copyText() {
    const ok = await copyToClipboard(reply.text);
    setCopy(ok ? "done" : "failed");
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopy("idle"), 1600);
  }

  const capped = !expanded;
  const canExpand = overflows || expanded;
  const canCopy = Boolean(reply.text) && reply.status !== "streaming";
  const stats = reply.status === "done" || reply.status === "error" ? replyStats(reply.durationMs, reply.usage) : "";
  const usageTitle =
    [
      reply.usage?.inputTokens !== undefined && `${reply.usage.inputTokens.toLocaleString("en-US")} input tokens`,
      reply.usage?.outputTokens !== undefined && `${reply.usage.outputTokens.toLocaleString("en-US")} output tokens`,
    ]
      .filter(Boolean)
      .join(", ") || undefined;

  return (
    <article
      ref={articleRef}
      className={cx("msg reply", kind === "arbiter" && "arbiter", highlighted && "hl")}
      aria-busy={reply.status === "streaming" || undefined}
    >
      {avatar}
      <div className="msg-main">
        <div className="msg-h">
          <span className="msg-n">{name}</span>
          <span className="msg-m">{meta}</span>
          <ReplyState status={reply.status} kind={kind} waitsFor={waitsFor} />
        </div>
        <ToolChips tools={reply.tools} />
        <div
          ref={clampRef}
          id={bodyId}
          className={cx("clamp", capped && overflows && "faded")}
          style={capped ? { maxHeight: `${CAP_REM}rem` } : undefined}
        >
          <div ref={innerRef}>{reply.text ? <Markdown text={reply.text} className="msg-text" /> : null}</div>
        </div>
        {reply.status === "error" ? <ReplyError error={reply.error} hasText={Boolean(reply.text)} kind={kind} /> : null}
        {reply.finishReason === "length" && reply.status === "done" ? (
          <p className="msg-quiet">The reply reached the length limit and was cut off.</p>
        ) : null}
        {reply.finishReason === "max-turns" && reply.status === "done" ? (
          <p className="msg-quiet">The reply stopped at the limit on tool calls.</p>
        ) : null}
        {privateChip}
        <div className={cx("tbar", (choice === true || copy !== "idle") && "keep")}>
          {canExpand ? (
            <button
              type="button"
              className="ibtn sm"
              aria-expanded={expanded}
              aria-controls={bodyId}
              aria-label={expanded ? "Collapse" : "Expand"}
              title={expanded ? "Collapse" : "Expand"}
              onClick={toggle}
            >
              <Icon name={expanded ? "chevronUp" : "chevronDown"} />
            </button>
          ) : null}
          {canCopy ? (
            <button
              type="button"
              className="ibtn sm"
              aria-label="Copy"
              title={copy === "done" ? "Copied" : copy === "failed" ? "Could not copy. Select the text and copy it instead." : "Copy"}
              onClick={() => void copyText()}
            >
              <Icon name={copy === "done" ? "check" : copy === "failed" ? "alert" : "copy"} />
            </button>
          ) : null}
          {onReplyPrivately ? (
            <button
              type="button"
              className="ibtn sm"
              aria-label="Reply privately"
              title="Reply privately"
              onClick={onReplyPrivately}
            >
              <Icon name="message" />
            </button>
          ) : null}
          <span className="tbar-space" />
          {stats ? (
            <span className="tbar-stats mono" title={usageTitle}>
              {stats}
            </span>
          ) : null}
          {reply.status === "done" || reply.status === "error" ? (
            <Votes votes={reply.votes ?? 0} onVote={(delta) => onVote(reply.id, delta)} />
          ) : null}
          <span className="sr-only" role="status">
            {copy === "done" ? "Copied" : copy === "failed" ? "Could not copy" : ""}
          </span>
        </div>
      </div>
    </article>
  );
}

// Up and down buttons with the net score between them. The host can press
// either as often as they like. The score keeps its width when it is empty.
function Votes({ votes, onVote }: { votes: number; onVote: (delta: number) => void }) {
  const score = votes > 0 ? `+${votes}` : votes < 0 ? `\u2212${-votes}` : "";
  return (
    <span className={cx("votes", votes !== 0 && "has")} role="group" aria-label="Votes">
      <button
        type="button"
        className={cx("ibtn sm", votes > 0 && "on")}
        aria-label="Vote up"
        title="Vote up"
        onClick={() => onVote(1)}
      >
        <Icon name="arrowUp" size={14} />
      </button>
      <span className="votes-n mono">{score}</span>
      <button
        type="button"
        className={cx("ibtn sm", votes < 0 && "on")}
        aria-label="Vote down"
        title="Vote down"
        onClick={() => onVote(-1)}
      >
        <Icon name="arrowDown" size={14} />
      </button>
    </span>
  );
}

function ReplyState({
  status,
  kind,
  waitsFor,
}: {
  status: Reply["status"];
  kind: "seat" | "arbiter";
  waitsFor: "agents" | "arbiter";
}) {
  if (status === "queued") {
    const label = kind === "seat" ? "Waiting" : waitsFor === "agents" ? "Waits for the agents" : "Waits for its turn";
    return <span className="msg-state">{label}</span>;
  }
  if (status === "streaming") {
    return (
      <span className="msg-state live">
        <span className="pulse" aria-hidden="true" />
        Writing
      </span>
    );
  }
  return null;
}

export function ReplyError({ error, hasText, kind }: { error?: string; hasText: boolean; kind: "seat" | "arbiter" }) {
  if (error === STOPPED) {
    return (
      <p className="msg-err stopped">
        <Icon name="stop" size={14} />
        {hasText ? "Stopped before the reply was finished." : "Stopped before it started."}
      </p>
    );
  }
  const who = kind === "seat" ? "This agent" : "This arbiter";
  return (
    <p className="msg-err">
      <Icon name="alert" size={14} />
      <span>{error ? `${who} could not answer. ${error}` : `${who} could not answer.`}</span>
    </p>
  );
}
