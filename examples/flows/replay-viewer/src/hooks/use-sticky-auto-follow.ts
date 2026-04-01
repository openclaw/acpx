import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export function isPinnedToBottom(
  element: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
  thresholdPx = 48,
): boolean {
  return element.scrollHeight - (element.scrollTop + element.clientHeight) <= thresholdPx;
}

export function didUserScrollUp(previousScrollTop: number, nextScrollTop: number): boolean {
  return nextScrollTop < previousScrollTop - 2;
}

export function useStickyAutoFollow(options: {
  scrollContainerRef: RefObject<HTMLElement | null>;
  endRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  resetKey: string;
  contentDependency: unknown;
}) {
  const { scrollContainerRef, endRef, enabled, resetKey, contentDependency } = options;
  const [pinned, setPinned] = useState(true);
  const lastScrollTopRef = useRef(0);
  const autoScrollingRef = useRef(false);
  const detachedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    setPinned(true);
    detachedRef.current = false;
    lastScrollTopRef.current = scrollContainer?.scrollTop ?? 0;
  }, [enabled, resetKey]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!enabled || !scrollContainer) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < -1) {
        autoScrollingRef.current = false;
        detachedRef.current = true;
        setPinned(false);
      }
    };

    const updatePinned = () => {
      const previousScrollTop = lastScrollTopRef.current;
      const nextScrollTop = scrollContainer.scrollTop;
      const atBottom = isPinnedToBottom(scrollContainer);

      if (autoScrollingRef.current) {
        autoScrollingRef.current = false;
        lastScrollTopRef.current = nextScrollTop;
        detachedRef.current = false;
        setPinned(atBottom);
        return;
      }

      if (didUserScrollUp(previousScrollTop, nextScrollTop)) {
        lastScrollTopRef.current = nextScrollTop;
        detachedRef.current = true;
        setPinned(false);
        return;
      }

      lastScrollTopRef.current = nextScrollTop;

      if (detachedRef.current) {
        if (atBottom && nextScrollTop > previousScrollTop + 2) {
          detachedRef.current = false;
          setPinned(true);
          return;
        }
        setPinned(false);
        return;
      }

      setPinned(atBottom);
    };

    updatePinned();
    scrollContainer.addEventListener("wheel", handleWheel, { passive: true });
    scrollContainer.addEventListener("scroll", updatePinned, { passive: true });
    return () => {
      scrollContainer.removeEventListener("wheel", handleWheel);
      scrollContainer.removeEventListener("scroll", updatePinned);
    };
  }, [enabled, resetKey, scrollContainerRef]);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const endMarker = endRef.current;
    if (!enabled || !pinned || !scrollContainer || !endMarker) {
      return;
    }
    autoScrollingRef.current = true;
    endMarker.scrollIntoView({ block: "end" });
    lastScrollTopRef.current = scrollContainer.scrollTop;
  }, [enabled, pinned, contentDependency, scrollContainerRef, endRef]);

  return { pinnedToBottom: pinned };
}
