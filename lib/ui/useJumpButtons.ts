"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { scrollBehavior, type StickToBottom } from "./useStickToBottom";

// How close the mouse must come to the top edge of the thread for the round
// button to show.
const BAND = 112;
// How long the buttons stay after a touch scroll, with no hover to keep them.
const TOUCH_MS = 1500;

type View = { round: number | null; away: boolean };

// Decides when the thread's two jump buttons show. The top one names the round
// whose section spans the top edge of the view, once the view has scrolled
// past that round's start, and shows while the mouse is near the top edge or
// for a short time after a touch scroll. The bottom one shows whenever the
// view is away from the bottom.
export function useJumpButtons({ scrollRef, contentRef, hasNew, jump, release }: StickToBottom) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ round: null, away: false });
  const [nearTop, setNearTop] = useState(false);
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

  // Whether the mouse is near the top edge, and the short reveal after a touch
  // scroll. Only a scroll that follows a touch counts, so a streaming reply
  // that keeps the view at the bottom does not keep the buttons up.
  useEffect(() => {
    const wrap = wrapRef.current;
    const el = scrollRef.current;
    if (!wrap || !el) return;
    let near = false;
    let shown = false;
    let lastTouch = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const setNear = (next: boolean) => {
      if (next === near) return;
      near = next;
      setNearTop(next);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      setNear(e.clientY - wrap.getBoundingClientRect().top <= BAND);
    };
    const onLeave = () => setNear(false);
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
    topRound: view.round !== null && (nearTop || touched) ? view.round : null,
    showLatest: hasNew || view.away,
    toRound,
    toLatest: jump,
  };
}
