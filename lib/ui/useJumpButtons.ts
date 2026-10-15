"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { scrollBehavior, type StickToBottom } from "./useStickToBottom";

// How close the mouse must come to the top or bottom edge of the thread for
// that edge's button to show.
const BAND = 112;
// How long the buttons stay after a touch scroll, with no hover to keep them.
const TOUCH_MS = 1500;

type View = { round: number | null; away: boolean };

// Decides when the thread's two jump buttons show. The top one names the round
// whose section spans the top edge of the view, once the view has scrolled
// past that round's start. The bottom one shows when the view is away from
// the bottom, and always while new content waits below.
// A button shows while the mouse is near its edge, or for a short time after a
// touch scroll.
export function useJumpButtons({ scrollRef, contentRef, hasNew, jump, release }: StickToBottom) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ round: null, away: false });
  const [near, setNear] = useState({ top: false, bottom: false });
  const [touched, setTouched] = useState(false);

  // Where the view is: the round at its top edge and whether it is away from
  // the bottom, measured at most once a frame.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let frame = 0;

    const measure = () => {
      frame = 0;
      const edge = el.getBoundingClientRect().top;
      let top: HTMLElement | null = null;
      for (const section of content.querySelectorAll<HTMLElement>("section.round[data-round]")) {
        if (section.getBoundingClientRect().top > edge + 0.5) break;
        top = section;
      }
      const round = top && edge - top.getBoundingClientRect().top > 8 ? Number(top.dataset.round) : null;
      const away = el.scrollHeight - el.scrollTop - el.clientHeight > 8;
      setView((v) => (v.round === round && v.away === away ? v : { round, away }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    observer.observe(el);
    el.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      el.removeEventListener("scroll", schedule);
    };
  }, [scrollRef, contentRef]);

  // Whether the mouse is near either edge, and the short reveal after a touch
  // scroll. Only a scroll that follows a touch counts, so a streaming reply
  // that keeps the view at the bottom does not keep the buttons up.
  useEffect(() => {
    const wrap = wrapRef.current;
    const el = scrollRef.current;
    if (!wrap || !el) return;
    let nearTop = false;
    let nearBottom = false;
    let shown = false;
    let lastTouch = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const setFlags = (top: boolean, bottom: boolean) => {
      if (top === nearTop && bottom === nearBottom) return;
      nearTop = top;
      nearBottom = bottom;
      setNear({ top, bottom });
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      const r = wrap.getBoundingClientRect();
      setFlags(e.clientY - r.top <= BAND, r.bottom - e.clientY <= BAND);
    };
    const onLeave = () => setFlags(false, false);
    const onTouch = () => {
      lastTouch = performance.now();
    };
    const onScroll = () => {
      if (performance.now() - lastTouch > TOUCH_MS) return;
      if (!shown) {
        shown = true;
        setTouched(true);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        shown = false;
        setTouched(false);
      }, TOUCH_MS);
    };

    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    wrap.addEventListener("touchstart", onTouch, { passive: true });
    wrap.addEventListener("touchmove", onTouch, { passive: true });
    wrap.addEventListener("touchend", onTouch, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      wrap.removeEventListener("touchstart", onTouch);
      wrap.removeEventListener("touchmove", onTouch);
      wrap.removeEventListener("touchend", onTouch);
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef]);

  // Scrolls so the round's section starts at the top edge. The view lets go
  // of the bottom first, so a streaming reply does not pull it back down.
  const toRound = useCallback(
    (round: number) => {
      const el = scrollRef.current;
      const section = contentRef.current?.querySelector<HTMLElement>(`section.round[data-round="${round}"]`);
      if (!el || !section) return;
      release();
      const top = el.scrollTop + section.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTo({ top, behavior: scrollBehavior() });
    },
    [scrollRef, contentRef, release],
  );

  return {
    wrapRef,
    topRound: view.round !== null && (near.top || touched) ? view.round : null,
    showLatest: hasNew || (view.away && (near.bottom || touched)),
    toRound,
    toLatest: jump,
  };
}
