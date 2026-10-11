import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/" });
for (const name of ["window", "document", "Element", "HTMLElement", "MouseEvent", "KeyboardEvent"]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());

const [{ createElement, act }, { createRoot }, { useWidgetShake }] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import(await clientModule("app/use-widget-shake.ts")),
]);

const rootNode = document.getElementById("root");
let root;

function Widget({ contextKey, onActivate }) {
  const onPointerDownCapture = useWidgetShake(contextKey, onActivate);
  return createElement("div", { id: "gesture-container", className: "reorderable-widget-grid", onPointerDownCapture },
    createElement("section", { "data-widget-id": "widget-a" },
      createElement("div", { className: "widget-header" },
        createElement("span", { id: "title" }, "Widget"),
        createElement("button", { id: "button" }, "Options"),
        createElement("a", { id: "link", href: "#" }, "Link"),
        createElement("input", { id: "input" }),
        createElement("textarea", { id: "textarea" }),
        createElement("select", { id: "select" }),
        createElement("div", { id: "role-button", role: "button" }, "Action"),
        createElement("div", { id: "editable", contentEditable: true, suppressContentEditableWarning: true }, "Edit")),
      createElement("div", { className: "widget-body" },
        createElement("span", { id: "body" }, "Body"),
        createElement("button", { id: "body-button" }, "Body action"))));
}

async function mount(props) {
  rootNode.innerHTML = "";
  root = createRoot(rootNode);
  await act(async () => root.render(createElement(Widget, props)));
  return rootNode.querySelector(".widget-header");
}

async function render(props) {
  await act(async () => root.render(createElement(Widget, props)));
}

async function unmount() {
  if (!root) return;
  await act(async () => root.unmount());
  root = undefined;
  rootNode.innerHTML = "";
}

afterEach(unmount);

function pointerEvent(type, {
  pointerId = 1,
  pointerType = "mouse",
  isPrimary = true,
  button = 0,
  buttons = type === "pointerdown" || type === "pointermove" ? 1 : 0,
  clientX = 100,
  clientY = 100,
  timeStamp = 100,
} = {}) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    buttons,
    clientX,
    clientY,
  });
  for (const [name, value] of Object.entries({ pointerId, pointerType, isPrimary, timeStamp })) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}

function dispatch(target, event) {
  act(() => target.dispatchEvent(event));
}

function start(header, options = {}) {
  dispatch(header, pointerEvent("pointerdown", options));
}

function shake(pointerId, { target = rootNode.querySelector("#title"), ...options } = {}) {
  const startTime = options.timeStamp ?? 100;
  const startX = options.clientX ?? 100;
  const startY = options.clientY ?? 100;
  start(target, { ...options, pointerId, clientX: startX, clientY: startY, timeStamp: startTime });
  for (const [index, clientX] of [startX + 18, startX, startX + 18].entries()) {
    dispatch(window, pointerEvent("pointermove", {
      pointerId,
      clientX,
      clientY: startY,
      timeStamp: startTime + (index + 1) * 100,
    }));
  }
  dispatch(window, pointerEvent("pointerup", { pointerId, timeStamp: startTime + 500 }));
}

function move(pointerId, clientX, clientY, timeStamp, buttons = 1) {
  dispatch(window, pointerEvent("pointermove", { pointerId, clientX, clientY, timeStamp, buttons }));
}

function shakePath(pointerId, points, { target = rootNode.querySelector("#title"), startTime = 100, timeStep = 100 } = {}) {
  const [startX, startY] = points[0];
  start(target, { pointerId, clientX: startX, clientY: startY, timeStamp: startTime });
  for (const [index, [clientX, clientY]] of points.slice(1).entries()) {
    move(pointerId, clientX, clientY, startTime + (index + 1) * timeStep);
  }
  dispatch(window, pointerEvent("pointerup", { pointerId, timeStamp: startTime + points.length * timeStep }));
}

function finishShake(pointerId, { startX = 100, startY = 100, startTime = 100, timeStep = 100 } = {}) {
  for (const [index, clientX] of [startX + 18, startX, startX + 18].entries()) {
    move(pointerId, clientX, startY, startTime + (index + 1) * timeStep);
  }
}

function assertPreviewCleared(card, message = "the directional preview is fully restored") {
  assert.equal(card?.getAttribute("data-widget-shake-preview"), null, `${message}: preview marker`);
  assert.equal(card?.style.getPropertyValue("--widget-shake-x"), "", `${message}: horizontal offset`);
  assert.equal(card?.style.getPropertyValue("--widget-shake-y"), "", `${message}: vertical offset`);
}

function previewOffsets(card) {
  return {
    x: Number.parseFloat(card.style.getPropertyValue("--widget-shake-x")) || 0,
    y: Number.parseFloat(card.style.getPropertyValue("--widget-shake-y")) || 0,
  };
}

async function waitForPreviewRestore(card, message) {
  await new Promise((resolve) => window.setTimeout(resolve, 160));
  assertPreviewCleared(card, message);
}

test("previews a bounded directional nudge in all eight directions before activation", async () => {
  const activations = [];
  const header = await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });
  const card = rootNode.querySelector("[data-widget-id='widget-a']");
  const directions = [
    ["right", 1, 0], ["down-right", 1, 1], ["down", 0, 1], ["down-left", -1, 1],
    ["left", -1, 0], ["up-left", -1, -1], ["up", 0, -1], ["up-right", 1, -1],
  ];

  for (const [index, [description, dx, dy]] of directions.entries()) {
    const pointerId = 100 + index;
    const startX = 100 + index * 200;
    const startY = 100 + index * 100;
    start(header, { pointerId, clientX: startX, clientY: startY, timeStamp: 1000 + index * 1000 });
    move(pointerId, startX + dx * 80, startY + dy * 80, 1200 + index * 1000);

    assert.equal(card.getAttribute("data-widget-shake-preview"), "true", `${description} movement enables the held preview`);
    const { x, y } = previewOffsets(card);
    const magnitude = Math.hypot(x, y);
    assert.ok(magnitude >= 6 && magnitude <= 10, `${description} nudge remains radial and near 8px (received ${magnitude}px)`);
    const directionLength = Math.hypot(dx, dy);
    assert.ok((x * dx + y * dy) / (magnitude * directionLength) > 0.9, `${description} nudge follows the pointer direction`);
    assert.equal(activations.length, 0, `${description} preview does not activate Customize before the existing shake threshold`);

    dispatch(window, pointerEvent("pointerup", { pointerId, clientX: startX + dx * 80, clientY: startY + dy * 80, timeStamp: 1250 + index * 1000 }));
    await waitForPreviewRestore(card, `${description} release`);
  }
});

test("activation retains the existing shake threshold and supplies origin and visual bounds", async () => {
  const activations = [];
  await mount({ contextKey: "workspace-a", onActivate: (...args) => activations.push(args) });
  const card = rootNode.querySelector("[data-widget-id='widget-a']");
  const expectedRect = new window.DOMRect(12, 24, 260, 150);
  card.getBoundingClientRect = () => expectedRect;

  shakePath(109, [[100, 100], [118, 100], [100, 100], [118, 100]]);

  assert.equal(activations.length, 1, "three qualifying legs still activate exactly once");
  const [startEvent, currentEvent, preview] = activations[0];
  assert.equal(startEvent.pointerId, 109);
  assert.equal(currentEvent.pointerId, 109);
  assert.ok(preview?.originRect && preview?.visualRect, "activation includes both geometry snapshots");
  assert.deepEqual(
    [preview.originRect.x, preview.originRect.y, preview.originRect.width, preview.originRect.height],
    [expectedRect.x, expectedRect.y, expectedRect.width, expectedRect.height],
  );
  for (const key of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(preview.visualRect[key]), `visualRect.${key} is finite`);
  assertPreviewCleared(card, "activation handoff");
});

test("top and side card padding start the shake while points below the header do not", async () => {
  const activations = [];
  await mount({ contextKey: "workspace-a", onActivate: (startEvent) => activations.push(startEvent) });
  const card = rootNode.querySelector("[data-widget-id='widget-a']");
  const header = rootNode.querySelector(".widget-header");
  card.getBoundingClientRect = () => new window.DOMRect(10, 20, 300, 220);
  header.getBoundingClientRect = () => new window.DOMRect(26, 46, 268, 36);

  shakePath(120, [[12, 22], [30, 22], [12, 22], [30, 22]], { target: card });
  shakePath(121, [[308, 60], [290, 60], [308, 60], [290, 60]], { target: card, startTime: 1000 });
  assert.equal(activations.length, 2, "top-left and full-width side padding are valid grab points");
  assert.equal(activations[0].target, card);
  assert.equal(activations[1].target, card);

  const outside = [[120, 120], [138, 120], [120, 120], [138, 120]];
  shakePath(122, outside, { target: rootNode.querySelector("#body"), startTime: 2000 });
  assert.equal(activations.length, 2, "the widget body stays outside the grab region");
  shakePath(123, [[100, 60], [118, 60], [100, 60], [118, 60]], {
    target: rootNode.querySelector("#button"), startTime: 3000,
  });
  shakePath(124, [[100, 60], [118, 60], [100, 60], [118, 60]], {
    target: rootNode.querySelector("#body-button"), startTime: 4000,
  });
  assert.equal(activations.length, 2, "interactive controls remain excluded even over the grab region");
});

test("activates once after three 18px horizontal strokes at inclusive limits", async () => {
  const activations = [];
  const header = await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });
  start(header, { pointerId: 11, clientX: 100, clientY: 100, timeStamp: 100 });
  move(11, 118, 100, 400);
  move(11, 100, 100, 700);
  assert.equal(activations.length, 0, "activation waits until the third stroke");
  move(11, 118, 100, 1300);
  assert.deepEqual(activations, ["activated"], "18px legs and 1200ms duration are accepted");
  move(11, 100, 100, 1400);
  move(11, 118, 100, 1500);
  assert.deepEqual(activations, ["activated"], "continued movement does not activate again");
  assert.equal(rootNode.querySelectorAll("[data-widget-id]").length, 1, "the hook leaves widget structure unchanged");
});

test("hands the original press and current pointer to activation after releasing header capture", async () => {
  const activations = [];
  const header = await mount({ contextKey: "workspace-a", onActivate: (startEvent, currentEvent) => {
    assert.equal(captured, false, "header capture is released before handoff");
    activations.push({ startEvent, currentEvent });
  } });
  let captured = false;
  header.setPointerCapture = () => { captured = true; };
  header.hasPointerCapture = () => captured;
  header.releasePointerCapture = () => { captured = false; };
  const title = header.querySelector("#title");
  const press = pointerEvent("pointerdown", { pointerId: 90, clientX: 100, clientY: 110 });
  dispatch(title, press);
  move(90, 120, 130, 200);
  move(90, 100, 110, 300);
  const activation = pointerEvent("pointermove", { pointerId: 90, clientX: 120, clientY: 130, timeStamp: 400 });
  dispatch(window, activation);
  assert.equal(activations.length, 1);
  assert.equal(activations[0].startEvent, press);
  assert.equal(activations[0].currentEvent, activation);
  assert.equal(activations[0].startEvent.target, title);
});

test("detects vertical, diagonal, leftward, upward, and mixed-heading shakes", async () => {
  const activations = [];
  await mount({ contextKey: "workspace-a", onActivate: () => activations.push(activations.length) });
  const paths = [
    ["vertical", [[100, 100], [100, 118], [100, 100], [100, 118]]],
    ["vertical excursion beyond 48px", [[100, 100], [100, 160], [100, 100], [100, 160]]],
    ["down-right diagonal", [[100, 100], [118, 118], [100, 100], [118, 118]]],
    ["up-right diagonal", [[100, 118], [118, 100], [100, 118], [118, 100]]],
    ["non-45-degree diagonal", [[100, 100], [118, 136], [100, 100], [118, 136]]],
    ["leftward initial movement", [[100, 100], [82, 100], [100, 100], [82, 100]]],
    ["upward initial movement", [[100, 100], [100, 82], [100, 100], [100, 82]]],
    ["mixed-heading backtracking", [[100, 100], [120, 100], [100, 112], [114, 94]]],
  ];

  for (const [index, [description, points]] of paths.entries()) {
    shakePath(index + 30, points, { startTime: 1000 + index * 1000 });
    assert.equal(activations.length, index + 1, `${description} should activate`);
  }
});

test("ignores controls, widget body, and unsupported pointer presses", async () => {
  const activations = [];
  const header = await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });
  const ignoredTargets = [
    ["button", rootNode.querySelector("#button"), {}],
    ["link", rootNode.querySelector("#link"), {}],
    ["input", rootNode.querySelector("#input"), {}],
    ["textarea", rootNode.querySelector("#textarea"), {}],
    ["select", rootNode.querySelector("#select"), {}],
    ["role button", rootNode.querySelector("#role-button"), {}],
    ["editable content", rootNode.querySelector("#editable"), {}],
    ["widget body", rootNode.querySelector("#body"), {}],
    ["body button", rootNode.querySelector("#body-button"), {}],
    ["touch", header.querySelector("#title"), { pointerType: "touch" }],
    ["pen", header.querySelector("#title"), { pointerType: "pen" }],
    ["non-primary pointer", header.querySelector("#title"), { isPrimary: false }],
    ["secondary mouse button", header.querySelector("#title"), { button: 2 }],
  ];

  for (const [index, [description, target, options]] of ignoredTargets.entries()) {
    shake(index + 20, { target, ...options });
    assert.equal(activations.length, 0, `${description} must not activate`);
  }
});

test("interactive targets, disabled activation, and unsupported pointers never nudge the widget", async () => {
  const header = await mount({ contextKey: "workspace-a" });
  const card = rootNode.querySelector("[data-widget-id='widget-a']");
  const ignoredTargets = [
    ["button", rootNode.querySelector("#button"), {}],
    ["link", rootNode.querySelector("#link"), {}],
    ["input", rootNode.querySelector("#input"), {}],
    ["textarea", rootNode.querySelector("#textarea"), {}],
    ["select", rootNode.querySelector("#select"), {}],
    ["role button", rootNode.querySelector("#role-button"), {}],
    ["editable content", rootNode.querySelector("#editable"), {}],
    ["touch", rootNode.querySelector("#title"), { pointerType: "touch" }],
    ["pen", rootNode.querySelector("#title"), { pointerType: "pen" }],
    ["non-primary pointer", rootNode.querySelector("#title"), { isPrimary: false }],
    ["secondary mouse button", rootNode.querySelector("#title"), { button: 2 }],
  ];

  for (const [index, [description, target, options]] of ignoredTargets.entries()) {
    const pointerId = 200 + index;
    dispatch(target, pointerEvent("pointerdown", { pointerId, clientX: 100, clientY: 100, timeStamp: 1000 + index * 1000, ...options }));
    move(pointerId, 110, 100, 1200 + index * 1000);
    assertPreviewCleared(card, `${description} press`);
    dispatch(window, pointerEvent("pointercancel", { pointerId }));
  }

  const body = rootNode.querySelector("#body");
  dispatch(body, pointerEvent("pointerdown", { pointerId: 220, clientX: 100, clientY: 100 }));
  move(220, 110, 100, 200);
  assertPreviewCleared(card, "widget body press");
  dispatch(window, pointerEvent("pointercancel", { pointerId: 220 }));
  assert.ok(header.isConnected);
});

test("requires 18px per leg and cancels excessive elapsed time", async () => {
  const activations = [];
  const header = await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });

  start(header, { pointerId: 40, timeStamp: 100 });
  for (const [index, clientX] of [117, 100, 117, 100].entries()) move(40, clientX, 100, 200 + index * 100);
  assert.equal(activations.length, 0, "17px legs do not count toward the shake");

  start(header, { pointerId: 42, timeStamp: 2000 });
  move(42, 118, 100, 2300);
  move(42, 100, 100, 2600);
  move(42, 118, 100, 3201);
  assert.equal(activations.length, 0, "a shake taking more than 1200ms is canceled");
});

test("ignores 2D jitter and one-way movement", async () => {
  const activations = [];
  await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });

  shakePath(47, [[100, 100], [118, 118], [136, 136], [118, 154], [154, 154], [136, 172], [172, 172]]);
  assert.equal(activations.length, 0, "orthogonal 2D jitter is not counted as directional reversal");

  shakePath(48, [[100, 100], [118, 100], [136, 118], [154, 136], [172, 154], [190, 172]]);
  assert.equal(activations.length, 0, "curved one-way 2D movement has no reversals");
});

test("ignores one-way movement, unrelated pointer IDs, and moves after buttons are released", async () => {
  const activations = [];
  const header = await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });

  start(header, { pointerId: 43, timeStamp: 100 });
  for (const [index, clientX] of [118, 136, 154, 172].entries()) move(43, clientX, 100, 200 + index * 100);
  assert.equal(activations.length, 0, "one-way movement has no reversals");
  dispatch(window, pointerEvent("pointerup", { pointerId: 43, timeStamp: 600 }));

  start(header, { pointerId: 44, timeStamp: 1000 });
  for (const [index, clientX] of [118, 100, 118, 100].entries()) move(45, clientX, 100, 1100 + index * 100);
  assert.equal(activations.length, 0, "moves from a different pointer ID are ignored");
  dispatch(window, pointerEvent("pointerup", { pointerId: 44, timeStamp: 1600 }));

  start(header, { pointerId: 46, timeStamp: 2000 });
  move(46, 118, 100, 2100, 0);
  move(46, 100, 100, 2200);
  move(46, 118, 100, 2300);
  move(46, 100, 100, 2400);
  assert.equal(activations.length, 0, "a move with no pressed buttons cancels the gesture");
});

test("cancels on pointer release, cancellation, capture loss, blur, and Escape", async () => {
  const activations = [];
  const header = await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });
  const card = rootNode.querySelector("[data-widget-id]");
  const cancellations = [
    ["pointer release", (pointerId) => dispatch(window, pointerEvent("pointerup", { pointerId, timeStamp: 1100 }))],
    ["pointer cancellation", (pointerId) => dispatch(window, pointerEvent("pointercancel", { pointerId, timeStamp: 1100 }))],
    ["lost capture", (pointerId) => dispatch(header, pointerEvent("lostpointercapture", { pointerId, timeStamp: 1100 }))],
    ["window blur", () => dispatch(window, new window.Event("blur"))],
    ["Escape", () => dispatch(window, new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
  ];

  for (const [index, [description, cancel]] of cancellations.entries()) {
    const pointerId = index + 50;
    start(header, { pointerId, timeStamp: 1000 });
    move(pointerId, 110, 100, 1050);
    assert.equal(card.getAttribute("data-widget-shake-preview"), "true", `${description} starts with a visible directional preview`);
    cancel(pointerId);
    await waitForPreviewRestore(card, `${description} cancellation`);
    finishShake(pointerId, { startTime: 1100 });
    assert.equal(activations.length, 0, `${description} must prevent activation`);
  }
});

test("sets pointer capture and releases it on cancellation and activation", async () => {
  const activations = [];
  await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });
  const header = rootNode.querySelector(".widget-header");
  const heldPointers = new Set();
  const setCalls = [];
  const releaseCalls = [];
  header.setPointerCapture = (pointerId) => { setCalls.push(pointerId); heldPointers.add(pointerId); };
  header.hasPointerCapture = (pointerId) => heldPointers.has(pointerId);
  header.releasePointerCapture = (pointerId) => { releaseCalls.push(pointerId); heldPointers.delete(pointerId); };

  start(header, { pointerId: 80, timeStamp: 100 });
  move(80, 110, 100, 150);
  assert.equal(rootNode.querySelector("[data-widget-id]").getAttribute("data-widget-shake-preview"), "true");
  assert.deepEqual(setCalls, [80]);
  assert.equal(heldPointers.has(80), true);
  dispatch(window, pointerEvent("pointercancel", { pointerId: 80, timeStamp: 110 }));
  assert.deepEqual(releaseCalls, [80]);
  assert.equal(heldPointers.has(80), false);
  await waitForPreviewRestore(rootNode.querySelector("[data-widget-id]"), "pointer capture cancellation");

  start(header, { pointerId: 81, timeStamp: 1000 });
  assert.deepEqual(setCalls, [80, 81]);
  finishShake(81, { startTime: 1000 });
  assert.deepEqual(activations, ["activated"]);
  assert.deepEqual(releaseCalls, [80, 81]);
  assert.equal(heldPointers.has(81), false);
});

test("cancels an active gesture when context or callback availability changes", async () => {
  const activations = [];
  const callback = () => activations.push("activated");
  const initial = { contextKey: "workspace-a", onActivate: callback };
  let header = await mount(initial);
  let card = rootNode.querySelector("[data-widget-id]");

  start(header, { pointerId: 60, timeStamp: 100 });
  move(60, 110, 100, 150);
  assert.equal(card.getAttribute("data-widget-shake-preview"), "true");
  await render({ ...initial, contextKey: "workspace-b" });
  assertPreviewCleared(card, "workspace context change");
  finishShake(60);
  assert.equal(activations.length, 0, "changing context cancels an in-progress gesture");

  header = rootNode.querySelector(".widget-header");
  card = rootNode.querySelector("[data-widget-id]");
  start(header, { pointerId: 61, timeStamp: 1000 });
  move(61, 110, 100, 1050);
  assert.equal(card.getAttribute("data-widget-shake-preview"), "true");
  await render({ contextKey: "workspace-b" });
  assertPreviewCleared(card, "activation callback removal");
  finishShake(61, { startTime: 1100 });
  assert.equal(activations.length, 0, "removing the callback cancels an in-progress gesture");

  shake(62, { target: rootNode.querySelector("#title") });
  assert.equal(activations.length, 0, "a missing callback cannot start a gesture");

  await render({ contextKey: "workspace-b", onActivate: callback });
  shake(63);
  assert.deepEqual(activations, ["activated"], "a gesture can activate after the callback becomes available again");
});

test("unmount cancels an active gesture", async () => {
  const activations = [];
  const header = await mount({ contextKey: "workspace-a", onActivate: () => activations.push("activated") });
  const card = rootNode.querySelector("[data-widget-id]");
  start(header, { pointerId: 70, timeStamp: 100 });
  move(70, 110, 100, 150);
  assert.equal(card.getAttribute("data-widget-shake-preview"), "true");
  await unmount();
  assertPreviewCleared(card, "unmount");
  finishShake(70);
  assert.equal(activations.length, 0);
});
