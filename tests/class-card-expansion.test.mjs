import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://edu.example/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ClassCardExpansion } = await import(await clientModule("app/class-card-expansion.tsx"));
const { getWidgetResizeContentFilter } = await import(await clientModule("lib/widget-resize.ts"));
const { createWidgetResizeSettleFrames } = await import(await clientModule("lib/widget-resize-motion.ts"));

let systemReduced = false;
let sourceRect = { left: 30, top: 600, width: 260, height: 200 };
let triggerRect = { left: 100, top: 450, width: 120, height: 44 };
let dialogRectOverride = null;
let mobileNavRect = null;
let sidebarRect = null;
let calls = [];
let cancelledEvents = [];

window.matchMedia = () => ({ matches: systemReduced });

function rect(value) {
  return new window.DOMRect(value.left, value.top, value.width, value.height);
}

function sourceMarkup(courseId = "course[1]", withSource = true) {
  const source = withSource
    ? `<button id="course-source" data-course-card-id="${courseId}" aria-hidden="false" style="visibility: visible !important; border-top-left-radius: 0px; border-top-right-radius: 0px; border-bottom-right-radius: 0px; border-bottom-left-radius: 0px; box-shadow: none"><span id="source-label" tabindex="0" contenteditable="true">Course visual</span></button>`
    : "";
  document.body.innerHTML = `<style>.class-card-expansion-dialog { border-top-left-radius: 24px; border-top-right-radius: 24px; border-bottom-right-radius: 24px; border-bottom-left-radius: 24px; box-shadow: 0 22px 70px rgba(21, 27, 45, 0.2); }</style><main class="reference-ui"><aside id="workspace-sidebar" class="sidebar"></aside>${source}<button id="entry-trigger">Open class</button><div class="mobile-bottom-nav"></div><div id="app-root"></div></main>`;
  const trigger = document.getElementById("entry-trigger");
  const root = createRoot(document.getElementById("app-root"));
  return { source: document.getElementById("course-source"), trigger, root, host: document.getElementById("app-root") };
}

function setup({ withSource = true, courseId = "course[1]", reduced = null } = {}) {
  calls = [];
  cancelledEvents = [];
  dialogRectOverride = null;
  mobileNavRect = null;
  sidebarRect = null;
  systemReduced = reduced === "media";
  document.documentElement.dataset.motion = reduced === "attribute" ? "reduced" : "full";
  document.body.style.setProperty("overflow", "clip", "important");
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  const originalAnimate = window.HTMLElement.prototype.animate;
  const { source, trigger, root, host } = sourceMarkup(courseId, withSource);

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === source) return rect(sourceRect);
    if (this === trigger) return rect(triggerRect);
    if (this.classList?.contains("mobile-bottom-nav") && mobileNavRect) return rect(mobileNavRect);
    if (this.classList?.contains("sidebar") && sidebarRect) return rect(sidebarRect);
    if (this.classList?.contains("class-card-expansion-dialog")) {
      if (dialogRectOverride) return rect(dialogRectOverride);
      return rect({
        left: Number.parseFloat(this.style.left) || 0,
        top: Number.parseFloat(this.style.top) || 0,
        width: Number.parseFloat(this.style.width) || 0,
        height: Number.parseFloat(this.style.height) || 0,
      });
    }
    return originalRect.call(this);
  };
  window.HTMLElement.prototype.animate = function (frames, options) {
    const animation = {
      cancelled: false,
      onfinish: null,
      oncancel: null,
      cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        cancelledEvents.push(this);
        this.oncancel?.();
      },
      finish() {
        this.onfinish?.();
      },
    };
    calls.push({ element: this, frames, options, animation });
    return animation;
  };

  const render = async ({ suspended = false, onClose = () => {}, children } = {}) => act(async () => root.render(h(ClassCardExpansion, {
    courseId,
    onClose,
    suspended,
    children: children ?? ((close) => h("div", { className: "test-class-details" },
      h("button", { type: "button", onClick: close }, "Close class"),
      h("button", { type: "button" }, "Edit class"),
    )),
  })));

  const cleanup = async () => {
    await act(async () => root.unmount());
    window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (originalAnimate) window.HTMLElement.prototype.animate = originalAnimate;
    else delete window.HTMLElement.prototype.animate;
    document.body.innerHTML = "";
  };

  return { source, trigger, root, host, render, cleanup };
}

function callsFor(selector) {
  return calls.filter((call) => call.element.matches(selector));
}

const appearanceProperties = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "boxShadow",
];

function appearanceOf(element) {
  const style = window.getComputedStyle(element);
  return Object.fromEntries(appearanceProperties.map((property) => [property, style[property]]));
}

function frameAppearance(frame) {
  return Object.fromEntries(appearanceProperties.map((property) => [property, frame[property]]));
}

function geometryFrames(frames) {
  return frames.map((frame) => Object.fromEntries(Object.entries(frame).filter(([property]) => !appearanceProperties.includes(property))));
}

function installResizeObserverStub() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }

    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
    notify() {
      this.callback(this.targets.map((target) => ({ target, contentRect: rect(sidebarRect) })), this);
    }
  };
  return {
    observers,
    restore() {
      if (original) Object.defineProperty(globalThis, "ResizeObserver", original);
      else delete globalThis.ResizeObserver;
    },
  };
}

test("expansion animates from the matched source into a bounded in-place modal and reveals details", async () => {
  const { source, render, cleanup } = setup();
  try {
    source.focus();
    await render();
    const backdrop = document.querySelector(".class-card-expansion-backdrop");
    const dialog = backdrop.querySelector("[role='dialog']");
    const expandedAppearance = appearanceOf(dialog);
    const shape = callsFor(".class-card-expansion-dialog")[0];
    const preview = document.querySelector(".class-card-expansion-preview");

    assert.equal(backdrop.closest(".reference-ui") !== null, true);
    assert.equal(dialog.getAttribute("aria-label"), "Class details");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(dialog.style.left, "18px");
    assert.equal(dialog.style.top, "60px");
    assert.equal(dialog.style.width, "840px");
    assert.equal(dialog.style.height, "740px");
    assert.equal(shape.frames.length, 31);
    assert.deepEqual(geometryFrames(shape.frames), createWidgetResizeSettleFrames(sourceRect, { left: 18, top: 60, width: 840, height: 740 }, 11));
    assert.deepEqual(shape.frames[0], {
      offset: 0,
      width: "260px",
      height: "200px",
      transform: "translate(12px, 540px)",
      transformOrigin: "top left",
      ...appearanceOf(source),
    });
    assert.deepEqual(shape.frames.at(-1), {
      offset: 1,
      width: "840px",
      height: "740px",
      transform: "translate(0px, 0px)",
      transformOrigin: "top left",
      ...expandedAppearance,
    });
    assert.equal(shape.options.duration, 420);
    assert.equal(shape.options.easing, "linear");
    assert.equal(shape.options.fill, "both");
    assert.equal(source.style.visibility, "hidden");
    assert.equal(source.getAttribute("aria-hidden"), "true");
    assert.equal(source.hasAttribute("inert"), true);
    assert.equal(preview.getAttribute("aria-hidden"), "true");
    assert.equal(preview.hasAttribute("inert"), true);
    assert.equal(preview.firstElementChild.tagName, "DIV");
    assert.equal(preview.firstElementChild.style.transition, "none");
    assert.equal(preview.firstElementChild.style.animation, "none");
    assert.equal(preview.firstElementChild.style.transform, "none");
    assert.equal(preview.querySelectorAll("button, a, input, select, textarea, [tabindex], [contenteditable]").length, 0);
    assert.equal(preview.querySelector("#source-label"), null);
    assert.equal(document.activeElement.textContent, "Close class");
    assert.equal(document.body.style.getPropertyValue("overflow"), "hidden");

    const reveal = callsFor(".class-card-expansion-content")[0];
    assert.deepEqual(reveal.frames, [
      { opacity: 0, filter: getWidgetResizeContentFilter(8) },
      { opacity: 1, filter: getWidgetResizeContentFilter(0) },
    ]);
    assert.equal(reveal.options.duration, 220);
    assert.equal(reveal.options.easing, "ease-out");
    const previewFade = callsFor(".class-card-expansion-preview")[0];
    assert.equal(previewFade.options.duration, 220);
    assert.equal(previewFade.options.easing, "ease-out");

    const oldShapeCount = callsFor(".class-card-expansion-dialog").length;
    await render({ children: (close) => h("div", null, h("button", { onClick: close }, "Close class"), h("button", null, "Updated")), onClose: () => {} });
    assert.equal(callsFor(".class-card-expansion-dialog").length, oldShapeCount);
  } finally {
    await cleanup();
  }
});

test("opening animates asymmetric source corners and shadow while the preview avoids double painting", async () => {
  const { source, render, cleanup } = setup();
  const sourceAppearance = {
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "12px 20px",
    borderBottomRightRadius: "9px",
    borderBottomLeftRadius: "18px 24px",
    boxShadow: "0 3px 11px rgba(10, 20, 30, 0.4)",
  };
  for (const [property, value] of Object.entries(sourceAppearance)) source.style[property] = value;
  try {
    source.focus();
    await render();
    const dialog = document.querySelector(".class-card-expansion-dialog");
    const previewRoot = document.querySelector(".class-card-expansion-preview").firstElementChild;
    const shape = callsFor(".class-card-expansion-dialog")[0];
    const expandedAppearance = appearanceOf(dialog);

    assert.deepEqual(frameAppearance(shape.frames[0]), appearanceOf(source));
    assert.deepEqual(frameAppearance(shape.frames.at(-1)), expandedAppearance);
    assert.equal(shape.frames[0].borderTopRightRadius, "12px 20px");
    assert.equal(shape.frames[0].borderBottomLeftRadius, "18px 24px");
    assert.equal(shape.frames.at(-1).borderTopLeftRadius, "24px");
    assert.equal(previewRoot.style.boxShadow, "none");
    assert.equal(previewRoot.style.borderWidth, "0px");
    assert.equal(previewRoot.style.borderRadius, "inherit");
  } finally {
    await cleanup();
  }
});

test("a closing resize captures the live appearance and retargets to the source's latest style", async () => {
  const { source, render, cleanup } = setup();
  const initialSourceAppearance = {
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "12px 20px",
    borderBottomRightRadius: "9px",
    borderBottomLeftRadius: "18px 24px",
    boxShadow: "0 3px 11px rgba(10, 20, 30, 0.4)",
  };
  const currentAppearance = {
    borderTopLeftRadius: "13px",
    borderTopRightRadius: "15px 21px",
    borderBottomRightRadius: "17px",
    borderBottomLeftRadius: "19px 25px",
    boxShadow: "0 6px 16px rgba(1, 2, 3, 0.5)",
  };
  const resizedSourceAppearance = {
    borderTopLeftRadius: "3px",
    borderTopRightRadius: "7px 11px",
    borderBottomRightRadius: "14px",
    borderBottomLeftRadius: "21px 27px",
    boxShadow: "0 1px 5px rgba(40, 50, 60, 0.35)",
  };
  for (const [property, value] of Object.entries(initialSourceAppearance)) source.style[property] = value;
  try {
    source.focus();
    await render();
    const dialog = document.querySelector(".class-card-expansion-dialog");
    const expandedAppearance = appearanceOf(dialog);
    const closeButton = [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Close class"));
    await act(async () => closeButton.click());
    const firstExit = callsFor(".class-card-expansion-dialog").at(-1);
    assert.deepEqual(frameAppearance(firstExit.frames[0]), expandedAppearance);
    assert.deepEqual(frameAppearance(firstExit.frames.at(-1)), appearanceOf(source));

    for (const [property, value] of Object.entries(currentAppearance)) dialog.style[property] = value;
    const capturedAppearance = appearanceOf(dialog);
    for (const [property, value] of Object.entries(resizedSourceAppearance)) source.style[property] = value;
    await act(async () => window.dispatchEvent(new window.Event("resize")));

    const retargetedExit = callsFor(".class-card-expansion-dialog").at(-1);
    assert.equal(firstExit.animation.cancelled, true);
    assert.deepEqual(frameAppearance(retargetedExit.frames[0]), capturedAppearance);
    assert.deepEqual(frameAppearance(retargetedExit.frames.at(-1)), appearanceOf(source));
    assert.deepEqual(appearanceOf(dialog), appearanceOf(source), "the inline end style matches the live source target");

    await act(async () => retargetedExit.animation.finish());
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    assert.equal(document.querySelector(".class-card-expansion-dialog"), null);
    assert.equal(source.style.getPropertyValue("visibility"), "visible");
    assert.equal(source.style.getPropertyPriority("visibility"), "important");
    assert.equal(source.getAttribute("aria-hidden"), "false");
    assert.equal(source.hasAttribute("inert"), false);
  } finally {
    await cleanup();
  }
});

test("close reverses from the live dialog rectangle, restores exact source styles, and returns focus", async () => {
  const { source, render, cleanup } = setup();
  const sourceContainer = source.parentElement;
  let closed = 0;
  try {
    source.focus();
    await render({ onClose: () => {
      closed += 1;
      assert.equal(document.querySelector(".class-card-expansion-dialog")?.style.visibility, "hidden");
      window.setTimeout(() => sourceContainer.removeAttribute("inert"), 10);
    } });
    const expandedAppearance = appearanceOf(document.querySelector(".class-card-expansion-dialog"));
    sourceContainer.setAttribute("inert", "");
    dialogRectOverride = { left: 55, top: 70, width: 710, height: 620 };
    const closeButton = [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Close class"));
    await act(async () => closeButton.click());

    const shapes = callsFor(".class-card-expansion-dialog");
    const exit = shapes.at(-1);
    assert.equal(closed, 0);
    assert.equal(exit.options.duration, 420);
    assert.equal(exit.options.easing, "linear");
    assert.deepEqual(exit.frames[0], {
      offset: 0,
      width: "710px",
      height: "620px",
      transform: "translate(25px, -530px)",
      transformOrigin: "top left",
      ...expandedAppearance,
    });
    assert.deepEqual(exit.frames.at(-1), {
      offset: 1,
      width: "260px",
      height: "200px",
      transform: "translate(0px, 0px)",
      transformOrigin: "top left",
      ...appearanceOf(source),
    });
    const details = document.querySelector(".class-card-expansion-content");
    const fade = callsFor(".class-card-expansion-content").at(-1);
    assert.equal(fade.options.duration, 220);
    assert.equal(fade.options.easing, "ease-out");
    await act(async () => fade.animation.finish());
    assert.equal(details.style.opacity, "0");
    assert.equal(exit.animation.cancelled, false);
    assert.equal(document.querySelector(".class-card-expansion-dialog"), exit.element);
    await act(async () => exit.animation.finish());
    await new Promise((resolve) => window.setTimeout(resolve, 80));

    assert.equal(closed, 1);
    assert.equal(document.querySelector(".class-card-expansion-dialog"), null);
    assert.equal(source.style.getPropertyValue("visibility"), "visible");
    assert.equal(source.style.getPropertyPriority("visibility"), "important");
    assert.equal(source.getAttribute("aria-hidden"), "false");
    assert.equal(source.hasAttribute("inert"), false);
    assert.equal(document.body.style.getPropertyValue("overflow"), "clip");
    assert.equal(document.body.style.getPropertyPriority("overflow"), "important");
    assert.equal(sourceContainer.hasAttribute("inert"), false);
    assert.equal(document.activeElement, source);
  } finally {
    await cleanup();
  }
});

test("closing during the reveal continues from the visible content instead of flashing full details", async () => {
  const { render, cleanup } = setup();
  try {
    await render();
    const content = document.querySelector(".class-card-expansion-content");
    const preview = document.querySelector(".class-card-expansion-preview");
    content.style.opacity = "0.45";
    content.style.filter = getWidgetResizeContentFilter(4);
    preview.style.opacity = "0.55";
    preview.style.filter = getWidgetResizeContentFilter(3);
    await act(async () => document.querySelector(".test-class-details button").click());
    const contentFade = callsFor(".class-card-expansion-content").at(-1);
    const previewFade = callsFor(".class-card-expansion-preview").at(-1);
    assert.deepEqual(contentFade.frames[0], { opacity: "0.45", filter: getWidgetResizeContentFilter(4) });
    assert.deepEqual(previewFade.frames[0], { opacity: "0.55", filter: getWidgetResizeContentFilter(3) });
    assert.equal(content.style.opacity, "0.45");
    assert.equal(preview.style.opacity, "0.55");
    assert.equal(callsFor(".class-card-expansion-dialog").at(-1).options.fill, "both");
  } finally {
    await cleanup();
  }
});

test("suspended expansion leaves Escape to nested dialogs and restores its internal focus on resume", async () => {
  const { render, cleanup } = setup();
  let closed = 0;
  try {
    await render({ onClose: () => { closed += 1; } });
    const edit = [...document.querySelectorAll("button")].find((button) => button.textContent === "Edit class");
    edit.focus();
    await render({ suspended: true, onClose: () => { closed += 1; } });
    const nested = document.createElement("div");
    nested.setAttribute("role", "dialog");
    nested.setAttribute("aria-modal", "true");
    nested.innerHTML = "<button>Close assignment</button>";
    document.querySelector(".reference-ui").append(nested);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const expansion = document.querySelector(".class-card-expansion-dialog");
    assert.equal(expansion.getAttribute("aria-modal"), null);
    assert.equal(expansion.hasAttribute("inert"), true);
    assert.equal(nested.contains(document.activeElement), true);
    assert.equal(document.activeElement.textContent, "Close assignment");
    const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);

    assert.equal(escape.defaultPrevented, false);
    assert.equal(closed, 0);
    nested.remove();
    await render({ suspended: false, onClose: () => { closed += 1; } });
    assert.equal(document.activeElement.textContent, "Edit class");
    assert.equal(expansion.hasAttribute("inert"), false);
    assert.equal(expansion.getAttribute("aria-modal"), "true");

    document.getElementById("entry-trigger").focus();
    const tab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.notEqual(document.activeElement, document.getElementById("entry-trigger"));
  } finally {
    await cleanup();
  }
});

test("reduced-motion settings and missing WAAPI open and close immediately", async () => {
  for (const mode of ["attribute", "media", "unavailable"]) {
    const { source, render, cleanup } = setup({ reduced: mode === "unavailable" ? null : mode });
    let closed = 0;
    const originalAnimate = window.HTMLElement.prototype.animate;
    try {
      if (mode === "unavailable") delete window.HTMLElement.prototype.animate;
      await render({ onClose: () => { closed += 1; } });
      assert.equal(calls.length, 0, `${mode} starts without WAAPI animations`);
      assert.equal(document.querySelector(".class-card-expansion-content").style.opacity, "1");
      const closeButton = [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Close class"));
      await act(async () => closeButton.click());
      assert.equal(closed, 1);
      assert.equal(source.style.visibility, "visible");
      assert.equal(document.body.style.getPropertyValue("overflow"), "clip");
    } finally {
      if (originalAnimate) window.HTMLElement.prototype.animate = originalAnimate;
      await cleanup();
    }
  }
});

test("mobile bounds keep the expanded card above the bottom navigation", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const originalHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  const { render, cleanup } = setup();
  mobileNavRect = { left: 0, top: 760, width: 390, height: 84 };
  try {
    await render();
    const dialog = document.querySelector(".class-card-expansion-dialog");
    assert.equal(dialog.style.width, "366px");
    assert.equal(dialog.style.height, "736px");
    assert.equal(Number.parseFloat(dialog.style.top), 12);
    assert.ok(Number.parseFloat(dialog.style.top) + Number.parseFloat(dialog.style.height) <= mobileNavRect.top - 12);
    assert.equal(callsFor(".class-card-expansion-dialog")[0].frames.at(-1).width, "366px");
  } finally {
    await cleanup();
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
    if (originalHeight) Object.defineProperty(window, "innerHeight", originalHeight);
  }
});

test("expansion stays centered on interior cards in four- and seven-column layouts", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const layouts = [
    { width: 1800, centers: [680, 1120] },
    { width: 2400, centers: [520, 880, 1240, 1600, 1960] },
  ];
  try {
    for (const layout of layouts) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: layout.width });
      for (const center of layout.centers) {
        sourceRect = { left: center - 80, top: 400, width: 160, height: 120 };
        const { render, cleanup } = setup();
        try {
          await render();
          const dialog = document.querySelector(".class-card-expansion-dialog");
          const left = Number.parseFloat(dialog.style.left);
          assert.equal(left, center - 420);
          assert.equal(left + Number.parseFloat(dialog.style.width) / 2, center);
        } finally {
          await cleanup();
        }
      }
    }
  } finally {
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
  }
});

test("viewport edges clamp the expansion while unconstrained animation frames keep the source center", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  try {
    for (const { left: anchorLeft, expectedLeft } of [
      { left: 10, expectedLeft: 18 },
      { left: 1150, expectedLeft: 342 },
    ]) {
      sourceRect = { left: anchorLeft, top: 500, width: 40, height: 100 };
      const { render, cleanup } = setup();
      try {
        await render();
        assert.equal(document.querySelector(".class-card-expansion-dialog").style.left, `${expectedLeft}px`);
      } finally {
        await cleanup();
      }
    }

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1800 });
    sourceRect = { left: 540, top: 500, width: 240, height: 120 };
    const { render, cleanup } = setup();
    try {
      await render();
      const dialog = document.querySelector(".class-card-expansion-dialog");
      const targetLeft = Number.parseFloat(dialog.style.left);
      const sourceCenter = sourceRect.left + sourceRect.width / 2;
      const shape = callsFor(".class-card-expansion-dialog")[0];
      assert.equal(shape.frames.length, 31);
      for (const frame of shape.frames) {
        const translation = frame.transform.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\)$/);
        assert.ok(translation, `unexpected transform: ${frame.transform}`);
        const frameCenter = targetLeft + Number(translation[1]) + Number.parseFloat(frame.width) / 2;
        assert.ok(Math.abs(frameCenter - sourceCenter) < 1e-8, `frame center ${frameCenter} differs from source center ${sourceCenter}`);
      }
    } finally {
      await cleanup();
    }
  } finally {
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
  }
});

test("resize reflows the expansion around the source's latest center", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1800 });
  sourceRect = { left: 380, top: 500, width: 220, height: 100 };
  const { render, cleanup } = setup();
  try {
    await render();
    sourceRect = { left: 980, top: 500, width: 220, height: 100 };
    await act(async () => window.dispatchEvent(new window.Event("resize")));

    const dialog = document.querySelector(".class-card-expansion-dialog");
    const latestCenter = sourceRect.left + sourceRect.width / 2;
    const left = Number.parseFloat(dialog.style.left);
    assert.equal(left, latestCenter - Number.parseFloat(dialog.style.width) / 2);
    assert.equal(callsFor(".class-card-expansion-dialog").length, 2);
    assert.equal(callsFor(".class-card-expansion-dialog").at(-1).frames.at(-1).transform, "translate(0px, 0px)");
  } finally {
    await cleanup();
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
  }
});

test("expanded and collapsed sidebars set a left boundary while interior cards stay centered", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
  try {
    for (const { collapsed, sidebarRight, center, expectedLeft } of [
      { collapsed: false, sidebarRight: 246, center: 300, expectedLeft: 264 },
      { collapsed: true, sidebarRight: 82, center: 300, expectedLeft: 100 },
      { collapsed: false, sidebarRight: 246, center: 900, expectedLeft: 480 },
      { collapsed: true, sidebarRight: 82, center: 900, expectedLeft: 480 },
    ]) {
      sourceRect = { left: center - 100, top: 500, width: 200, height: 160 };
      const { render, cleanup } = setup();
      try {
        sidebarRect = { left: 0, top: 0, width: sidebarRight, height: 900 };
        document.querySelector(".reference-ui").classList.toggle("sidebar-collapsed", collapsed);
        await render();
        const dialog = document.querySelector(".class-card-expansion-dialog");
        assert.equal(dialog.style.left, `${expectedLeft}px`);
        assert.equal(dialog.style.width, "840px");
        if (center === 900) assert.equal(Number.parseFloat(dialog.style.left) + 420, center);
      } finally {
        await cleanup();
      }
    }
  } finally {
    sidebarRect = null;
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
  }
});

test("desktop expansion width is limited to the space right of a visible sidebar", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
  sourceRect = { left: 500, top: 500, width: 200, height: 140 };
  const { render, cleanup } = setup();
  try {
    sidebarRect = { left: 0, top: 0, width: 246, height: 900 };
    await render();
    const dialog = document.querySelector(".class-card-expansion-dialog");
    assert.equal(dialog.style.left, "264px");
    assert.equal(dialog.style.width, "618px");
    assert.equal(Number.parseFloat(dialog.style.left) + Number.parseFloat(dialog.style.width), 882);
  } finally {
    await cleanup();
    sidebarRect = null;
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
  }
});

test("hidden and offscreen mobile sidebars do not shrink or shift the expansion", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  try {
    for (const geometry of [
      { rect: { left: 0, top: 0, width: 270, height: 844 }, hidden: true },
      { rect: { left: -270, top: 0, width: 270, height: 844 }, hidden: false },
    ]) {
      sourceRect = { left: 90, top: 500, width: 200, height: 120 };
      const { render, cleanup } = setup();
      try {
        const sidebar = document.querySelector(".sidebar");
        sidebarRect = geometry.rect;
        if (geometry.hidden) sidebar.style.display = "none";
        await render();
        const dialog = document.querySelector(".class-card-expansion-dialog");
        assert.equal(dialog.style.left, "12px");
        assert.equal(dialog.style.width, "366px");
      } finally {
        await cleanup();
      }
    }
  } finally {
    sidebarRect = null;
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
  }
});

test("fallback expansion centers in the area remaining beside the sidebar", async () => {
  sourceRect = { left: -500, top: -600, width: 240, height: 180 };
  const { render, cleanup } = setup();
  try {
    sidebarRect = { left: 0, top: 0, width: 246, height: 900 };
    await render();
    const dialog = document.querySelector(".class-card-expansion-dialog");
    assert.equal(dialog.style.left, "303px");
    assert.equal(Number.parseFloat(dialog.style.left) + Number.parseFloat(dialog.style.width) / 2, 723);
  } finally {
    await cleanup();
    sidebarRect = null;
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
  }
});

test("sidebar ResizeObserver ignores the initial size and applies changed bounds without overlapping animation", async () => {
  const observerStub = installResizeObserverStub();
  sourceRect = { left: 240, top: 500, width: 120, height: 120 };
  const { render, cleanup } = setup();
  let observer;
  try {
    sidebarRect = { left: 0, top: 0, width: 246, height: 900 };
    await render();
    observer = observerStub.observers[0];
    assert.ok(observer);
    assert.equal(observer.targets[0], document.querySelector(".sidebar"));
    const initialShape = callsFor(".class-card-expansion-dialog")[0];
    assert.equal(document.querySelector(".class-card-expansion-dialog").style.left, "264px");

    observer.notify();
    assert.equal(initialShape.animation.cancelled, false, "an unchanged initial observation leaves the opening animation alone");
    assert.equal(callsFor(".class-card-expansion-dialog").length, 1);

    sidebarRect = { left: 0, top: 0, width: 320, height: 900 };
    observer.notify();
    assert.equal(initialShape.animation.cancelled, true);
    assert.equal(callsFor(".class-card-expansion-dialog").length, 1, "sidebar resize directly applies the new bounds");
    assert.equal(document.querySelector(".class-card-expansion-dialog").style.left, "338px");

    sidebarRect = { left: 0, top: 0, width: 360, height: 900 };
    await act(async () => window.dispatchEvent(new window.Event("resize")));
    const windowResizeShape = callsFor(".class-card-expansion-dialog").at(-1);
    assert.equal(callsFor(".class-card-expansion-dialog").length, 2);
    assert.equal(windowResizeShape.animation.cancelled, false);
    assert.equal(document.querySelector(".class-card-expansion-dialog").style.left, "378px");

    observer.notify();
    assert.equal(windowResizeShape.animation.cancelled, false, "the observer sees the edge already cached by the window resize");
    assert.equal(callsFor(".class-card-expansion-dialog").length, 2, "unchanged observer size does not replace the resize animation");
  } finally {
    await cleanup();
    observerStub.restore();
    sidebarRect = null;
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
  }
  assert.equal(observer.disconnected, true);
});

test("trigger geometry handles missing sources and offscreen sources use a centered fallback", async () => {
  const missing = setup({ withSource: false });
  try {
    missing.trigger.focus();
    await missing.render();
    const fromTrigger = callsFor(".class-card-expansion-dialog")[0];
    assert.equal(fromTrigger.frames[0].width, "120px");
    assert.equal(fromTrigger.frames[0].height, "44px");
    assert.equal(fromTrigger.frames[0].transform, "translate(82px, 432px)");
  } finally {
    await missing.cleanup();
  }

  sourceRect = { left: -500, top: -600, width: 240, height: 180 };
  const offscreen = setup();
  try {
    await offscreen.render();
    const dialog = document.querySelector(".class-card-expansion-dialog");
    assert.equal(dialog.style.left, "180px");
    assert.equal(dialog.style.top, "80px");
    assert.equal(callsFor(".class-card-expansion-dialog").length, 0);
    await act(async () => dialog.querySelector(".test-class-details button").click());
    assert.equal(callsFor(".class-card-expansion-dialog").length, 0);
    assert.equal(document.querySelector(".class-card-expansion-dialog"), null);
  } finally {
    await offscreen.cleanup();
    sourceRect = { left: 30, top: 600, width: 260, height: 200 };
  }
});

test("an interrupted close and unmount cancel animations and restore source and scroll styles", async () => {
  const { source, render, cleanup } = setup();
  try {
    source.setAttribute("inert", "");
    await render();
    const closeButton = [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Close class"));
    await act(async () => closeButton.click());
    const exit = callsFor(".class-card-expansion-dialog").at(-1);
    assert.equal(exit.animation.cancelled, false);
    await cleanup();
    assert.equal(exit.animation.cancelled, true);
    assert.equal(source.style.getPropertyValue("visibility"), "visible");
    assert.equal(source.getAttribute("aria-hidden"), "false");
    assert.equal(source.hasAttribute("inert"), true);
    assert.equal(document.body.style.getPropertyValue("overflow"), "clip");
  } finally {
    if (document.querySelector(".class-card-expansion-dialog")) await cleanup();
  }
});

test("unmount does not return focus over a newly opened dialog", async () => {
  const { source, render, cleanup } = setup();
  try {
    source.focus();
    await render();
    const nextDialog = document.createElement("div");
    nextDialog.setAttribute("role", "dialog");
    nextDialog.innerHTML = "<button>Save edits</button>";
    document.querySelector(".reference-ui").append(nextDialog);
    await cleanup();
    await Promise.resolve();
    assert.notEqual(document.activeElement, source);
    assert.equal(source.style.visibility, "visible");
  } finally {
    document.querySelector("[role='dialog']")?.remove();
  }
});
