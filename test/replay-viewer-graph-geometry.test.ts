import assert from "node:assert/strict";
import test from "node:test";
import type { Dimensions } from "@xyflow/react";
import { buildGraphLayout } from "../examples/flows/replay-viewer/src/lib/view-model-graph.js";
import type {
  ViewerGraphLayout,
  ViewerPoint,
} from "../examples/flows/replay-viewer/src/lib/view-model-types.js";
import type { FlowDefinitionSnapshot } from "../examples/flows/replay-viewer/src/types.js";
import { validateFlowDefinition } from "../src/flows/graph.js";

const EPSILON = 1e-6;

test("ELK routes attach to measured card borders before and after a source resize", async () => {
  const flow = makeFlow(["s", "end"], [{ from: "s", to: "end" }]);
  // Rounded natural card heights from the native completed and stopped controls.
  const beforeSizes = sizesFor(flow, [106, 134]);
  const afterSizes = sizesFor(flow, [134, 134]);
  const before = await requireLayout(flow, beforeSizes);
  const after = await requireLayout(flow, afterSizes);

  assertLayoutGeometry(flow, beforeSizes, before);
  assertLayoutGeometry(flow, afterSizes, after);
  assert.notDeepEqual(after.edgeRoutes, before.edgeRoutes);
  assert.ok(after.nodePositions.end.y > before.nodePositions.end.y);
});

test("ELK routes leave a naturally tall branch card without crossing its labels", async () => {
  const source = "review_synthetic_geometry_with_a_deliberately_long_wrapping_identifier";
  const flow = makeFlow(
    [source, "accepted", "rejected"],
    [
      {
        from: source,
        switch: {
          on: "$.route",
          cases: {
            approved_after_synthetic_geometry_review: "accepted",
            rejected_after_synthetic_geometry_review: "rejected",
          },
        },
      },
    ],
  );
  // The native source measured about 219 graph units, including wrapped content.
  const sizes = sizesFor(flow, [219, 134, 106]);
  const layout = await requireLayout(flow, sizes);

  assertRoutesAvoidInteriors(sizes, layout);
  assertLayoutGeometry(flow, sizes, layout);
  const starts = Object.values(layout.edgeRoutes).map((route) => route.points[0]);
  assert.deepEqual(starts[0], starts[1], "both branches use the rendered bottom handle");
});

const geometryFixtures: Array<{
  name: string;
  ids: string[];
  edges: FlowDefinitionSnapshot["edges"];
}> = [
  {
    name: "equal-distance forward merge",
    ids: ["s", "a", "b", "end"],
    edges: [
      { from: "s", switch: { on: "$.route", cases: { long: "a", short: "b" } } },
      { from: "a", to: "b" },
      { from: "b", to: "end" },
    ],
  },
  {
    name: "decreasing-distance forward merge",
    ids: ["s", "a", "b", "c", "end"],
    edges: [
      { from: "s", switch: { on: "$.route", cases: { long: "a", short: "c" } } },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "end" },
    ],
  },
  {
    name: "reachable return",
    ids: ["s", "a", "b", "end"],
    edges: [
      { from: "s", to: "a" },
      { from: "a", to: "b" },
      { from: "b", switch: { on: "$.route", cases: { again: "a", done: "end" } } },
    ],
  },
  {
    name: "equal-depth cycle",
    ids: ["s", "a", "b", "end"],
    edges: [
      { from: "s", switch: { on: "$.route", cases: { long: "a", short: "b" } } },
      { from: "a", to: "b" },
      { from: "b", switch: { on: "$.route", cases: { again: "a", done: "end" } } },
    ],
  },
  {
    name: "reachable self-loop",
    ids: ["s", "repeat", "end"],
    edges: [
      { from: "s", to: "repeat" },
      { from: "repeat", switch: { on: "$.route", cases: { again: "repeat", done: "end" } } },
    ],
  },
  {
    name: "unused cycle and self-loop",
    ids: ["s", "a", "b", "self"],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "self", to: "self" },
    ],
  },
];

for (const fixture of geometryFixtures) {
  test(`measured ELK geometry preserves exterior routes for ${fixture.name}`, async () => {
    const flow = makeFlow(fixture.ids, fixture.edges);
    const sizes = sizesFor(flow, [106, 219, 173, 134, 159]);
    const layout = await requireLayout(flow, sizes);
    assertLayoutGeometry(flow, sizes, layout);
  });
}

for (const fixture of [
  {
    name: "odd-width",
    source: { width: 319, height: 106 },
    target: { width: 181, height: 134 },
  },
  {
    name: "fractional",
    source: { width: 318.5, height: 106.25 },
    target: { width: 180.75, height: 134.5 },
  },
]) {
  test(`ELK preserves ${fixture.name} card borders within its port-center quantization`, async () => {
    const flow = makeFlow(["s", "end"], [{ from: "s", to: "end" }]);
    const sizes = new Map([
      ["s", fixture.source],
      ["end", fixture.target],
    ]);
    const layout = await requireLayout(flow, sizes);
    // NETWORK_SIMPLEX rounds the horizontal center; border y and exterior routes stay exact.
    assertLayoutGeometry(flow, sizes, layout, 0.5 + EPSILON);
  });
}

test("ELK private IDs cannot collide with opaque public node names", async () => {
  const ids = [
    "root",
    "__proto__",
    "constructor",
    "toString",
    "node-0",
    "node-0-out",
    "edge-0",
    "s->a-0-0",
    "a::out-bottom",
  ];
  const flow = makeFlow(
    ids,
    ids.slice(0, -1).map((id, index) => ({ from: id, to: ids[index + 1] })),
  );
  const sizes = sizesFor(
    flow,
    ids.map((_, index) => 106 + index * 13),
  );
  const layout = await requireLayout(flow, sizes);

  assert.deepEqual(Object.keys(layout.nodePositions).toSorted(), ids.toSorted());
  for (const id of ids) {
    assert.ok(Object.hasOwn(layout.nodePositions, id), `${id} has its own layout entry`);
  }
  assertLayoutGeometry(flow, sizes, layout);
});

test("ELK requires complete positive finite measured dimensions", async () => {
  const flow = makeFlow(["s", "end"], [{ from: "s", to: "end" }]);
  const complete = sizesFor(flow, [106, 134]);
  for (const dimensions of [
    undefined,
    { width: 264, height: 0 },
    { width: -1, height: 106 },
    { width: 264, height: Number.NaN },
    { width: Number.POSITIVE_INFINITY, height: 106 },
  ]) {
    const sizes = new Map(complete);
    if (dimensions) {
      sizes.set("s", dimensions);
    } else {
      sizes.delete("s");
    }
    assert.equal(await buildGraphLayout(flow, sizes), null);
  }
});

function makeFlow(ids: string[], edges: FlowDefinitionSnapshot["edges"]): FlowDefinitionSnapshot {
  const flow: FlowDefinitionSnapshot = {
    schema: "acpx.flow-definition-snapshot.v1",
    name: "measured-geometry",
    startAt: ids[0],
    nodes: Object.fromEntries(ids.map((id) => [id, { nodeType: "compute" as const }])),
    edges,
  };
  validateFlowDefinition({
    name: flow.name,
    startAt: flow.startAt,
    nodes: Object.fromEntries(
      ids.map((id) => [id, { nodeType: "compute" as const, run: () => ({}) }]),
    ),
    edges,
  });
  return flow;
}

function sizesFor(flow: FlowDefinitionSnapshot, heights: number[]): Map<string, Dimensions> {
  return new Map(
    Object.keys(flow.nodes).map((id, index) => {
      assert.ok(heights[index] !== undefined, `fixture needs a height for ${id}`);
      return [id, { width: 264, height: heights[index] }];
    }),
  );
}

async function requireLayout(
  flow: FlowDefinitionSnapshot,
  sizes: ReadonlyMap<string, Dimensions>,
): Promise<ViewerGraphLayout> {
  const layout = await buildGraphLayout(flow, sizes);
  assert.ok(layout, "the installed ELK must produce a measured layout");
  return layout;
}

function assertLayoutGeometry(
  flow: FlowDefinitionSnapshot,
  sizes: ReadonlyMap<string, Dimensions>,
  layout: ViewerGraphLayout,
  centerTolerance = EPSILON,
): void {
  const edges = flow.edges.flatMap((edge, index) => {
    const targets = "to" in edge ? [edge.to] : Object.values(edge.switch.cases);
    return targets.map((target, branchIndex) => ({
      id: `${edge.from}->${target}-${index}-${branchIndex}`,
      source: edge.from,
      target,
    }));
  });
  assert.deepEqual(Object.keys(layout.edgeRoutes).toSorted(), edges.map(({ id }) => id).toSorted());
  for (const edge of edges) {
    const source = layout.nodePositions[edge.source];
    const target = layout.nodePositions[edge.target];
    const sourceSize = sizes.get(edge.source);
    const targetSize = sizes.get(edge.target);
    assert.ok(source && target && sourceSize && targetSize);
    const route = layout.edgeRoutes[edge.id];
    assert.ok(route && route.points.length >= 2, edge.id);
    assertPoint(
      route.points[0],
      { x: source.x + sourceSize.width / 2, y: source.y + sourceSize.height },
      centerTolerance,
    );
    assertPoint(
      route.points.at(-1),
      { x: target.x + targetSize.width / 2, y: target.y },
      centerTolerance,
    );
    assert.equal(
      route.isBackEdge,
      edge.source === edge.target || target.y < source.y,
      `${edge.id} classifies return direction using original node IDs`,
    );
  }
  assertRoutesAvoidInteriors(sizes, layout);
}

function assertPoint(
  actual: ViewerPoint | undefined,
  expected: ViewerPoint,
  centerTolerance: number,
): void {
  assert.ok(actual);
  assert.ok(
    Math.abs(actual.x - expected.x) < centerTolerance,
    `${actual.x} should be within ${centerTolerance} of ${expected.x}`,
  );
  assert.ok(Math.abs(actual.y - expected.y) < EPSILON, `${actual.y} should equal ${expected.y}`);
}

function assertRoutesAvoidInteriors(
  sizes: ReadonlyMap<string, Dimensions>,
  layout: ViewerGraphLayout,
): void {
  for (const [edgeId, route] of Object.entries(layout.edgeRoutes)) {
    assert.ok(route.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
    for (let index = 1; index < route.points.length; index += 1) {
      const start = route.points[index - 1];
      const end = route.points[index];
      const vertical = Math.abs(start.x - end.x) < EPSILON;
      assert.ok(vertical || Math.abs(start.y - end.y) < EPSILON, `${edgeId} is orthogonal`);
      for (const [nodeId, position] of Object.entries(layout.nodePositions)) {
        const dimensions = sizes.get(nodeId);
        assert.ok(dimensions);
        const crosses = vertical
          ? start.x > position.x + EPSILON &&
            start.x < position.x + dimensions.width - EPSILON &&
            Math.max(start.y, end.y) > position.y + EPSILON &&
            Math.min(start.y, end.y) < position.y + dimensions.height - EPSILON
          : start.y > position.y + EPSILON &&
            start.y < position.y + dimensions.height - EPSILON &&
            Math.max(start.x, end.x) > position.x + EPSILON &&
            Math.min(start.x, end.x) < position.x + dimensions.width - EPSILON;
        assert.equal(
          crosses,
          false,
          `${edgeId} segment ${index} crosses the interior of ${nodeId}`,
        );
      }
    }
  }
}
