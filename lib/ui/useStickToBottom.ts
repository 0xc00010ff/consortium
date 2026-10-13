"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Keeps a scroll area at the newest content while the user is at the bottom.
// Scrolling up releases it. Returning to the bottom, or calling jump(), holds it again.
// `hasNew` is true when content grew while the user was scrolled up.
// hold() marks the next size change as the user's own (expanding or collapsing
// a reply), so it neither scrolls the view nor counts as new content.
export function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  const holdUntil = useRef(0);
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    const distance = () => el.scrollHeight - el.scrollTop - el.clientHeight;

    const toBottom = () => {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    };

    const onScroll = () => {
      if (distance() <= 8) {
        pinned.current = true;
        setHasNew(false);
      } else if (el.scrollTop < lastTop.current - 1) {
        pinned.current = false;
      }
      lastTop.current = el.scrollTop;
    };

    const observer = new ResizeObserver(() => {
      const grew = el.scrollHeight > lastHeight.current + 1;
      lastHeight.current = el.scrollHeight;
      if (performance.now() < holdUntil.current) {
        pinned.current = distance() <= 8;
        lastTop.current = el.scrollTop;
        return;
      }
      if (pinned.current) toBottom();
      else if (grew && distance() > 8) setHasNew(true);
    });

    toBottom();
    lastHeight.current = el.scrollHeight;
    el.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(content);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  const jump = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    setHasNew(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const hold = useCallback(() => {
    holdUntil.current = performance.now() + 300;
  }, []);

  return { scrollRef, contentRef, hasNew, jump, hold };
}

export type StickToBottom = ReturnType<typeof useStickToBottom>;
