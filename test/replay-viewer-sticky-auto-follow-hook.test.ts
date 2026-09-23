import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { useStickyAutoFollow } from "../examples/flows/replay-viewer/src/hooks/use-sticky-auto-follow.js";

type Options = Parameters<typeof useStickyAutoFollow>[0];
type FollowState = ReturnType<typeof useStickyAutoFollow>;
type Controls = Pick<Options, "enabled" | "resetKey" | "contentDependency">;
type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};
type Harness = {
  container: ScrollMetrics;
  current: () => FollowState;
  scrollCalls: () => number;
  listenerCount: (type: string) => number;
  render: (patch: Partial<Controls>) => Promise<void>;
  content: (scrollHeight: number) => Promise<void>;
  userScroll: (scrollTop: number) => Promise<void>;
  wheel: (deltaY: number) => Promise<void>;
  scrollEvent: () => Promise<void>;
  flushScrolls: () => Promise<void>;
};
type Setup = {
  enabled?: boolean;
  scrollHeight?: number;
  missingContainer?: boolean;
  missingEnd?: boolean;
};

test("a detached conversation follows a different session with unchanged content identity", async () => {
  await withStickyFollow(async (harness) => {
    await harness.wheel(-200);
    await harness.userScroll(300);
    assert.equal(harness.current().pinnedToBottom, false);

    await harness.render({ resetKey: "session-b" });
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 600);
    assert.equal(harness.current().pinnedToBottom, true);
    assert.equal(harness.listenerCount("scroll"), 1);
    assert.equal(harness.listenerCount("wheel"), 1);

    await harness.content(1_100);
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 700);
    assert.equal(harness.current().pinnedToBottom, true);
  });
});

test("re-enabling a detached conversation restores follow after disabled updates", async () => {
  await withStickyFollow(async (harness) => {
    await harness.wheel(-200);
    await harness.userScroll(300);
    await harness.render({ enabled: false });
    const before = harness.scrollCalls();
    await harness.content(1_100);
    assert.equal(harness.scrollCalls(), before);
    assert.equal(harness.container.scrollTop, 300);
    assert.equal(harness.listenerCount("scroll"), 0);
    assert.equal(harness.listenerCount("wheel"), 0);

    await harness.render({ enabled: true });
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 700);
    assert.equal(harness.current().pinnedToBottom, true);
  });
});

test("a no-op follow cannot swallow an upward non-wheel scroll within the bottom threshold", async () => {
  await withStickyFollow(async (harness) => {
    await harness.content(1_000);
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 600);

    await harness.userScroll(560);
    assert.equal(harness.current().pinnedToBottom, false);
    await harness.content(1_100);
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 560);
    assert.equal(harness.current().pinnedToBottom, false);
  });
});

test("ordinary upward non-wheel scrolling stays detached during content growth", async () => {
  await withStickyFollow(async (harness) => {
    await harness.userScroll(560);
    assert.equal(harness.current().pinnedToBottom, false);
    await harness.content(1_100);
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 560);
    assert.equal(harness.current().pinnedToBottom, false);
  });
});

test("a delayed programmatic event cannot clear a later user detachment", async () => {
  await withStickyFollow(async (harness) => {
    await harness.content(1_100);
    assert.equal(harness.container.scrollTop, 700);
    await harness.userScroll(660);
    assert.equal(harness.current().pinnedToBottom, false);
    await harness.flushScrolls();
    assert.equal(harness.current().pinnedToBottom, false);

    await harness.content(1_200);
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 660);
    assert.equal(harness.current().pinnedToBottom, false);
  });
});

test("an already pinned session reset follows independently of content identity", async () => {
  await withStickyFollow(async (harness) => {
    harness.container.scrollHeight = 1_100;
    await harness.render({ resetKey: "session-b" });
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 700);
    assert.equal(harness.current().pinnedToBottom, true);
  });
});

test("wheel intent stays detached until actual downward movement reaches the bottom threshold", async () => {
  await withStickyFollow(async (harness) => {
    await harness.content(1_000);
    await harness.wheel(-3);
    assert.equal(harness.current().pinnedToBottom, false);
    await harness.scrollEvent();
    assert.equal(harness.current().pinnedToBottom, false);
    await harness.content(1_100);
    assert.equal(harness.container.scrollTop, 600);
    assert.equal(harness.current().pinnedToBottom, false);

    await harness.userScroll(400);
    await harness.userScroll(640);
    assert.equal(harness.current().pinnedToBottom, false);
    await harness.scrollEvent();
    assert.equal(harness.current().pinnedToBottom, false);
    await harness.userScroll(660);
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 700);
    assert.equal(harness.current().pinnedToBottom, true);

    await harness.content(1_200);
    await harness.flushScrolls();
    assert.equal(harness.container.scrollTop, 800);
    assert.equal(harness.current().pinnedToBottom, true);
  });
});

test("disabled mounting and updates leave the pane alone until follow is enabled", async () => {
  await withStickyFollow(
    async (harness) => {
      assert.equal(harness.scrollCalls(), 0);
      assert.equal(harness.listenerCount("scroll"), 0);
      await harness.content(1_100);
      await harness.render({ resetKey: "session-b" });
      await harness.userScroll(300);
      assert.equal(harness.scrollCalls(), 0);
      assert.equal(harness.container.scrollTop, 300);

      await harness.render({ enabled: true });
      await harness.flushScrolls();
      assert.equal(harness.container.scrollTop, 700);
      assert.equal(harness.current().pinnedToBottom, true);
      assert.equal(harness.listenerCount("scroll"), 1);
      assert.equal(harness.listenerCount("wheel"), 1);
    },
    { enabled: false },
  );
});

test("an absent scroll container has no scroll work or listeners", async () => {
  await withStickyFollow(
    async (harness) => {
      await harness.content(1_100);
      await harness.render({ resetKey: "session-b" });
      await harness.flushScrolls();
      assert.equal(harness.scrollCalls(), 0);
      assert.equal(harness.listenerCount("scroll"), 0);
      assert.equal(harness.listenerCount("wheel"), 0);
    },
    { missingContainer: true },
  );
});

test("an absent end marker does not scroll a short conversation", async () => {
  await withStickyFollow(
    async (harness) => {
      await harness.content(300);
      await harness.render({ resetKey: "session-b" });
      await harness.flushScrolls();
      assert.equal(harness.scrollCalls(), 0);
      assert.equal(harness.container.scrollTop, 0);
      assert.equal(harness.current().pinnedToBottom, true);
    },
    { scrollHeight: 200, missingEnd: true },
  );
});

async function withStickyFollow(
  run: (harness: Harness) => Promise<void>,
  setup: Setup = {},
): Promise<void> {
  const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let scrollCalls = 0;
  let scrollPending = false;
  const container = {
    scrollTop: 0,
    scrollHeight: setup.scrollHeight ?? 1_000,
    clientHeight: 400,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const handlers = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      handlers.add(listener);
      listeners.set(type, handlers);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener);
    },
  };
  const endMarker = {
    scrollIntoView() {
      scrollCalls += 1;
      const target = Math.max(0, container.scrollHeight - container.clientHeight);
      if (container.scrollTop !== target) {
        container.scrollTop = target;
        scrollPending = true;
      }
    },
  };
  let options: Options = {
    scrollContainerRef: { current: setup.missingContainer ? null : (container as HTMLElement) },
    endRef: { current: setup.missingEnd ? null : (endMarker as HTMLElement) },
    enabled: setup.enabled ?? true,
    resetKey: "session-a",
    contentDependency: {},
  };
  let current: FollowState | undefined;
  let renderer: ReturnType<typeof create> | undefined;
  function Component(props: Options) {
    current = useStickyAutoFollow(props);
    return createElement("div");
  }
  function read(): FollowState {
    assert.ok(current);
    return current;
  }
  function dispatch(type: string, event = new Event(type)): void {
    const pendingListeners = [...(listeners.get(type) ?? [])];
    for (const listener of pendingListeners) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
  async function render(patch: Partial<Controls>): Promise<void> {
    options = { ...options, ...patch };
    await act(async () => {
      assert.ok(renderer);
      renderer.update(createElement(Component, options));
    });
  }
  async function flushScrolls(): Promise<void> {
    await act(async () => {
      if (scrollPending) {
        scrollPending = false;
        dispatch("scroll");
      }
    });
  }
  try {
    await act(async () => {
      renderer = create(createElement(Component, options));
    });
    await flushScrolls();
    await run({
      container,
      current: read,
      scrollCalls: () => scrollCalls,
      listenerCount: (type) => listeners.get(type)?.size ?? 0,
      render,
      async content(scrollHeight) {
        container.scrollHeight = scrollHeight;
        await render({ contentDependency: {} });
      },
      async userScroll(scrollTop) {
        await act(async () => {
          container.scrollTop = scrollTop;
          dispatch("scroll");
        });
      },
      async wheel(deltaY) {
        await act(async () => {
          dispatch("wheel", Object.assign(new Event("wheel"), { deltaY }));
        });
      },
      async scrollEvent() {
        await act(async () => dispatch("scroll"));
      },
      flushScrolls,
    });
  } finally {
    try {
      await act(async () => renderer?.unmount());
      assert.equal(listeners.get("scroll")?.size ?? 0, 0);
      assert.equal(listeners.get("wheel")?.size ?? 0, 0);
    } finally {
      if (previousActEnvironment === undefined) {
        delete globals.IS_REACT_ACT_ENVIRONMENT;
      } else {
        globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  }
}
