import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const SUMMARY = "I’d start with the work that needs your attention most, then give you a head start on the next deadline. Your week looks manageable—let’s take it one priority at a time.";
const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/dashboard" });
for (const name of ["window", "document", "HTMLElement"]) globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DashboardStudyBrief } = await import(await clientModule("app/dashboard-study-brief.tsx"));
const node = document.getElementById("root");
const props = {
  focusAssignments: [],
  overdueCount: 0,
  dueTodayCount: 0,
  completedThisWeek: 0,
  courseCount: 0,
  courseCodeFor: () => "",
  renderStatusBadge: () => null,
  onSelectAssignment() {},
  onAddAssignment() {},
  onAddClass() {},
  onOpenAssistant() {},
  onAskAssistant() {},
};
let root;

async function mount(overrides = {}) {
  root = createRoot(node);
  await act(async () => root.render(createElement(DashboardStudyBrief, { ...props, ...overrides })));
}

async function rerender(overrides = {}) {
  await act(async () => root.render(createElement(DashboardStudyBrief, { ...props, ...overrides })));
}

async function wait(milliseconds) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, milliseconds)));
}

async function unmount() {
  if (root) await act(async () => root.unmount());
  root = null;
  node.replaceChildren();
}

function animatedCopy() {
  return node.querySelector(".dashboard-study-copy-animated");
}

function assignments(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `assignment-${index + 1}`,
    title: `Assignment ${index + 1}`,
    courseId: "course-1",
    status: "overdue",
    dateKey: "2026-10-12",
    due: "Oct 12, 2026",
  }));
}

async function click(element) {
  await act(async () => element.click());
}

async function setInputValue(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function dispatchClick(element, detail) {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, detail });
  await act(async () => element.dispatchEvent(event));
  return event;
}

async function dispatchPointer(element, type, { pointerId = 1, pointerType = "touch", isPrimary = true, x = 0, y = 0 } = {}) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
    isPrimary: { value: isPrimary },
  });
  await act(async () => element.dispatchEvent(event));
  return event;
}

function priorityNumbers() {
  return [...node.querySelectorAll(".dashboard-focus-number")].map((number) => number.textContent);
}

test("types the sample summary with a caret, then completes without shifting its reserved copy", async () => {
  try {
    await mount();
    assert.equal(node.querySelector("#dashboard-summary-title").textContent, "Your study summary");
    assert.equal(animatedCopy().textContent, "");
    assert.ok(node.querySelector(".dashboard-study-caret"));
    assert.equal(node.querySelector(".dashboard-study-copy-reserve").textContent, SUMMARY);
    assert.equal(node.querySelector(".dashboard-study-screen-reader-copy").textContent, SUMMARY);
    assert.equal(animatedCopy().getAttribute("aria-hidden"), "true");

    await wait(500);
    assert.ok(animatedCopy().textContent.length > 0);
    assert.ok(animatedCopy().textContent.length < SUMMARY.length);
    assert.ok(node.querySelector(".dashboard-study-caret"));

    await wait(2200);
    assert.equal(animatedCopy().textContent, SUMMARY);
    assert.equal(node.querySelector(".dashboard-study-caret"), null);
  } finally { await unmount(); }
});

test("app reduced-motion preference renders the complete summary without typing", async () => {
  try {
    await mount({ reducedMotion: true });
    assert.equal(animatedCopy().textContent, SUMMARY);
    assert.equal(node.querySelector(".dashboard-study-caret"), null);
    await act(async () => root.render(createElement(DashboardStudyBrief, { ...props, reducedMotion: false })));
    assert.equal(animatedCopy().textContent, SUMMARY);
    assert.equal(node.querySelector(".dashboard-study-caret"), null);
  } finally { await unmount(); }
});

test("system reduced-motion preference skips typing and completes if enabled during typing", async () => {
  const originalMatchMedia = window.matchMedia;
  let listener;
  const preference = {
    matches: true,
    addEventListener(_type, callback) { listener = callback; },
    removeEventListener(_type, callback) { if (listener === callback) listener = undefined; },
  };
  window.matchMedia = () => preference;
  try {
    await mount();
    assert.equal(animatedCopy().textContent, SUMMARY);
    assert.equal(node.querySelector(".dashboard-study-caret"), null);
    await unmount();

    preference.matches = false;
    await mount();
    await wait(120);
    assert.ok(animatedCopy().textContent.length > 0);
    preference.matches = true;
    await act(async () => listener({ matches: true }));
    assert.equal(animatedCopy().textContent, SUMMARY);
    assert.equal(node.querySelector(".dashboard-study-caret"), null);
    preference.matches = false;
    await act(async () => listener({ matches: false }));
    assert.equal(animatedCopy().textContent, SUMMARY);
    assert.equal(node.querySelector(".dashboard-study-caret"), null);
  } finally {
    await unmount();
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  }
});

test("unmount clears the typing timer", async () => {
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  let callback;
  let cleared;
  window.setInterval = (nextCallback) => { callback = nextCallback; return 73; };
  window.clearInterval = (timer) => { cleared = timer; };
  try {
    await mount();
    assert.equal(typeof callback, "function");
    await unmount();
    assert.equal(cleared, 73);
    assert.equal(node.textContent, "");
  } finally {
    await unmount();
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
  }
});

test("submits a trimmed question, disables blank prompts, and keeps one separate assistant button", async () => {
  const submitted = [];
  let openCount = 0;
  let openDraft;
  try {
    await mount({
      reducedMotion: true,
      onAskAssistant: (question) => submitted.push(question),
      onOpenAssistant: (draft) => { openCount += 1; openDraft = draft; },
    });

    const form = node.querySelector(".dashboard-study-ask");
    const input = node.querySelector('[aria-label="Ask Edu AI"]');
    const sendButton = node.querySelector('[aria-label="Send question"]');
    const openButton = node.querySelector('[aria-label="Open assistant"]');
    assert.equal(input.placeholder, "Ask Edu AI…");
    assert.equal(input.maxLength, 8000);
    assert.equal(sendButton.disabled, true);
    assert.equal(node.querySelectorAll('[aria-label="Open assistant"]').length, 1);
    assert.equal(openButton.textContent, "");

    await setInputValue(input, "  \t ");
    assert.equal(sendButton.disabled, true);
    const blankSubmit = new window.Event("submit", { bubbles: true, cancelable: true });
    await act(async () => form.dispatchEvent(blankSubmit));
    assert.equal(blankSubmit.defaultPrevented, true);
    assert.deepEqual(submitted, []);

    await setInputValue(input, "  Help me plan my week.  ");
    assert.equal(sendButton.disabled, false);
    await act(async () => form.requestSubmit(sendButton));
    assert.deepEqual(submitted, ["Help me plan my week."]);
    assert.equal(input.value, "");
    assert.equal(sendButton.disabled, true);

    await setInputValue(input, "  Keep this as a draft  ");
    await click(openButton);
    assert.equal(openCount, 1);
    assert.equal(openDraft, "Keep this as a draft");
    assert.equal(input.value, "  Keep this as a draft  ");
    assert.deepEqual(submitted, ["Help me plan my week."]);
  } finally { await unmount(); }
});

test("keeps the question when navigation to the assistant is blocked", async () => {
  try {
    await mount({ reducedMotion: true, onAskAssistant: () => false });
    const input = node.querySelector('[aria-label="Ask Edu AI"]');
    await setInputValue(input, "Keep this question");
    await act(async () => node.querySelector(".dashboard-study-ask").requestSubmit());
    assert.equal(input.value, "Keep this question");
  } finally { await unmount(); }
});

test("shows two priorities per page with global numbering, working boundaries, and an unpaired final assignment", async () => {
  const focusAssignments = assignments(5);
  const selected = [];
  try {
    await mount({ focusAssignments, reducedMotion: true, onSelectAssignment: (assignment) => selected.push(assignment.id) });
    assert.deepEqual(priorityNumbers(), ["01", "02"]);
    assert.equal(node.querySelectorAll(".dashboard-focus-list > li").length, 2);
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "1–2 of 5");
    assert.equal(node.querySelector('[aria-label="Previous priorities"]').disabled, true);
    assert.equal(node.querySelector('[aria-label="Next priorities"]').disabled, false);

    await click(node.querySelector('[aria-label="Next priorities"]'));
    assert.deepEqual(priorityNumbers(), ["03", "04"]);
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "3–4 of 5");
    await click(node.querySelector(".dashboard-focus-item"));
    assert.deepEqual(selected, ["assignment-3"]);

    await click(node.querySelector('[aria-label="Next priorities"]'));
    assert.deepEqual(priorityNumbers(), ["05"]);
    assert.equal(node.querySelectorAll(".dashboard-focus-list > li").length, 1);
    assert.equal(node.querySelector(".dashboard-focus-list").getAttribute("start"), "5");
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "5 of 5");
    assert.equal(node.querySelector('[aria-label="Next priorities"]').disabled, true);

    await click(node.querySelector('[aria-label="Previous priorities"]'));
    assert.deepEqual(priorityNumbers(), ["03", "04"]);
    await click(node.querySelector('[aria-label="Previous priorities"]'));
    assert.equal(node.querySelector('[aria-label="Previous priorities"]').disabled, true);
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "1–2 of 5");
  } finally { await unmount(); }
});

test("resets paging when the ordered assignment IDs change, but preserves the page on an unchanged rerender", async () => {
  const focusAssignments = assignments(5);
  try {
    await mount({ focusAssignments, reducedMotion: true });
    await click(node.querySelector('[aria-label="Next priorities"]'));
    await click(node.querySelector('[aria-label="Next priorities"]'));
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "5 of 5");

    await rerender({ focusAssignments: [...focusAssignments] });
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "5 of 5");

    const reordered = [...focusAssignments].reverse();
    await rerender({ focusAssignments: reordered });
    assert.deepEqual(priorityNumbers(), ["01", "02"]);
    assert.equal(node.querySelector(".dashboard-focus-list").textContent.includes("Assignment 5"), true);
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "1–2 of 5");

    await click(node.querySelector('[aria-label="Next priorities"]'));
    await rerender({ focusAssignments: reordered.slice(0, 2) });
    assert.deepEqual(priorityNumbers(), ["01", "02"]);
    assert.equal(node.querySelector(".dashboard-focus-pagination"), null);
  } finally { await unmount(); }
});

test("touch swipes page priorities while vertical moves, canceled or multitouch gestures do not", async () => {
  const focusAssignments = assignments(5);
  const selected = [];
  try {
    await mount({ focusAssignments, reducedMotion: true, onSelectAssignment: (assignment) => selected.push(assignment.id) });
    const viewport = node.querySelector(".dashboard-focus-viewport");

    await dispatchPointer(viewport, "pointerdown", { x: 200, y: 100 });
    await dispatchPointer(viewport, "pointerup", { x: 210, y: 180 });
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "1–2 of 5");

    await dispatchPointer(viewport, "pointerdown", { x: 200, y: 100 });
    await dispatchPointer(viewport, "pointercancel", { x: 120, y: 100 });
    await dispatchPointer(viewport, "pointerup", { x: 120, y: 100 });
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "1–2 of 5");

    await dispatchPointer(viewport, "pointerdown", { x: 200, y: 100 });
    await dispatchPointer(viewport, "pointerdown", { pointerId: 2, isPrimary: false, x: 190, y: 100 });
    await dispatchPointer(viewport, "pointerup", { x: 120, y: 100 });
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "1–2 of 5");

    const tapTarget = node.querySelector(".dashboard-focus-item");
    await dispatchPointer(tapTarget, "pointerdown", { x: 100, y: 100 });
    await dispatchPointer(tapTarget, "pointerup", { x: 102, y: 101 });
    await click(tapTarget);
    assert.deepEqual(selected, ["assignment-1"]);

    await dispatchPointer(viewport, "pointerdown", { x: 220, y: 100 });
    await dispatchPointer(viewport, "pointerup", { x: 150, y: 105 });
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "3–4 of 5");
    const swipeClick = await dispatchClick(viewport, 1);
    assert.equal(swipeClick.defaultPrevented, true);
    assert.deepEqual(selected, ["assignment-1"]);

    await dispatchPointer(viewport, "pointerdown", { x: 150, y: 105 });
    await dispatchPointer(viewport, "pointerup", { x: 220, y: 100 });
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "1–2 of 5");

    await dispatchPointer(viewport, "pointerdown", { x: 220, y: 100 });
    await dispatchPointer(viewport, "pointerup", { x: 150, y: 105 });
    assert.equal(node.querySelector(".dashboard-focus-range").textContent, "3–4 of 5");
    const keyboardTarget = node.querySelector(".dashboard-focus-item");
    await act(async () => keyboardTarget.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const keyboardClick = await dispatchClick(keyboardTarget, 0);
    assert.equal(keyboardClick.defaultPrevented, false);
    assert.deepEqual(selected, ["assignment-1", "assignment-3"]);

    await dispatchPointer(keyboardTarget, "pointerdown", { pointerType: "mouse", x: 150, y: 100 });
    await dispatchPointer(keyboardTarget, "pointerup", { pointerType: "mouse", x: 150, y: 100 });
    const mouseClick = await dispatchClick(keyboardTarget, 1);
    assert.equal(mouseClick.defaultPrevented, false);
    assert.deepEqual(selected, ["assignment-1", "assignment-3", "assignment-3"]);
  } finally { await unmount(); }
});
