import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

export function isPinnedToBottom(
  element: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
  thresholdPx = 48,
): boolean {
  return element.scrollHeight - (element.scrollTop + element.clientHeight) <= thresholdPx;
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

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setPinned(true);
  }, [enabled, resetKey]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const endMarker = endRef.current;
    if (!enabled || !scrollContainer || !endMarker) {
      return;
    }

    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          setPinned(entries[0]?.isIntersecting ?? false);
        },
        {
          root: scrollContainer,
          threshold: 0,
          rootMargin: "0px 0px 48px 0px",
        },
      );
      observer.observe(endMarker);
      return () => observer.disconnect();
    }

    const updatePinned = () => {
      setPinned(isPinnedToBottom(scrollContainer));
    };
    updatePinned();
    scrollContainer.addEventListener("scroll", updatePinned, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", updatePinned);
  }, [enabled, resetKey, scrollContainerRef, endRef]);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!enabled || !pinned || !scrollContainer) {
      return;
    }
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" });
  }, [enabled, pinned, contentDependency, scrollContainerRef]);

  return { pinnedToBottom: pinned };
}
