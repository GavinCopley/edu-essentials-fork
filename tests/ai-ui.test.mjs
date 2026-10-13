import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";
const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/assistant" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Assistant } = await import(await clientModule("app/academic-assistant.tsx"));
const node = document.getElementById("root");
async function click(label) {
  const button = [...node.querySelectorAll("button")].find(b => b.textContent.trim() === label);
  assert.ok(button, `Missing ${label}`); await act(async () => button.click());
}
test("assistant previews require an explicit Apply and display only confirmed receipts", async () => {
  let applied = 0, fail = true;
  const proposal = { id: "proposal", status: "pending", preview: { timezone: "America/Los_Angeles", warnings: [], courseLabels: { calc: "Calculus II" }, changes: [{ after: { title: "Practice", courseId: "calc", dateKey: "2026-09-24", time: "13:00", durationMinutes: 60 } }] } };
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers["x-profile-id"], "test-profile");
    if (url.endsWith("/access")) return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
    if (url.endsWith("/conversations")) return Response.json({ conversations: [{ id: "conv", title: "Synthetic plan" }] });
    if (url.includes("messages?")) return Response.json({ messages: [{ id: "message", question: "Plan study", status: "complete", created_at: "2026-09-18T12:00:00Z", result: { answer: { blocks: [{ kind: "recommendation", text: "Review this proposed study block.", citations: [] }] }, citations: [], proposalId: "proposal" } }] });
    if (url.includes("proposals?")) return Response.json(proposal);
    throw new Error(`Unexpected request ${url}`);
  };
  const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(Assistant, { profileId: "test-profile", experimental: false, prepare: async () => {}, apply: async () => { applied++; if (fail) throw new Error("Workspace changed. Request a new preview."); proposal.status = "applied"; proposal.receipt = { appliedAt: "2026-09-18T12:01:00Z" }; } })));
    await click("Synthetic plan"); await click("Review proposed changes");
    assert.equal(applied, 0); assert.match(node.textContent, /Calculus II/); assert.match(node.textContent, /60 minutes/);
    await click("Apply changes"); assert.equal(applied, 1);
    assert.match(node.textContent, /Workspace changed/); assert.doesNotMatch(node.textContent, /Saved successfully/);
    fail = false; await click("Apply changes");
    assert.equal(applied, 2); assert.match(node.textContent, /Saved successfully/);
    assert.ok(![...node.querySelectorAll("button")].some(b => b.textContent === "Apply changes"));
  } finally { await act(async () => root.unmount()); }
});
test("failed workspace flush preserves the question and never sends it to the assistant", async () => {
  let posts = 0;
  globalThis.fetch = async (url, init) => { if (init.method === "POST") posts++; return Response.json(url.endsWith("/access") ? { eligible: true, enabled: true, mode: "synthetic" } : { conversations: [] }); };
  const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(Assistant, { profileId: "test-profile", experimental: false, prepare: async () => { throw new Error("Save your workspace first."); }, apply: async () => {} })));
    await click("What assignments are due this week?"); await click("Send");
    assert.equal(posts, 0); assert.match(node.textContent, /Save your workspace first/);
    assert.equal(node.querySelector("textarea").value, "What assignments are due this week?");
  } finally { await act(async () => root.unmount()); }
});

function mockAssistantApi({ access = { eligible: true, enabled: true, mode: "synthetic" }, events = [] } = {}) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const request = {
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    events.push({ type: "request", ...request });
    if (request.url.endsWith("/access") && request.method === "GET") return Response.json(access);
    if (request.url.endsWith("/access") && request.method === "POST") return Response.json({ enabled: true });
    if (request.url.endsWith("/conversations") && request.method === "GET") return Response.json({ conversations: [] });
    if (request.url.endsWith("/conversations") && request.method === "POST") {
      return Response.json({ id: "conversation-1", title: request.body.title });
    }
    if (request.url.includes("/messages?") && request.method === "GET") return Response.json({ messages: [] });
    if (request.url.endsWith("/messages") && request.method === "POST") return Response.json({ accepted: true });
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  };
  return requests;
}

async function mountAssistant(props, strict = false) {
  node.replaceChildren();
  const root = createRoot(node);
  const assistant = createElement(Assistant, {
    profileId: "test-profile",
    experimental: false,
    prepare: async () => {},
    apply: async () => {},
    ...props,
  });
  await act(async () => root.render(strict ? createElement(StrictMode, null, assistant) : assistant));
  return root;
}

async function rerenderAssistant(root, props, strict = false) {
  const assistant = createElement(Assistant, {
    profileId: "test-profile",
    experimental: false,
    prepare: async () => {},
    apply: async () => {},
    ...props,
  });
  await act(async () => root.render(strict ? createElement(StrictMode, null, assistant) : assistant));
}

async function unmountAssistant(root) {
  await act(async () => root.unmount());
  node.replaceChildren();
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.ok(predicate(), message);
}

test("dashboard quick ask sends exactly once after prepare under StrictMode and rerenders", async () => {
  const events = [];
  const requests = mockAssistantApi({ events });
  const consumed = [];
  const question = "Help me plan my week.";
  const prompt = { id: "quick-ask-1", question, send: true };
  let releasePrepare;
  const prepareGate = new Promise((resolve) => { releasePrepare = resolve; });
  const prepare = async () => { events.push({ type: "prepare-start" }); await prepareGate; events.push({ type: "prepare-complete" }); };
  let root;
  try {
    root = await mountAssistant({ initialPrompt: prompt, onPromptConsumed: (id) => consumed.push(id), prepare }, true);
    await rerenderAssistant(root, { initialPrompt: prompt, onPromptConsumed: (id) => consumed.push(id), prepare }, true);
    await eventually(() => events.some((event) => event.type === "prepare-start"), "quick ask did not prepare the workspace");
    assert.equal(requests.filter((request) => request.method === "POST").length, 0, "no POST can start while workspace prepare is pending");
    releasePrepare();
    await eventually(() => requests.some((request) => request.url.endsWith("/messages") && request.method === "POST"), "quick ask was not posted");
    await eventually(() => !node.querySelector('[role="status"]')?.textContent.includes("Reading your saved"), "quick ask remained in progress");

    const posts = requests.filter((request) => request.method === "POST");
    assert.equal(posts.filter((request) => request.url.endsWith("/conversations")).length, 1);
    const messagePosts = posts.filter((request) => request.url.endsWith("/messages"));
    assert.equal(messagePosts.length, 1);
    assert.equal(messagePosts[0].body.message, question);
    assert.equal(posts[0].url.endsWith("/conversations"), true);
    assert.ok(events.findIndex((event) => event.type === "prepare-complete") < events.findIndex((event) => event.type === "request" && event.method === "POST"), "workspace prepare must finish before the first POST");
    assert.deepEqual(consumed, [prompt.id]);
  } finally { if (root) await unmountAssistant(root); }
});

test("quick ask waits for valid consent and then sends its retained question once", async () => {
  const requests = mockAssistantApi({ access: { eligible: true, enabled: false, mode: "synthetic" } });
  const question = "Find my next deadline.";
  const prompt = { id: "consent-quick-ask", question, send: true };
  let root;
  try {
    root = await mountAssistant({ initialPrompt: prompt });
    await eventually(() => node.querySelector(".assistant-consent"), "consent form did not appear");
    assert.equal(requests.filter((request) => request.method === "POST").length, 0);

    await click("Enable assistant");
    assert.equal(requests.filter((request) => request.method === "POST").length, 0, "consent cannot be enabled without the attestations");
    const boxes = [...node.querySelectorAll('.assistant-consent input[type="checkbox"]')];
    assert.equal(boxes.length, 2);
    await act(async () => boxes.forEach((box) => box.click()));
    await click("Enable assistant");
    await eventually(() => requests.some((request) => request.url.endsWith("/messages") && request.method === "POST"), "consented quick ask was not posted");

    const posts = requests.filter((request) => request.method === "POST");
    assert.deepEqual(posts.filter((request) => request.url.endsWith("/access")).map((request) => request.body), [
      { enabled: true, adultConfirmed: true, syntheticConfirmed: true },
    ]);
    assert.equal(posts.filter((request) => request.url.endsWith("/conversations")).length, 1);
    const messagePosts = posts.filter((request) => request.url.endsWith("/messages"));
    assert.equal(messagePosts.length, 1);
    assert.equal(messagePosts[0].body.message, question);
  } finally { if (root) await unmountAssistant(root); }
});

test("draft-only dashboard prompt prefills the composer without an automatic POST", async () => {
  const requests = mockAssistantApi();
  const consumed = [];
  const prompt = { id: "draft-only", question: "Keep this as a draft.", send: false };
  let root;
  try {
    root = await mountAssistant({ initialPrompt: prompt, onPromptConsumed: (id) => consumed.push(id) }, true);
    await eventually(() => node.querySelector("#assistant-message"), "assistant composer did not appear");
    await rerenderAssistant(root, { initialPrompt: prompt, onPromptConsumed: (id) => consumed.push(id) }, true);
    assert.equal(node.querySelector("#assistant-message").value, prompt.question);
    assert.deepEqual(consumed, [prompt.id]);
    assert.equal(requests.filter((request) => request.method === "POST").length, 0);
  } finally { if (root) await unmountAssistant(root); }
});

test("failed automatic prepare keeps the quick ask draft for a manual retry", async () => {
  const requests = mockAssistantApi();
  const question = "Review my saved tasks.";
  let prepares = 0;
  const prepare = async () => {
    prepares++;
    if (prepares === 1) throw new Error("Save your workspace first.");
  };
  let root;
  try {
    root = await mountAssistant({ initialPrompt: { id: "prepare-retry", question, send: true }, prepare });
    await eventually(() => node.querySelector('[role="alert"]')?.textContent.includes("Save your workspace first"), "prepare failure was not shown");
    assert.equal(requests.filter((request) => request.method === "POST").length, 0);
    assert.equal(node.querySelector("#assistant-message").value, question);

    await click("Send");
    await eventually(() => requests.some((request) => request.url.endsWith("/messages") && request.method === "POST"), "manual retry did not post the retained question");
    assert.equal(prepares, 2);
    const posts = requests.filter((request) => request.method === "POST");
    assert.equal(posts.filter((request) => request.url.endsWith("/conversations")).length, 1);
    assert.equal(posts.filter((request) => request.url.endsWith("/messages")).length, 1);
    assert.equal(posts.find((request) => request.url.endsWith("/messages")).body.message, question);
    assert.equal(node.querySelector("#assistant-message").value, "");
  } finally { if (root) await unmountAssistant(root); }
});

test("experimental and ineligible assistant states never auto-send a dashboard prompt", async (t) => {
  for (const scenario of [
    { name: "experimental", access: { eligible: true, enabled: true, mode: "synthetic" }, experimental: true },
    { name: "ineligible", access: { eligible: false, enabled: true, mode: "synthetic" }, experimental: false },
  ]) {
    await t.test(scenario.name, async () => {
      const requests = mockAssistantApi({ access: scenario.access });
      const consumed = [];
      let root;
      try {
        root = await mountAssistant({
          initialPrompt: { id: `blocked-${scenario.name}`, question: "Find my next deadline.", send: true },
          experimental: scenario.experimental,
          onPromptConsumed: (id) => consumed.push(id),
        });
        await eventually(() => node.querySelector('[role="status"]') === null, "assistant access check did not settle");
        await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
        assert.equal(requests.filter((request) => request.method === "POST").length, 0);
        assert.deepEqual(consumed, []);
      } finally { if (root) await unmountAssistant(root); }
    });
  }
});
test("pilot consent explains synthetic-only use and requires both attestations", async () => {
  let payload;
  globalThis.fetch = async (url, init) => { if (init.method === "POST") payload = JSON.parse(init.body); return Response.json(url.endsWith("/access") ? { eligible: true, enabled: false, mode: "synthetic" } : { conversations: [] }); };
  const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(Assistant, { profileId: "test-profile", experimental: false, prepare: async () => {}, apply: async () => {} })));
    assert.match(node.textContent, /fictional academic data/);
    const boxes = [...node.querySelectorAll('input[type="checkbox"]')];
    assert.equal(boxes.length, 2); assert.ok(boxes.every(b => b.required));
    await click("Enable assistant"); assert.equal(payload, undefined);
    await act(async () => boxes.forEach(b => b.click())); await click("Enable assistant");
    assert.deepEqual(payload, { enabled: true, adultConfirmed: true, syntheticConfirmed: true });
  } finally { await act(async () => root.unmount()); }
});
