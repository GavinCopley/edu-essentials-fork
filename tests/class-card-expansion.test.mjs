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
const { createCourseExpansionHorizontalFrames, createCourseExpansionSettleFrames, getCourseExpansionProgress, COURSE_EXPANSION_CONTENT_DURATION_MS, COURSE_EXPANSION_CONTENT_FADE_IN_START_MS, COURSE_EXPANSION_CONTENT_FADE_OUT_END_MS } = await import(await clientModule("lib/course-expansion-motion.ts"));

let systemReduced = false;
let sourceRect = { left: 30, top: 600, width: 260, height: 200 };
let triggerRect = { left: 100, top: 450, width: 120, height: 44 };
let dialogRectOverride = null;
let detailRectOverride = null;
let mobileNavRect = null;
let sidebarRect = null;
let calls = [];
let cancelledEvents = [];
let onTargetMorphMeasure = null;
let onAnimationCancel = null;

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
  detailRectOverride = null;
  mobileNavRect = null;
  sidebarRect = null;
  onTargetMorphMeasure = null;
  onAnimationCancel = null;
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
    if (this.classList?.contains("class-card-expansion-content") && detailRectOverride) return rect(detailRectOverride);
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
        onAnimationCancel?.(this);
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

const courseMorphRects = {
  source: {
    visual: { left: 30, top: 600, width: 260, height: 132 },
    watermark: { left: 210, top: 603, width: 70, height: 76 },
    code: { left: 47, top: 700, width: 62, height: 22 },
    icon: { left: 250, top: 700, width: 34, height: 34 },
    name: { left: 45, top: 741, width: 180, height: 18 },
    instructor: { left: 45, top: 774, width: 78, height: 14 },
    credits: { left: 131, top: 774, width: 62, height: 14 },
  },
  target: {
    visual: { left: 19, top: 61, width: 838, height: 190 },
    watermark: { left: 690, top: 34, width: 140, height: 132 },
    code: { left: 43, top: 200, width: 86, height: 30 },
    icon: { left: 750, top: 200, width: 44, height: 44 },
    name: { left: 43, top: 280, width: 360, height: 30 },
    instructor: { left: 43, top: 520, width: 90, height: 18 },
    credits: { left: 43, top: 320, width: 102, height: 18 },
  },
};

function setMorphFixture(source) {
  source.innerHTML = `<div data-course-morph="visual" style="background-image:linear-gradient(135deg, rgb(230, 230, 255), rgb(180, 180, 255))"><img src="data:image/svg+xml,%3Csvg/%3E" alt="" /></div><span data-course-morph="watermark" style="opacity:.06">CS</span><span data-course-morph="code">CS101</span><svg data-course-morph="icon" viewBox="0 0 24 24" width="34" height="34"><path d="M2 3h8v18H2z" /></svg><div><h3 data-course-morph="name" style="font-size:14px">World History</h3><p><span data-course-morph="instructor">Dr Ada</span> · <span data-course-morph="credits">4 credits</span></p></div>`;
}

function installMorphRectMocks() {
  const originalHtmlRect = window.HTMLElement.prototype.getBoundingClientRect;
  const originalElementRect = window.Element.prototype.getBoundingClientRect;
  const customRect = (element) => {
    if (element.classList?.contains("class-card-expansion-morph")) {
      const dialog = document.querySelector(".class-card-expansion-dialog");
      const parent = dialog?.getBoundingClientRect();
      if (!parent) return null;
      return rect({
        left: parent.left + 1 + (Number.parseFloat(element.style.left) || 0),
        top: parent.top + 1 + (Number.parseFloat(element.style.top) || 0),
        width: Number.parseFloat(element.style.width) || 0,
        height: Number.parseFloat(element.style.height) || 0,
      });
    }
    const key = element.getAttribute?.("data-course-morph");
    if (!key) return null;
    if (element.closest?.("[data-course-card-id]")) return rect(courseMorphRects.source[key]);
    const content = element.closest?.(".class-card-expansion-content");
    if (content) {
      onTargetMorphMeasure?.(element, content);
      return rect(courseMorphRects.target[key]);
    }
    return null;
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return customRect(this) ?? originalHtmlRect.call(this);
  };
  window.Element.prototype.getBoundingClientRect = function () {
    return customRect(this) ?? originalElementRect.call(this);
  };
  return () => {
    window.HTMLElement.prototype.getBoundingClientRect = originalHtmlRect;
    window.Element.prototype.getBoundingClientRect = originalElementRect;
  };
}

function callsFor(selector) {
  return calls.filter((call) => call.element.matches(selector));
}

function contentGeometryCalls() {
  return callsFor(".class-card-expansion-content").filter((call) => call.frames.some((frame) => "transform" in frame));
}

function contentOpacityCalls() {
  return callsFor(".class-card-expansion-content").filter((call) => call.frames.some((frame) => "opacity" in frame));
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
    const content = dialog.querySelector(".class-card-expansion-content");
    const dialogStyle = window.getComputedStyle(dialog);
    const borderLeft = Number.parseFloat(dialogStyle.borderLeftWidth) || 0;
    assert.equal(Number.parseFloat(content.style.width), 840 - (Number.parseFloat(dialogStyle.borderLeftWidth) || 0) - (Number.parseFloat(dialogStyle.borderRightWidth) || 0), "detail layout stays at its destination inner width while the shell expands");
    assert.equal(Number.parseFloat(content.style.height), 740 - (Number.parseFloat(dialogStyle.borderTopWidth) || 0) - (Number.parseFloat(dialogStyle.borderBottomWidth) || 0), "detail layout stays at its destination inner height while the shell expands");
    assert.equal(shape.frames.length, 31);
    assert.deepEqual(geometryFrames(shape.frames), createCourseExpansionSettleFrames(sourceRect, { left: 18, top: 60, width: 840, height: 740 }));
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
    const detailGeometry = contentGeometryCalls()[0];
    assert.deepEqual(detailGeometry.frames, createCourseExpansionHorizontalFrames(
      sourceRect,
      { left: 18, top: 60, width: 840, height: 740 },
      18 + borderLeft,
      18 + borderLeft,
      borderLeft,
    ));
    assert.equal(detailGeometry.options.duration, 420);
    assert.equal(detailGeometry.options.easing, "linear");
    assert.equal(detailGeometry.options.fill, "both");
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

    const reveal = contentOpacityCalls()[0];
    const previewFade = callsFor(".class-card-expansion-preview")[0];
    await act(async () => shape.animation.finish());
    assert.equal(detailGeometry.animation.cancelled, true, "opening handoff cancels the filled position animation");
    assert.equal(content.style.transform, "", "opening handoff removes the temporary position transform");
    assert.equal(content.style.width, "", "even an opening without morph pairs releases its pinned layout");
    assert.equal(content.style.height, "");
    assert.deepEqual(reveal.frames, [
      { offset: 0, opacity: "0" },
      { offset: COURSE_EXPANSION_CONTENT_FADE_IN_START_MS / COURSE_EXPANSION_CONTENT_DURATION_MS, opacity: "0", easing: "ease-out" },
      { offset: 1, opacity: 1 },
    ]);
    assert.deepEqual(previewFade.frames, [
      { offset: 0, opacity: "1", easing: "ease-out" },
      { offset: COURSE_EXPANSION_CONTENT_FADE_OUT_END_MS / COURSE_EXPANSION_CONTENT_DURATION_MS, opacity: 0 },
      { offset: 1, opacity: 0 },
    ]);
    assert.ok(COURSE_EXPANSION_CONTENT_FADE_IN_START_MS < COURSE_EXPANSION_CONTENT_FADE_OUT_END_MS, "incoming details begin while the outgoing preview is still faintly visible");
    assert.equal(previewFade.frames[2].opacity, 0, "the outgoing preview stays hidden as details enter");
    assert.equal(reveal.frames.some((frame) => "filter" in frame), false, "content transitions use opacity without blur");
    assert.equal(previewFade.frames.some((frame) => "filter" in frame), false, "the preview stays crisp as it fades");
    assert.equal(reveal.options.duration, COURSE_EXPANSION_CONTENT_DURATION_MS);
    assert.equal(reveal.options.easing, "linear");
    assert.equal(previewFade.options.duration, COURSE_EXPANSION_CONTENT_DURATION_MS);
    assert.equal(previewFade.options.easing, "linear");
    await act(async () => previewFade.animation.finish());
    await act(async () => reveal.animation.finish());
    assert.equal(preview.hidden, true);
    assert.equal(preview.style.opacity, "1");
    assert.equal(document.querySelector(".class-card-expansion-content").style.opacity, "1");

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

test("matched visual, icon, and labels stay in an opaque shared layer through the expansion", async () => {
  const { source, render, cleanup } = setup();
  setMorphFixture(source);
  const restoreRects = installMorphRectMocks();
  const details = (close) => h("div", null,
    h("div", { className: "expanded-class-header" },
      h("div", { "data-course-morph": "visual", style: { backgroundImage: "linear-gradient(135deg, rgb(230, 230, 255), rgb(180, 180, 255))" } }, h("img", { src: "data:image/svg+xml,%3Csvg/%3E", alt: "" })),
      h("span", { "data-course-morph": "watermark", style: { opacity: "0.06" } }, "CS"),
      h("span", { "data-course-morph": "code" }, "CS101"),
      h("svg", { "data-course-morph": "icon", viewBox: "0 0 24 24", width: 44, height: 44 }, h("path", { d: "M2 3h8v18H2z" })),
    ),
    h("div", { className: "expanded-class-body" },
      h("h2", null, h("span", { "data-course-morph": "name", style: { fontSize: "24px", lineHeight: "35.4px" } }, "World History")),
      h("p", null, h("span", { "data-course-morph": "credits" }, "4 credits")),
      h("p", null, h("span", { "data-course-morph": "instructor" }, "Dr Ada")),
      h("button", { onClick: close }, "Close class"),
    ),
  );
  try {
    source.focus();
    await render({ children: details });
    const shared = document.querySelector(".class-card-expansion-shared-layer");
    const wrappers = [...shared.querySelectorAll(".class-card-expansion-morph")];
    const keys = wrappers.map((wrapper) => wrapper.dataset.courseMorph).sort();
    assert.deepEqual(keys, ["code", "icon", "name", "visual", "watermark"]);
    assert.equal(shared.querySelector(".class-card-expansion-morph[data-course-morph='watermark']").style.zIndex, "0", "decorative initials stay below the content and close button");
    assert.equal(shared.querySelectorAll("[data-course-morph='visual'] img").length, 1);
    assert.equal(shared.querySelector("[data-course-background-overlay]"), null, "identical gradients do not get an unnecessary overlay");
    const imageClone = shared.querySelector(".class-card-expansion-morph[data-course-morph='visual'] img");
    assert.equal(imageClone.style.position, "absolute");
    assert.equal(imageClone.style.inset, "0px");
    assert.equal(imageClone.style.width, "100%", "the image fills the morphing visual at every size");
    assert.equal(imageClone.style.height, "100%");
    assert.equal(imageClone.style.objectFit, "cover");
    assert.equal(calls.some((call) => call.element === imageClone), false, "the shared photo remains fully opaque throughout the morph");
    const iconClone = shared.querySelector(".class-card-expansion-morph[data-course-morph='icon']").firstElementChild;
    assert.equal(iconClone.tagName.toLowerCase(), "svg", "the SVG root remains intact in the shared snapshot");
    assert.equal(iconClone.firstElementChild.tagName.toLowerCase(), "path");
    assert.equal(shared.querySelector("[data-course-morph='watermark']").firstElementChild.style.opacity, "0.06");
    assert.equal(shared.closest(".class-card-expansion-content"), null);
    assert.equal(shared.style.opacity, "");
    for (const target of document.querySelectorAll(".class-card-expansion-content [data-course-morph]")) {
      assert.equal(target.style.visibility, ["instructor", "credits"].includes(target.dataset.courseMorph) ? "" : "hidden", `${target.dataset.courseMorph} either crossfades in its own layout or uses a shared overlay`);
    }

    const visual = wrappers.find((wrapper) => wrapper.dataset.courseMorph === "visual");
    const visualAnimation = calls.find((call) => call.element === visual);
    assert.equal(visualAnimation.frames.length, 31);
    assert.equal(visualAnimation.options.duration, 420);
    assert.equal(visualAnimation.frames[0].width, "260px");
    assert.equal(visualAnimation.frames.at(-1).width, "838px");
    assert.equal(visualAnimation.frames.at(-1).height, "190px");

    const nameWrapper = wrappers.find((wrapper) => wrapper.dataset.courseMorph === "name");
    const nameGeometry = calls.find((call) => call.element === nameWrapper);
    const nameClone = nameWrapper.firstElementChild;
    const nameStyles = calls.find((call) => call.element === nameClone);
    const overshootIndex = nameGeometry.frames.findIndex((frame) => getCourseExpansionProgress(Number(frame.offset)) > 1);
    assert.ok(overshootIndex >= 0, "the shared spring has an intermediate overshoot frame");
    assert.equal(nameGeometry.frames[overshootIndex].width, nameGeometry.frames.at(-1).width, "name width reaches but never overshoots its destination");
    assert.equal(nameGeometry.frames[overshootIndex].height, nameGeometry.frames.at(-1).height, "name height reaches but never overshoots its destination");
    assert.ok(nameStyles, "the name clone animates its typography with the shared bounds");
    assert.equal(nameStyles.frames[overshootIndex].fontSize, nameStyles.frames.at(-1).fontSize, "font size stays at its endpoint through the spatial spring overshoot");

    await act(async () => callsFor(".class-card-expansion-preview")[0].animation.finish());
    await act(async () => callsFor(".class-card-expansion-dialog")[0].animation.finish());
    assert.equal(shared.childElementCount, 0);
    assert.equal(document.querySelector(".class-card-expansion-content [data-course-morph='name']").style.visibility, "");
    assert.equal(document.querySelector(".class-card-expansion-preview [data-course-morph='name']").style.visibility, "");

    await act(async () => document.querySelector(".class-card-expansion-content button").click());
    const closingWrappers = [...shared.querySelectorAll(".class-card-expansion-morph")];
    assert.deepEqual(closingWrappers.map((wrapper) => wrapper.dataset.courseMorph).sort(), keys);
    for (const target of document.querySelectorAll(".class-card-expansion-content [data-course-morph]")) {
      assert.equal(target.style.visibility, ["instructor", "credits"].includes(target.dataset.courseMorph) ? "" : "hidden", `${target.dataset.courseMorph} does not gain a moving duplicate on close`);
    }
    for (const preview of document.querySelectorAll(".class-card-expansion-preview [data-course-morph]")) {
      assert.equal(preview.style.visibility, ["instructor", "credits"].includes(preview.dataset.courseMorph) ? "" : "hidden", `${preview.dataset.courseMorph} either returns with the compact layout or its shared clone`);
    }
    const closeShape = callsFor(".class-card-expansion-dialog").at(-1);
    await act(async () => closeShape.animation.finish());
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    assert.equal(document.querySelector(".class-card-expansion-dialog"), null);
    assert.equal(source.style.visibility, "visible");
  } finally {
    restoreRects();
    await cleanup();
  }
});

test("a heading with an added course-code prefix fades as one changed heading", async () => {
  const { source, render, cleanup } = setup();
  setMorphFixture(source);
  const restoreRects = installMorphRectMocks();
  const details = (close) => h("div", null,
    h("div", { "data-course-morph": "visual" }),
    h("span", { "data-course-morph": "code" }, "CS101"),
    h("svg", { "data-course-morph": "icon", viewBox: "0 0 24 24", width: 44, height: 44 }, h("path", { d: "M2 3h8v18H2z" })),
    h("h2", null, "CS101 · ", h("span", { "data-course-morph": "name" }, "World History")),
    h("button", { onClick: close }, "Close class"),
  );
  try {
    source.focus();
    await render({ children: details });
    const shared = document.querySelector(".class-card-expansion-shared-layer");
    const name = document.querySelector(".class-card-expansion-content [data-course-morph='name']");
    const previewName = document.querySelector(".class-card-expansion-preview [data-course-morph='name']");
    assert.equal(shared.querySelector(".class-card-expansion-morph[data-course-morph='name']"), null, "the partial title is not isolated from its heading prefix");
    assert.equal(name.style.visibility, "", "the complete expanded heading stays in the incoming content layer");
    assert.equal(previewName.style.visibility, "", "the complete compact title stays in the outgoing preview");
    for (const key of ["visual", "icon", "code"]) {
      const wrapper = shared.querySelector(`.class-card-expansion-morph[data-course-morph='${key}']`);
      assert.ok(wrapper, `${key} remains in the shared layer`);
      assert.equal(calls.some((call) => call.element === wrapper && call.options.duration === 420), true, `${key} keeps the shared spring animation`);
    }
    assert.deepEqual(contentOpacityCalls()[0].frames.map((frame) => frame.opacity), ["0", "0", 1]);
    assert.equal(document.querySelector(".class-card-expansion-content").style.opacity, "0");
    assert.equal(document.querySelector(".class-card-expansion-preview").style.opacity, "1");
  } finally {
    restoreRects();
    await cleanup();
  }
});

test("a multiline expanded name crossfades as distinct content while common visuals still morph", async () => {
  const { source, render, cleanup } = setup();
  setMorphFixture(source);
  const longName = "Cell Biology — ביולוגיה של התא, Molecular Mechanisms and Genetic Regulation";
  source.querySelector("[data-course-morph='name']").textContent = longName;
  const rangeRectsDescriptor = Object.getOwnPropertyDescriptor(window.Range.prototype, "getClientRects");
  Object.defineProperty(window.Range.prototype, "getClientRects", {
    configurable: true,
    value() {
      let node = this.startContainer;
      while (node && node.nodeType !== window.Node.ELEMENT_NODE) node = node.parentNode;
      const name = node?.closest?.("[data-course-morph='name']");
      if (name?.closest("[data-course-card-id]")) return [{ top: 100 }, { top: 100 }];
      if (name?.closest(".class-card-expansion-content")) return [{ top: 200 }, { top: 224 }];
      return [];
    },
  });
  const restoreRects = installMorphRectMocks();
  const details = (close) => h("div", null,
    h("div", { className: "expanded-class-header" },
      h("div", { "data-course-morph": "visual", style: { backgroundImage: "linear-gradient(135deg, rgb(230, 230, 255), rgb(180, 180, 255))" } }, h("img", { src: "data:image/svg+xml,%3Csvg/%3E", alt: "" })),
      h("span", { "data-course-morph": "code" }, "CS101"),
    ),
    h("div", { className: "expanded-class-body" },
      h("h2", null, h("span", { "data-course-morph": "name", style: { fontSize: "24px", lineHeight: "24px" } }, longName)),
      h("button", { onClick: close }, "Close class"),
    ),
  );
  try {
    await render({ children: details });
    const shared = document.querySelector(".class-card-expansion-shared-layer");
    const preview = document.querySelector(".class-card-expansion-preview");
    const expandedName = document.querySelector(".class-card-expansion-content [data-course-morph='name']");
    assert.equal(shared.querySelector("[data-course-morph='name']"), null, "different text wrapping does not use the clipped name morph");
    assert.ok(shared.querySelector("[data-course-morph='visual']"), "the matching course image still morphs in shared bounds");
    assert.ok(preview.querySelector("[data-course-morph='name']"), "the compact title remains in the outgoing preview");
    assert.equal(expandedName.style.visibility, "", "the wrapped title remains in the incoming details layer");
    assert.equal(calls.some((call) => call.element.closest?.(".class-card-expansion-morph[data-course-morph='name']")), false);
    assert.deepEqual(contentOpacityCalls()[0].frames.slice(0, 2), [
      { offset: 0, opacity: "0" },
      { offset: COURSE_EXPANSION_CONTENT_FADE_IN_START_MS / COURSE_EXPANSION_CONTENT_DURATION_MS, opacity: "0", easing: "ease-out" },
    ]);
  } finally {
    restoreRects();
    if (rangeRectsDescriptor) Object.defineProperty(window.Range.prototype, "getClientRects", rangeRectsDescriptor);
    else delete window.Range.prototype.getClientRects;
    await cleanup();
  }
});

test("different course gradients crossfade inside the single shared image morph", async () => {
  const { source, render, cleanup } = setup();
  setMorphFixture(source);
  Object.defineProperties(source.querySelector("img"), {
    complete: { value: true, configurable: true },
    naturalWidth: { value: 100, configurable: true },
  });
  const restoreRects = installMorphRectMocks();
  const sourceGradient = "linear-gradient(135deg, rgb(230, 230, 255), rgb(180, 180, 255))";
  const targetGradient = "linear-gradient(90deg, rgb(255, 230, 230), rgb(255, 180, 180))";
  try {
    source.focus();
    await render({ children: (close) => h("div", null,
      h("div", { className: "expanded-class-header" },
        h("div", { "data-course-morph": "visual", style: { backgroundImage: targetGradient, backgroundColor: "rgb(10, 20, 30)" } }),
      ),
      h("button", { onClick: close }, "Close class"),
    ) });

    const shared = document.querySelector(".class-card-expansion-shared-layer");
    const visual = shared.querySelector(".class-card-expansion-morph[data-course-morph='visual']");
    const overlay = visual.querySelector("[data-course-background-overlay]");
    const image = visual.querySelector("img");
    const visualClone = visual.firstElementChild;
    const backgroundAnimation = calls.find((call) => call.element === overlay);
    assert.ok(overlay);
    assert.equal(overlay.style.backgroundImage, targetGradient);
    assert.equal(overlay.style.opacity, "0");
    assert.deepEqual(backgroundAnimation.frames[0], { offset: 0, opacity: "0" });
    assert.deepEqual(backgroundAnimation.frames.at(-1), { offset: 1, opacity: "1" });
    assert.equal(shared.querySelectorAll("[data-course-morph='visual'] img").length, 1, "the gradient layer never duplicates the image");
    assert.equal(calls.some((call) => call.element === image), false, "the source photo remains opaque while the background changes");
    const backgroundColorAnimation = calls.find((call) => call.element === visualClone);
    assert.ok(backgroundColorAnimation, "a separate root style still animates with the gradient crossfade");
    await act(async () => backgroundColorAnimation.animation.finish());
    assert.equal(visualClone.style.backgroundImage, sourceGradient, "finishing a different root property keeps the source gradient as the backing layer");

    await act(async () => callsFor(".class-card-expansion-dialog")[0].animation.finish());
    assert.equal(shared.querySelector(".class-card-expansion-morph[data-course-morph='visual']"), visual, "the loaded source photo remains in place while the expanded image waits");
    assert.equal(overlay.style.opacity, "1");
    assert.equal(visualClone.style.backgroundImage, sourceGradient, "the retained photo keeps its source gradient under the target overlay");
    await act(async () => document.querySelector(".class-card-expansion-content button").click());
    const closingBackgroundAnimation = calls.filter((call) => call.element === overlay).at(-1);
    assert.equal(overlay.style.backgroundImage, targetGradient, "closing reverses the existing overlay over the source backing layer");
    assert.deepEqual(closingBackgroundAnimation.frames[0], { offset: 0, opacity: "1" });
    assert.deepEqual(closingBackgroundAnimation.frames.at(-1), { offset: 1, opacity: "0" });
    const closingColorAnimation = calls.filter((call) => call.element === visualClone).at(-1);
    await act(async () => closingColorAnimation.animation.finish());
    assert.equal(visualClone.style.backgroundImage, sourceGradient, "the closing style handoff does not replace the source backing gradient");
  } finally {
    restoreRects();
    await cleanup();
  }
});

test("a loaded source image stays visible until the expanded image decodes, with safe close cleanup", async () => {
  for (const closeBeforeLoad of [false, true]) {
    const { source, render, cleanup } = setup();
    setMorphFixture(source);
    const restoreRects = installMorphRectMocks();
    Object.defineProperties(source.querySelector("img"), {
      complete: { value: true, configurable: true },
      naturalWidth: { value: 100, configurable: true },
    });
    try {
      await render({ children: (close) => h("div", null,
        h("div", { className: "expanded-class-header" }, h("div", { "data-course-morph": "visual" })),
        h("button", { onClick: close }, "Close class"),
      ) });
      const target = document.querySelector(".class-card-expansion-content [data-course-morph='visual']");
      await act(async () => {
        for (const call of calls.filter((call) => call.options.duration === COURSE_EXPANSION_CONTENT_DURATION_MS)) call.animation.finish();
        callsFor(".class-card-expansion-dialog")[0].animation.finish();
      });
      const snapshot = document.querySelector(".class-card-expansion-morph[data-course-morph='visual']");
      assert.ok(snapshot.querySelector("img"), "the photo remains visible after geometry settles");
      assert.equal(snapshot.style.width, "100%");
      assert.equal(target.style.visibility, "hidden");
      await act(async () => window.dispatchEvent(new window.Event("resize")));
      assert.equal(snapshot.style.width, "100%", "a pending photo remains fluid after resize retargeting");
      if (closeBeforeLoad) {
        await act(async () => document.querySelector(".class-card-expansion-content button").click());
        await act(async () => callsFor(".class-card-expansion-dialog").at(-1).animation.finish());
      }
      const image = document.createElement("img");
      image.src = "data:image/svg+xml,%3Csvg/%3E";
      Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 } });
      image.decode = () => Promise.resolve();
      await act(async () => { target.appendChild(image); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
      assert.equal(document.querySelector(".class-card-expansion-morph[data-course-morph='visual']"), null);
      if (closeBeforeLoad) {
        assert.equal(document.querySelector(".class-card-expansion-dialog"), null);
        assert.equal(source.style.visibility, "visible");
      } else {
        assert.equal(target.style.visibility, "");
        assert.ok(target.querySelector("img").complete);
      }
    } finally { restoreRects(); await cleanup(); }
  }
});

test("removing the source image releases its retained snapshot while the expanded image is pending", async () => {
  const { source, render, cleanup } = setup();
  setMorphFixture(source);
  Object.defineProperties(source.querySelector("img"), {
    complete: { value: true, configurable: true },
    naturalWidth: { value: 100, configurable: true },
  });
  const restoreRects = installMorphRectMocks();
  try {
    await render({ children: (close) => h("div", null,
      h("div", { className: "expanded-class-header" }, h("div", { "data-course-morph": "visual" })),
      h("button", { onClick: close }, "Close class"),
    ) });
    const target = document.querySelector(".class-card-expansion-content [data-course-morph='visual']");
    await act(async () => callsFor(".class-card-expansion-dialog")[0].animation.finish());
    assert.ok(document.querySelector(".class-card-expansion-morph[data-course-morph='visual'] img"), "the loaded compact photo is retained while the expanded image is absent");
    assert.equal(target.style.visibility, "hidden");

    await act(async () => {
      source.querySelector("img").remove();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    assert.equal(document.querySelector(".class-card-expansion-morph[data-course-morph='visual']"), null, "removing the course image drops the stale photo snapshot");
    assert.equal(target.style.visibility, "", "the expanded gradient is revealed after the image is removed");
  } finally {
    restoreRects();
    await cleanup();
  }
});

test("closing mid-morph starts from live shared bounds and styles, then restores the compact source", async () => {
  const { source, render, cleanup } = setup();
  setMorphFixture(source);
  const restoreRects = installMorphRectMocks();
  let targetName;
  const details = (close) => h("div", null,
    h("div", { className: "expanded-class-header" },
      h("div", { "data-course-morph": "visual" }),
      h("span", { "data-course-morph": "watermark", style: { opacity: "0.06" } }, "CS"),
      h("span", { "data-course-morph": "code" }, "CS101"),
      h("svg", { "data-course-morph": "icon", viewBox: "0 0 24 24", width: 44, height: 44 }, h("path", { d: "M2 3h8v18H2z" })),
    ),
    h("div", { className: "expanded-class-body" },
      h("h2", null, h("span", { "data-course-morph": "name" }, "World History")),
      h("p", null, h("span", { "data-course-morph": "credits" }, "4 credits")),
      h("p", null, h("span", { "data-course-morph": "instructor" }, "Dr Ada")),
      h("button", { onClick: close }, "Close class"),
    ),
  );
  try {
    source.focus();
    await render({ children: details });
    targetName = document.querySelector(".class-card-expansion-content [data-course-morph='name']");
    assert.equal(targetName.style.visibility, "hidden");

    const nameWrapper = document.querySelector(".class-card-expansion-morph[data-course-morph='name']");
    const nameClone = nameWrapper.firstElementChild;
    dialogRectOverride = { left: 50, top: 95, width: 690, height: 600 };
    nameWrapper.style.left = "108px";
    nameWrapper.style.top = "221px";
    nameWrapper.style.width = "240px";
    nameWrapper.style.height = "27px";
    nameClone.style.fontSize = "19px";
    await act(async () => document.querySelector(".class-card-expansion-content button").click());

    const callsForName = calls.filter((call) => call.element === nameWrapper);
    const closeGeometry = callsForName.at(-1);
    assert.equal(callsForName.length, 2, "the same shared node reverses instead of being replaced");
    assert.equal(closeGeometry.frames.length, 31);
    assert.equal(closeGeometry.frames[0].width, "240px");
    assert.equal(closeGeometry.frames[0].height, "27px");
    assert.equal(closeGeometry.frames.at(-1).width, "180px");
    assert.equal(nameClone.style.fontSize, "19px", "cancelling opening retains its live text size");
    const styleReversal = calls.filter((call) => call.element === nameClone).at(-1);
    assert.equal(styleReversal.frames.length, 31);
    assert.equal(styleReversal.frames[0].fontSize, "19px");
    assert.equal(styleReversal.frames[0]["font-size"], undefined, "WAAPI receives its supported property names");
    assert.equal(source.style.visibility, "hidden");
    const exit = callsFor(".class-card-expansion-dialog").at(-1);
    await act(async () => exit.animation.finish());
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    assert.equal(document.querySelector(".class-card-expansion-dialog"), null);
  } finally {
    restoreRects();
    await cleanup();
  }
  assert.equal(source.style.visibility, "visible");
  assert.equal(source.style.getPropertyPriority("visibility"), "important");
  assert.equal(targetName.style.visibility, "", "unmount restores expanded target visibility");
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
    onAnimationCancel = (animation) => {
      if (animation !== firstExit.animation) return;
      for (const [property, value] of Object.entries(initialSourceAppearance)) dialog.style[property] = value;
    };
    try {
      await act(async () => window.dispatchEvent(new window.Event("resize")));
    } finally {
      onAnimationCancel = null;
    }

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

test("closing during expansion preserves pinned detail dimensions and the captured world-left", async () => {
  const { source, render, cleanup } = setup();
  try {
    source.focus();
    await render();
    const dialog = document.querySelector(".class-card-expansion-dialog");
    const details = dialog.querySelector(".class-card-expansion-content");
    const borderStyle = window.getComputedStyle(dialog);
    const borderLeft = Number.parseFloat(borderStyle.borderLeftWidth) || 0;
    const initialWidth = details.style.width;
    const initialHeight = details.style.height;
    const openingGeometry = contentGeometryCalls()[0];

    dialogRectOverride = { left: 100, top: 90, width: 520, height: 460 };
    detailRectOverride = { left: 620, top: 100, width: 838, height: 738 };
    await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Close class")).click());

    const closeGeometry = contentGeometryCalls().at(-1);
    const closeShape = callsFor(".class-card-expansion-dialog").at(-1);
    assert.equal(openingGeometry.animation.cancelled, true, "the interrupted opening position animation is replaced");
    assert.equal(details.style.width, initialWidth, "an early close retains the pinned destination width");
    assert.equal(details.style.height, initialHeight, "an early close retains the pinned destination height");
    assert.deepEqual(closeGeometry.frames, createCourseExpansionHorizontalFrames(
      dialogRectOverride,
      sourceRect,
      detailRectOverride.left,
      detailRectOverride.left,
      borderLeft,
    ));
    assert.equal(closeGeometry.frames[0].transform, `translateX(${detailRectOverride.left - dialogRectOverride.left - borderLeft}px)`);
    assert.equal(closeShape.options.duration, 420);
  } finally {
    await cleanup();
  }
});

test("closing after opening pins live dimensions and holds detail content at its captured left", async () => {
  const { source, render, cleanup } = setup();
  try {
    source.focus();
    await render();
    const dialog = document.querySelector(".class-card-expansion-dialog");
    const details = dialog.querySelector(".class-card-expansion-content");
    const openingShape = callsFor(".class-card-expansion-dialog")[0];
    await act(async () => openingShape.animation.finish());
    assert.equal(details.style.width, "", "opening handoff releases the pinned width");
    assert.equal(details.style.height, "", "opening handoff releases the pinned height");

    const borderStyle = window.getComputedStyle(dialog);
    const borderLeft = Number.parseFloat(borderStyle.borderLeftWidth) || 0;
    const borderRight = Number.parseFloat(borderStyle.borderRightWidth) || 0;
    const borderTop = Number.parseFloat(borderStyle.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(borderStyle.borderBottomWidth) || 0;
    dialogRectOverride = { left: 230, top: 70, width: 840, height: 740 };
    detailRectOverride = { left: 650, top: 71, width: 840 - borderLeft - borderRight, height: 740 - borderTop - borderBottom };
    await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Close class")).click());

    const closeGeometry = contentGeometryCalls().at(-1);
    assert.equal(details.style.width, `${840 - borderLeft - borderRight}px`, "closing freezes the current full detail width");
    assert.equal(details.style.height, `${740 - borderTop - borderBottom}px`, "closing freezes the current full detail height");
    assert.equal(closeGeometry.frames[0].transform, `translateX(${detailRectOverride.left - dialogRectOverride.left - borderLeft}px)`);
    assert.equal(closeGeometry.frames.at(-1).transform, `translateX(${detailRectOverride.left - sourceRect.left - borderLeft}px)`);
  } finally {
    await cleanup();
  }
});

test("opening resize preserves the captured content position with an unchanged shell width", async () => {
  const { source, render, cleanup } = setup();
  const originalSourceRect = sourceRect;
  try {
    source.focus();
    await render();
    const initialShape = callsFor(".class-card-expansion-dialog")[0];
    const initialGeometry = contentGeometryCalls()[0];
    dialogRectOverride = { left: 100, top: 80, width: 840, height: 740 };
    detailRectOverride = { left: 150, top: 81, width: 838, height: 738 };
    sourceRect = { left: 540, top: 500, width: 260, height: 200 };
    await act(async () => window.dispatchEvent(new window.Event("resize")));

    const retargetedShape = callsFor(".class-card-expansion-dialog").at(-1);
    const retargetedGeometry = contentGeometryCalls().at(-1);
    const borderLeft = Number.parseFloat(window.getComputedStyle(document.querySelector(".class-card-expansion-dialog")).borderLeftWidth) || 0;
    assert.equal(initialShape.animation.cancelled, true);
    assert.equal(initialGeometry.animation.cancelled, true);
    assert.equal(retargetedShape.frames[0].width, "840px");
    assert.equal(retargetedShape.frames.at(-1).width, "840px", "the retarget keeps the expanded width unchanged");
    assert.equal(retargetedGeometry.frames[0].transform, `translateX(${detailRectOverride.left - dialogRectOverride.left - borderLeft}px)`, "the first frame matches the captured live content position");
    assert.equal(retargetedGeometry.frames.at(-1).transform, "translateX(0px)");
  } finally {
    sourceRect = originalSourceRect;
    await cleanup();
  }
});

test("opening resize measures matched targets after clearing the previous detail translation", async () => {
  const { source, render, cleanup } = setup();
  const originalSourceRect = sourceRect;
  setMorphFixture(source);
  const restoreRects = installMorphRectMocks();
  const renderDetails = (close) => h("div", null,
    h("div", { "data-course-morph": "visual" }),
    h("span", { "data-course-morph": "watermark" }, "CS"),
    h("span", { "data-course-morph": "code" }, "CS101"),
    h("svg", { "data-course-morph": "icon", viewBox: "0 0 24 24", width: 44, height: 44 }, h("path", { d: "M2 3h8v18H2z" })),
    h("h2", { "data-course-morph": "name" }, "World History"),
    h("button", { onClick: close }, "Close class"),
  );
  try {
    source.focus();
    await render({ children: renderDetails });
    const content = document.querySelector(".class-card-expansion-content");
    assert.notEqual(content.style.transform, "translateX(0px)", "the initial source-to-destination offset is active before resize");
    const measuredTransforms = [];
    onTargetMorphMeasure = (_target, content) => measuredTransforms.push(content.style.transform);
    dialogRectOverride = { left: 100, top: 80, width: 840, height: 740 };
    detailRectOverride = { left: 150, top: 81, width: 838, height: 738 };
    sourceRect = { left: 540, top: 500, width: 260, height: 200 };

    await act(async () => window.dispatchEvent(new window.Event("resize")));

    assert.ok(measuredTransforms.length > 0, "resize measures expanded targets for the new shared morphs");
    assert.ok(measuredTransforms.every((transform) => transform === "translateX(0px)"), "target bounds use the neutral destination layout");
  } finally {
    onTargetMorphMeasure = null;
    sourceRect = originalSourceRect;
    restoreRects();
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
    const fade = contentOpacityCalls().at(-1);
    const previewFade = callsFor(".class-card-expansion-preview").at(-1);
    assert.equal(fade.options.duration, COURSE_EXPANSION_CONTENT_DURATION_MS);
    assert.equal(fade.options.easing, "linear");
    await act(async () => fade.animation.finish());
    assert.equal(details.style.opacity, "0");
    await act(async () => previewFade.animation.finish());
    assert.equal(document.querySelector(".class-card-expansion-preview").style.opacity, "1");
    assert.equal(document.querySelector(".class-card-expansion-preview").style.filter, "none");
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
    content.style.filter = "blur(4px)";
    preview.style.opacity = "0.55";
    preview.style.filter = "blur(3px)";
    await act(async () => document.querySelector(".test-class-details button").click());
    const contentFade = contentOpacityCalls().at(-1);
    const previewFade = callsFor(".class-card-expansion-preview").at(-1);
    assert.deepEqual(contentFade.frames[0], { offset: 0, opacity: "0.45", easing: "ease-out" });
    assert.deepEqual(contentFade.frames[1], { offset: COURSE_EXPANSION_CONTENT_FADE_OUT_END_MS / COURSE_EXPANSION_CONTENT_DURATION_MS, opacity: 0 });
    assert.deepEqual(previewFade.frames[0], { offset: 0, opacity: "0.55" });
    assert.deepEqual(previewFade.frames[1], { offset: COURSE_EXPANSION_CONTENT_FADE_IN_START_MS / COURSE_EXPANSION_CONTENT_DURATION_MS, opacity: "0.55", easing: "ease-out" });
    assert.equal(contentFade.frames[1].opacity, 0, "details fade out quickly as the source content returns");
    assert.equal(contentFade.frames.some((frame) => "filter" in frame), false, "closing details use opacity only");
    assert.equal(previewFade.frames.some((frame) => "filter" in frame), false, "closing preview uses opacity only");
    assert.equal(previewFade.frames.at(-1).opacity, 1);
    assert.equal(contentFade.options.easing, "linear");
    assert.equal(previewFade.options.easing, "linear");
    assert.equal(content.style.opacity, "0.45");
    assert.equal(preview.style.opacity, "0.55");
    assert.equal(callsFor(".class-card-expansion-dialog").at(-1).options.fill, "both");
    await act(async () => contentFade.animation.finish());
    await act(async () => previewFade.animation.finish());
    assert.equal(content.style.opacity, "0");
    assert.equal(preview.style.opacity, "1");
    assert.equal(preview.style.filter, "none");
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
    const content = dialog.querySelector(".class-card-expansion-content");
    const dialogStyle = window.getComputedStyle(dialog);
    assert.equal(Number.parseFloat(content.style.width), Number.parseFloat(dialog.style.width) - (Number.parseFloat(dialogStyle.borderLeftWidth) || 0) - (Number.parseFloat(dialogStyle.borderRightWidth) || 0));
    assert.equal(Number.parseFloat(content.style.height), Number.parseFloat(dialog.style.height) - (Number.parseFloat(dialogStyle.borderTopWidth) || 0) - (Number.parseFloat(dialogStyle.borderBottomWidth) || 0));
    await act(async () => callsFor(".class-card-expansion-dialog").at(-1).animation.finish());
    assert.equal(content.style.width, "");
    assert.equal(content.style.height, "");
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
