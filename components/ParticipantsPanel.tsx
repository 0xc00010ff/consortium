"use client";

import { confirm } from "@/lib/ui/confirm";

import { useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, useMemo } from "react";
import {
  MAKER_LABELS,
  SEAT_COLORS,
  type Arbiter,
  type Maker,
  type ModelInfo,
  type ModelsResponse,
  type Seat,
  type SeatColor,
  type SeatId,
  type Table,
  type TableEdit,
} from "@/lib/types";
import {
  COLOR_LABELS,
  freshSeatLetter,
  MAX_SEATS,
  MODE_LABELS,
  modeEdit,
  modeOf,
  moveItem,
  newArbiter,
  newSeat,
  seatColor,
  seatName,
  withModel,
} from "@/lib/ui/view";
import { applyPreset, builtinPresets, deletePreset, savePreset, usePresets } from "@/lib/ui/presets";
import { Icon } from "./Icon";
import { ArbiterAvatar, cx, IconButton, Menu, SeatAvatar, Switch, Toggle } from "./ui";

// Command line tools on the host's own subscriptions have ids like "cli/codex".
const isTool = (m: ModelInfo) => m.id.startsWith("cli/");

// Turns only matter when agents read each other, so the two settings are one
// three-way choice.
const MODE_OPTIONS = [
  { value: "independent" as const, label: MODE_LABELS.independent, title: "Each agent reads only your messages" },
  { value: "parallel" as const, label: MODE_LABELS.parallel, title: "Agents read each other and answer at the same time" },
  {
    value: "roundRobin" as const,
    label: MODE_LABELS.roundRobin,
    title: "Agents read each other and answer one after another, in list order",
  },
];

export function ParticipantsPanel({
  table,
  data,
  disabled,
  onEdit,
  onClose,
}: {
  table: Table;
  data: ModelsResponse | null;
  disabled: boolean;
  onEdit: (edit: TableEdit) => void;
  onClose: () => void;
}) {
  const models = data?.models ?? [];
  const systemId = useId();
  const { listRef, sorting, rowClass, dragHandle, announcement } = useAgentOrder(table.seats, disabled, (seats) => onEdit({ seats }));
  // Agents whose prompt field is open.
  const [promptOpen, setPromptOpen] = useState<Partial<Record<SeatId, boolean>>>({});
  const canAddSeat = table.seats.length < MAX_SEATS && freshSeatLetter(table) !== null;
  const seatLimit =
    table.seats.length >= MAX_SEATS ? "A table can have up to eight agents." : "All eight agent letters are in use at this table.";
  const status = disabled
    ? "You can change the participants when the table finishes replying."
    : table.rounds.length > 0
      ? "Changes apply from the next round."
      : null;

  function setSeat(id: Seat["id"], next: Seat) {
    onEdit({ seats: table.seats.map((s) => (s.id === id ? next : s)) });
  }

  async function removeSeat(seat: Seat) {
    if (table.privateThreads[seat.id]?.length) {
      const ok = await confirm({
        message: `Remove Agent ${seat.id}? Its private conversation will be deleted. Its replies stay in the thread.`,
        action: "Remove",
      });
      if (!ok) return;
    }
    onEdit({ seats: table.seats.filter((s) => s.id !== seat.id) });
  }

  async function removeArbiter(arbiter: Arbiter) {
    if (table.privateThreads[arbiter.id]?.length) {
      const ok = await confirm({
        message: `Remove ${arbiter.name || "this arbiter"}? Its private conversation will be deleted. Its replies stay in the thread.`,
        action: "Remove",
      });
      if (!ok) return;
    }
    onEdit({ arbiters: table.arbiters.filter((a) => a.id !== arbiter.id) });
  }

  function setArbiter(id: string, next: Arbiter) {
    onEdit({ arbiters: table.arbiters.map((a) => (a.id === id ? next : a)) });
  }

  return (
    <aside className="panel" aria-label="Participants">
      <div className="panel-head">
        <h2>Participants</h2>
        <IconButton icon="x" label="Close participants" onClick={onClose} />
      </div>
      <div className="panel-body">
        {status ? <p className="panel-status">{status}</p> : null}

        <section className="psec">
          <h3 className="lbl">Interaction</h3>
          <Toggle
            options={MODE_OPTIONS}
            value={modeOf(table)}
            onChange={(mode) => onEdit(modeEdit(mode))}
            label="Interaction"
            disabled={disabled}
          />
        </section>

        <section className="psec">
          <h3 className="lbl" id={systemId}>
            System prompt
          </h3>
          <textarea
            className="input"
            rows={3}
            value={table.instructions ?? ""}
            aria-labelledby={systemId}
            placeholder="Instructions every agent reads, for example: answer in one paragraph."
            disabled={disabled}
            onChange={(e) => onEdit({ instructions: e.target.value })}
          />
        </section>

        <section className="psec">
          <div className="lbl-row">
            <h3 className="lbl">Agents</h3>
            <Presets table={table} data={data} disabled={disabled} onEdit={onEdit} />
          </div>
          <ul className={cx("prows", sorting && "sorting")} ref={listRef}>
            {table.seats.map((seat) => {
              const on = seat.active !== false;
              return (
                <li key={seat.id} data-seat={seat.id} className={cx("agent", !on && "off", rowClass(seat.id))}>
                  <div className="prow">
                    <button
                      type="button"
                      className="grip"
                      data-grip={seat.id}
                      aria-label={`Move Agent ${seat.id}`}
                      title="Drag to reorder"
                      disabled={disabled || table.seats.length <= 1}
                      {...dragHandle(seat.id)}
                    >
                      <Icon name="grip" />
                    </button>
                    <ColorButton seat={seat} disabled={disabled} onChange={(color) => setSeat(seat.id, { ...seat, color })} />
                    <NameField seat={seat} disabled={disabled} onChange={(name) => setSeat(seat.id, { ...seat, name })} />
                    <WebToggle
                      on={seat.browsing}
                      onChange={(browsing) => setSeat(seat.id, { ...seat, browsing })}
                      who={`Agent ${seat.id}`}
                      disabled={disabled}
                    />
                    <Switch
                      checked={on}
                      onChange={(active) => setSeat(seat.id, { ...seat, active })}
                      label={`Agent ${seat.id} on`}
                      title={on ? "On" : "Off"}
                      disabled={disabled}
                    />
                    <IconButton
                      icon="x"
                      label={`Remove Agent ${seat.id}`}
                      onClick={() => removeSeat(seat)}
                      disabled={disabled || table.seats.length <= 1}
                    />
                  </div>
                  <div className={cx("prow agent-model", seat.modelId.startsWith("cli/") && "two")}>
                    <ModelSelect
                      label={`Model for Agent ${seat.id}`}
                      value={seat.modelId}
                      currentName={seat.modelName}
                      models={models}
                      disabled={disabled}
                      onChange={(id) => setSeat(seat.id, withModel(seat, models, id))}
                    />
                    <ToolModelSelect
                      participant={seat}
                      who={`Agent ${seat.id}`}
                      models={models}
                      disabled={disabled}
                      onChange={(toolModel) => setSeat(seat.id, { ...seat, toolModel })}
                    />
                  </div>
                  <SeatPrompt
                    seat={seat}
                    open={Boolean(promptOpen[seat.id])}
                    disabled={disabled}
                    onOpen={(open) => setPromptOpen((o) => ({ ...o, [seat.id]: open }))}
                    onChange={(instructions) => setSeat(seat.id, { ...seat, instructions })}
                  />
                </li>
              );
            })}
          </ul>
          <span className="sr-only" role="status">
            {announcement}
          </span>
          <button
            type="button"
            className="btn ghost add"
            disabled={disabled || !data || !canAddSeat}
            title={canAddSeat ? undefined : seatLimit}
            onClick={() => {
              const seat = data && newSeat(table, data);
              if (seat) onEdit({ seats: [...table.seats, seat] });
            }}
          >
            <Icon name="plus" />
            Add agent
          </button>
        </section>

        <section className="psec">
          <h3 className="lbl">Arbiters</h3>
          {table.arbiters.length === 0 ? null : (
            <ul className="prows">
              {table.arbiters.map((arbiter, i) => (
                <li key={arbiter.id} className="arb">
                  <div className="prow">
                    <ArbiterAvatar />
                    <input
                      className="input"
                      value={arbiter.name}
                      aria-label={`Name of arbiter ${i + 1}`}
                      disabled={disabled}
                      onChange={(e) => setArbiter(arbiter.id, { ...arbiter, name: e.target.value })}
                      onBlur={(e) => {
                        if (!e.target.value.trim()) {
                          setArbiter(arbiter.id, { ...arbiter, name: `Arbiter ${arbiter.id.replace(/\D+/g, "") || i + 1}` });
                        }
                      }}
                    />
                    <IconButton
                      icon="x"
                      label={`Remove ${arbiter.name || "this arbiter"}`}
                      onClick={() => removeArbiter(arbiter)}
                      disabled={disabled}
                    />
                  </div>
                  <div className="prow arb-model">
                    <ModelSelect
                      label={`Model for ${arbiter.name || "this arbiter"}`}
                      value={arbiter.modelId}
                      currentName={arbiter.modelName}
                      models={models}
                      disabled={disabled}
                      onChange={(id) => setArbiter(arbiter.id, withModel(arbiter, models, id))}
                    />
                    <WebToggle
                      on={arbiter.browsing}
                      onChange={(browsing) => setArbiter(arbiter.id, { ...arbiter, browsing })}
                      who={arbiter.name || "this arbiter"}
                      disabled={disabled}
                    />
                  </div>
                  <ToolModelSelect
                    participant={arbiter}
                    who={arbiter.name || "this arbiter"}
                    models={models}
                    disabled={disabled}
                    onChange={(toolModel) => setArbiter(arbiter.id, { ...arbiter, toolModel })}
                  />
                  <textarea
                    className="input"
                    rows={3}
                    value={arbiter.instructions}
                    aria-label={`Instructions for ${arbiter.name || "this arbiter"}`}
                    placeholder="What should this arbiter do? For example: keep a numbered list of the ideas raised and who supports each one."
                    disabled={disabled}
                    onChange={(e) => setArbiter(arbiter.id, { ...arbiter, instructions: e.target.value })}
                  />
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn ghost add"
            disabled={disabled || !data}
            onClick={() => {
              const arbiter = data && newArbiter(table, data);
              if (arbiter) onEdit({ arbiters: [...table.arbiters, arbiter] });
            }}
          >
            <Icon name="plus" />
            Add arbiter
          </button>
        </section>
      </div>
    </aside>
  );
}

// Saved setups for this panel. Choosing one replaces the whole setup.
function Presets({
  table,
  data,
  disabled,
  onEdit,
}: {
  table: Table;
  data: ModelsResponse | null;
  disabled: boolean;
  onEdit: (edit: TableEdit) => void;
}) {
  const presets = usePresets();
  const builtin = useMemo(() => (data ? builtinPresets(data) : []), [data]);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // "Save new…" turns into a name field inside the menu. The page cannot use
  // window.prompt, which some browsers do not support.
  const [naming, setNaming] = useState(false);
  const open = anchor !== null && !disabled;

  function close(refocus: boolean) {
    if (refocus) anchor?.focus();
    setAnchor(null);
    setNaming(false);
  }

  function saveNamed(raw: string) {
    const name = raw.trim();
    if (name) savePreset(name, table);
    close(true);
  }

  return (
    <>
      <button
        type="button"
        className="lbl-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => setAnchor(open ? null : e.currentTarget)}
      >
        Presets
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <Menu anchor={anchor} label="Presets" onClose={close}>
          {builtin.map((preset) => (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              key={preset.id}
              onClick={() => {
                close(true);
                onEdit(applyPreset(preset));
              }}
            >
              {preset.name}
            </button>
          ))}
          {builtin.length && presets.length ? <div role="separator" className="menu-sep" /> : null}
          {presets.map((preset) => (
            <div className="menu-line" key={preset.id}>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close(true);
                  onEdit(applyPreset(preset));
                }}
              >
                {preset.name}
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-side=""
                className="menu-x"
                aria-label={`Delete preset ${preset.name}`}
                title="Delete preset"
                onClick={(e) => {
                  // Keep focus in the menu: on the next preset, the one before, or Save new.
                  const line = e.currentTarget.closest(".menu-line");
                  const near = line?.nextElementSibling?.matches(".menu-line")
                    ? line.nextElementSibling
                    : line?.previousElementSibling?.matches(".menu-line")
                      ? line.previousElementSibling
                      : null;
                  const target =
                    near?.querySelector<HTMLElement>('[role="menuitem"]') ??
                    line?.parentElement?.querySelector<HTMLElement>(':scope > [role="menuitem"]:last-child');
                  deletePreset(preset.id);
                  target?.focus();
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          {builtin.length || presets.length ? <div role="separator" className="menu-sep" /> : null}
          {naming ? (
            <input
              className="input menu-input"
              type="text"
              aria-label="Preset name"
              placeholder="Preset name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveNamed(e.currentTarget.value);
                } else if (e.key !== "Escape") {
                  // Arrow keys and typing stay in the field. Escape still closes the menu.
                  e.stopPropagation();
                }
              }}
            />
          ) : (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => setNaming(true)}>
              Save new…
            </button>
          )}
        </Menu>
      ) : null}
    </>
  );
}

// Reorders the agents. Dragging a row's handle draws a line where the row will
// land and reorders the list once, on drop. Escape cancels a drag. With focus
// on the handle, the up and down arrow keys move the row one step each.
function useAgentOrder(seats: Seat[], disabled: boolean, onReorder: (seats: Seat[]) => void) {
  const listRef = useRef<HTMLUListElement>(null);
  // The row being dragged and the index it would take in the list without it.
  // The ref has the latest value for the pointer handlers; the state renders it.
  const dragRef = useRef<{ id: SeatId; to: number } | null>(null);
  const [drag, setDragState] = useState<{ id: SeatId; to: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The handle to focus again after a keyboard move, since React may move the row.
  const refocus = useRef<SeatId | null>(null);

  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-grip="${id}"]`)?.focus();
  }, [seats]);

  function setDrag(next: { id: SeatId; to: number } | null) {
    dragRef.current = next;
    setDragState(next);
  }

  function move(id: SeatId, to: number) {
    const from = seats.findIndex((s) => s.id === id);
    if (from < 0 || to === from || to < 0 || to >= seats.length) return false;
    onReorder(moveItem(seats, from, to));
    setAnnouncement(`Agent ${id} moved to position ${to + 1} of ${seats.length}.`);
    return true;
  }

  // The number of other rows whose middle is above the pointer.
  function dropIndex(id: SeatId, y: number): number {
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
    return rows.filter((row) => {
      if (row.dataset.seat === id) return false;
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2 < y;
    }).length;
  }

  // A drag in progress, unless the table became busy during it.
  const active = drag && !disabled ? drag : null;
  const from = active ? seats.findIndex((s) => s.id === active.id) : -1;
  const others = active ? seats.filter((s) => s.id !== active.id) : [];
  const lineBefore = active && active.to !== from ? others[active.to]?.id : undefined;
  const lineAfter = active && active.to !== from && active.to >= others.length ? others[others.length - 1]?.id : undefined;

  function rowClass(id: SeatId) {
    return cx(active?.id === id && "dragging", lineBefore === id && "drop-before", lineAfter === id && "drop-after");
  }

  function dragHandle(id: SeatId): ButtonHTMLAttributes<HTMLButtonElement> {
    const end = () => {
      if (dragRef.current) setDrag(null);
    };
    return {
      onPointerDown(e) {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ id, to: seats.findIndex((s) => s.id === id) });
      },
      onPointerMove(e) {
        const current = dragRef.current;
        if (current?.id !== id) return;
        const to = dropIndex(id, e.clientY);
        if (to !== current.to) setDrag({ id, to });
      },
      onPointerUp() {
        const current = dragRef.current;
        if (current?.id !== id) return;
        setDrag(null);
        if (!disabled) move(id, current.to);
      },
      onPointerCancel: end,
      onLostPointerCapture: end,
      onKeyDown(e) {
        if (e.key === "Escape" && dragRef.current) {
          e.preventDefault();
          setDrag(null);
          return;
        }
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        if (dragRef.current) return;
        const i = seats.findIndex((s) => s.id === id);
        if (move(id, i + (e.key === "ArrowUp" ? -1 : 1))) refocus.current = id;
      },
    };
  }

  return { listRef, sorting: Boolean(active), rowClass, dragHandle, announcement };
}

// The agent's avatar as a button that opens a menu of the eight colors.
// Choosing the letter's own color stores no choice.
function ColorButton({ seat, disabled, onChange }: { seat: Seat; disabled: boolean; onChange: (color: SeatColor | undefined) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const open = anchor !== null && !disabled;
  const current = seatColor(seat);

  function close(refocus: boolean) {
    if (refocus) anchor?.focus();
    setAnchor(null);
  }

  return (
    <>
      <button
        type="button"
        className="av-btn"
        aria-label={`Color for Agent ${seat.id}`}
        title="Color"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => setAnchor(open ? null : e.currentTarget)}
      >
        <SeatAvatar id={seat.id} color={current} />
      </button>
      {open ? (
        <Menu anchor={anchor} label={`Color for Agent ${seat.id}`} align="start" onClose={close}>
          {SEAT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={color === current}
              tabIndex={-1}
              onClick={() => {
                close(true);
                if (color !== current) onChange(color === seatColor({ id: seat.id }) ? undefined : color);
              }}
            >
              <span className={cx("swatch", `color-${color}`)} aria-hidden="true" />
              <span className="menu-label">{COLOR_LABELS[color]}</span>
              {color === current ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </Menu>
      ) : null}
    </>
  );
}

// The host's name for an agent. It saves on blur or Enter, and Escape puts
// back the saved name. A blank name stores no name, so the model name shows.
function NameField({ seat, disabled, onChange }: { seat: Seat; disabled: boolean; onChange: (name: string | undefined) => void }) {
  // What the host has typed since the last save, or null when nothing is pending.
  const [draft, setDraft] = useState<string | null>(null);

  function save() {
    if (draft === null) return;
    setDraft(null);
    const name = draft.trim() || undefined;
    if (name !== seatName(seat)) onChange(name);
  }

  return (
    <input
      className="input"
      value={draft ?? seat.name ?? ""}
      placeholder={seat.modelName}
      aria-label={`Name of Agent ${seat.id}`}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          save();
        } else if (e.key === "Escape" && draft !== null) {
          e.preventDefault();
          setDraft(null);
        }
      }}
    />
  );
}

// The prompt for one agent. Closed, it shows "Add prompt" or the prompt's
// first line with "Show more". Open, it shows the full prompt to edit.
// Closing an empty prompt removes it.
function SeatPrompt({
  seat,
  open,
  disabled,
  onOpen,
  onChange,
}: {
  seat: Seat;
  open: boolean;
  disabled: boolean;
  onOpen: (open: boolean) => void;
  onChange: (instructions: string | undefined) => void;
}) {
  const prompt = seat.instructions ?? "";
  if (open) {
    return (
      <div className="seat-prompt open">
        <textarea
          className="input"
          rows={3}
          value={prompt}
          aria-label={`Prompt for Agent ${seat.id}`}
          disabled={disabled}
          autoFocus
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        <button
          type="button"
          className="text-btn"
          aria-label={`Show less of the prompt for Agent ${seat.id}`}
          onClick={() => {
            if (!prompt.trim() && seat.instructions !== undefined && !disabled) onChange(undefined);
            onOpen(false);
          }}
        >
          Show less
        </button>
      </div>
    );
  }
  const first = prompt.trim().split("\n")[0]?.trim();
  if (!first) {
    return (
      <div className="seat-prompt">
        <button
          type="button"
          className="text-btn"
          aria-label={`Add prompt for Agent ${seat.id}`}
          disabled={disabled}
          onClick={() => onOpen(true)}
        >
          Add prompt
        </button>
      </div>
    );
  }
  return (
    <div className="seat-prompt">
      <span className="prompt-line" title={prompt}>
        {first}
      </span>
      <button
        type="button"
        className="text-btn"
        aria-label={`Show more of the prompt for Agent ${seat.id}`}
        onClick={() => onOpen(true)}
      >
        Show more
      </button>
    </div>
  );
}

// The model a command line tool runs with, under the main select. "Default"
// stores no choice, so the tool uses its own default. A choice that is no
// longer in the list stays selectable, as in ModelSelect.
function ToolModelSelect({
  participant,
  who,
  models,
  disabled,
  onChange,
}: {
  participant: Seat | Arbiter;
  who: string;
  models: ModelInfo[];
  disabled: boolean;
  onChange: (toolModel: string | undefined) => void;
}) {
  if (!participant.modelId.startsWith("cli/")) return null;
  const info = models.find((m) => m.id === participant.modelId);
  const choices = info?.toolModels ?? [];
  const value = participant.toolModel ?? "";
  const known = !value || choices.some((c) => c.id === value);
  const label = `Model for ${info?.name ?? participant.modelName}, ${who}`;
  return (
    <span className="select tool-model">
      <select
        value={value}
        aria-label={label}
        title={label}
        disabled={disabled || choices.length === 0}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">{info?.defaultModel ? `Default (${info.defaultModel})` : "Default"}</option>
        {known ? null : <option value={value}>{value}</option>}
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={14} />
    </span>
  );
}

// A native select. The command line tools come first under "Subscriptions",
// then the gateway models grouped by maker. A model that is no longer in the
// list stays selectable so the participant keeps it until the host picks another.
function ModelSelect({
  label,
  value,
  currentName,
  models,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  currentName: string;
  models: ModelInfo[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const known = models.some((m) => m.id === value);
  const tools = models.filter(isTool);
  const groups = new Map<Maker, ModelInfo[]>();
  for (const m of models) if (!isTool(m)) groups.set(m.maker, [...(groups.get(m.maker) ?? []), m]);
  return (
    <span className="select">
      <select value={value} aria-label={label} title={label} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {known ? null : <option value={value}>{currentName}</option>}
        {tools.length ? (
          <optgroup label="Subscriptions">
            {tools.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {[...groups].map(([maker, list]) => (
          <optgroup key={maker} label={MAKER_LABELS[maker]}>
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <Icon name="chevronDown" size={14} />
    </span>
  );
}

// Web browsing as a toggle button, so the one switch in an agent row means
// on or off. The accessible name says which participant it is for.
function WebToggle({
  on,
  onChange,
  who,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  who: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      className="web"
      aria-pressed={on}
      aria-label={`Web browsing for ${who}`}
      title={on ? "Web browsing on" : "Web browsing off"}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <Icon name="globe" size={14} />
      Web
    </button>
  );
}
