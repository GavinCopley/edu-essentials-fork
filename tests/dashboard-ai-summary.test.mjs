import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/dashboard" });
for (const name of ["window", "document", "HTMLElement"]) globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DashboardAiSummary } = await import(await clientModule("app/dashboard-ai-summary.tsx"));
const node = document.getElementById("root");
let root;

const props = (overrides = {}) => ({
  profileId: "test-profile",
  prepare: async () => {},
  experimental: false,
  snapshotKey: "snapshot-1",
  onOpenAssistant: () => {},
  ...overrides,
});

async function mount(componentProps = props()) {
  root = createRoot(node);
  await act(async () => root.render(createElement(DashboardAiSummary, componentProps)));
}

async function click(label) {
  const button = [...node.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === label);
  assert.ok(button, `Missing ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function expandDetails(label) {
  const summary = [...node.querySelectorAll("details summary")].find((candidate) => candidate.textContent.trim() === label);
  assert.ok(summary, `Missing source ${label}`);
  await act(async () => {
    summary.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function collapseDetails(label) {
  const summary = [...node.querySelectorAll("details summary")].find((candidate) => candidate.textContent.trim() === label);
  assert.ok(summary, `Missing source ${label}`);
  await act(async () => {
    summary.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function unmount() {
  if (root) await act(async () => root.unmount());
  root = null;
  node.replaceChildren();
}

test("does not prepare, create conversations, or generate on mount", async () => {
  const requests = [];
  let prepared = 0;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
  };
  try {
    await mount(props({ prepare: async () => { prepared += 1; } }));
    assert.equal(prepared, 0);
    assert.deepEqual(requests.map(({ url }) => url), ["/api/ai/access"]);
    assert.equal(node.querySelector("h1").id, "dashboard-summary-title");
    assert.match(node.textContent, /A clear place to start\./);
  } finally { await unmount(); }
});

test("routes the generate CTA to assistant setup when access is not enabled", async () => {
  let opens = 0;
  let prepared = 0;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ eligible: true, enabled: false, mode: "synthetic" });
  };
  try {
    await mount(props({ onOpenAssistant: () => { opens += 1; }, prepare: async () => { prepared += 1; } }));
    await click("Generate AI summary");
    assert.equal(opens, 1);
    assert.equal(prepared, 0);
    assert.deepEqual(requests.map(({ url }) => url), ["/api/ai/access"]);
  } finally { await unmount(); }
});

test("surfaces prepare failures without creating a conversation or sending a message", async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
  };
  try {
    await mount(props({ prepare: async () => { throw new Error("Save your workspace first."); } }));
    await click("Generate AI summary");
    assert.match(node.querySelector('[role="alert"]').textContent, /Save your workspace first/);
    assert.equal(requests.some(({ init }) => init.method === "POST"), false);
    assert.ok([...node.querySelectorAll("button")].some((button) => button.textContent.trim() === "Generate AI summary"));
    assert.ok([...node.querySelectorAll("button")].some((button) => button.textContent.trim() === "Try again"));
  } finally { await unmount(); }
});

test("generates advice with profile headers and renders matching answer citations", async () => {
  const requests = [];
  let messageBody;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers["x-profile-id"], "test-profile");
    if (url.endsWith("/access")) return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
    if (url.endsWith("/conversations")) {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { title: "AI study brief" });
      return Response.json({ id: "conversation-1", title: "AI study brief" });
    }
    if (url.endsWith("/messages")) {
      assert.equal(init.method, "POST");
      messageBody = JSON.parse(init.body);
      return Response.json({ id: messageBody.requestId, status: "complete", result: {
        answer: { blocks: [{ kind: "recommendation", text: "Start with the lab report due tomorrow.", citations: ["assignment-source"] }] },
        citations: [{ id: "assignment-source", label: "Chemistry lab report", text: "Due tomorrow at 11:59 PM.", kind: "record", historical: true }],
        proposalId: "must-not-render",
        revision: "snapshot-1",
      } });
    }
    if (url.includes("/citations?")) {
      const citationUrl = new URL(url, "https://edu.example");
      assert.equal(citationUrl.searchParams.get("messageId"), messageBody.requestId);
      assert.equal(citationUrl.searchParams.get("id"), "assignment-source");
      return Response.json({ id: "assignment-source", label: "Chemistry lab report", text: "Due tomorrow at 11:59 PM.", kind: "record", historical: true });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    await mount();
    await click("Generate AI summary");
    assert.equal(messageBody.conversationId, "conversation-1");
    assert.match(messageBody.requestId, /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
    assert.match(messageBody.message, /outstanding assignments/);
    assert.match(messageBody.message, /advice only/i);
    assert.match(messageBody.message, /do not create proposals/i);
    assert.match(node.textContent, /Start with the lab report due tomorrow/);
    const citation = node.querySelector("details.dashboard-summary-citation");
    assert.equal(citation.querySelector("summary").textContent, "Chemistry lab report");
    assert.doesNotMatch(citation.textContent, /Due tomorrow at 11:59 PM/);
    await expandDetails("Chemistry lab report");
    assert.match(citation.textContent, /Due tomorrow at 11:59 PM/);
    assert.match(citation.textContent, /saved revision used for that answer/);
    assert.doesNotMatch(node.textContent, /must-not-render/);
    assert.equal(requests.some(({ url }) => url.includes("messages?conversationId=")), false);
  } finally { await unmount(); }
});

test("shows unavailable citation state without exposing cached excerpt text", async () => {
  let messageBody;
  let citationRequest;
  let citationReads = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers["x-profile-id"], "test-profile");
    if (url.endsWith("/access")) return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
    if (url.endsWith("/conversations")) return Response.json({ id: "conversation-unavailable" });
    if (url.endsWith("/messages")) {
      messageBody = JSON.parse(init.body);
      return Response.json({ id: messageBody.requestId, status: "complete", result: {
        answer: { blocks: [{ kind: "fact", text: "A saved source supports this answer.", citations: ["removed-source"] }] },
        citations: [{ id: "removed-source", label: "Removed source", text: "Cached excerpt must never be shown.", kind: "document" }],
        proposalId: null,
      } });
    }
    if (url.includes("/citations?")) {
      citationRequest = new URL(url, "https://edu.example");
      citationReads += 1;
      if (citationReads === 1) return Response.json({ id: "removed-source", label: "Removed source", text: "Verified excerpt before exclusion.", kind: "document" });
      return Response.json({ unavailable: true, message: "This source was removed, excluded, or changed." });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    await mount();
    await click("Generate AI summary");
    const details = node.querySelector("details.dashboard-summary-citation");
    assert.ok(details);
    assert.doesNotMatch(details.textContent, /Cached excerpt must never be shown/);
    await expandDetails("Removed source");
    assert.match(details.textContent, /Verified excerpt before exclusion/);
    await collapseDetails("Removed source");
    await expandDetails("Removed source");
    assert.match(details.textContent, /This source was removed, excluded, or changed/);
    assert.equal(citationReads, 2);
    assert.doesNotMatch(details.textContent, /Verified excerpt before exclusion/);
    assert.doesNotMatch(details.textContent, /Cached excerpt must never be shown/);
    assert.equal(citationRequest.searchParams.get("messageId"), messageBody.requestId);
    assert.equal(citationRequest.searchParams.get("id"), "removed-source");
  } finally { await unmount(); }
});

test("polls a running POST for the exact request ID", async () => {
  const requests = [];
  let messageBody;
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/access")) return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
    if (url.endsWith("/conversations")) return Response.json({ id: "conversation-poll" });
    if (url.endsWith("/messages")) {
      messageBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: messageBody.requestId, status: "running" }), { status: 202 });
    }
    if (url.includes("messages?conversationId=conversation-poll")) {
      polls += 1;
      const messages = polls === 1
        ? [{ id: "other-request", status: "complete", result: { answer: { blocks: [{ kind: "general", text: "Wrong answer", citations: [] }] }, citations: [], proposalId: null } }]
        : [{ id: messageBody.requestId, status: "complete", result: { answer: { blocks: [{ kind: "general", text: "The matching answer.", citations: [] }] }, citations: [], proposalId: null } }];
      return Response.json({ messages });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    await mount();
    await click("Generate AI summary");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1050)));
    assert.equal(polls, 2);
    assert.match(node.textContent, /The matching answer\./);
    assert.doesNotMatch(node.textContent, /Wrong answer/);
  } finally { await unmount(); }
});

test("snapshot changes abort in-flight work and discard its eventual answer", async () => {
  const requests = [];
  let messageBody;
  let releaseMessagePost;
  let messageSignal;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/access")) return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
    if (url.endsWith("/conversations")) return Response.json({ id: "conversation-2" });
    if (url.endsWith("/messages")) {
      messageBody = JSON.parse(init.body);
      messageSignal = init.signal;
      return await new Promise((resolve) => { releaseMessagePost = resolve; });
    }
    if (url.includes("messages?conversationId=")) return Response.json({ messages: [{
      id: messageBody.requestId,
      status: "complete",
      result: { answer: { blocks: [{ kind: "general", text: "Stale answer", citations: [] }] }, citations: [], proposalId: null },
    }] });
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    await mount();
    await click("Generate AI summary");
    assert.ok(releaseMessagePost);
    const previous = root;
    await act(async () => previous.render(createElement(DashboardAiSummary, props({ snapshotKey: "snapshot-2" }))));
    assert.equal(messageSignal.aborted, true);
    assert.doesNotMatch(node.textContent, /Stale answer/);
    await act(async () => releaseMessagePost(Response.json({ id: messageBody.requestId, status: "complete" })));
    assert.doesNotMatch(node.textContent, /Stale answer/);
    assert.equal(requests.some(({ url }) => url.includes("messages?conversationId=")), false);
  } finally { await unmount(); }
});

test("returning to an earlier snapshot does not restore a canceled busy state", async () => {
  let releasePreparation;
  let preparations = 0;
  let posts = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/access")) return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
    posts += 1;
    throw new Error("No canceled generation should send academic context.");
  };
  const prepare = async () => {
    preparations += 1;
    if (preparations === 1) await new Promise((resolve) => { releasePreparation = resolve; });
    else throw new Error("Second preparation reached.");
  };
  try {
    await mount(props({ prepare }));
    await click("Generate AI summary");
    assert.match(node.textContent, /Preparing your workspace/);
    await act(async () => root.render(createElement(DashboardAiSummary, props({ prepare, snapshotKey: "snapshot-2" }))));
    await act(async () => root.render(createElement(DashboardAiSummary, props({ prepare }))));
    assert.equal([...node.querySelectorAll("button")].find((button) => button.textContent.trim() === "Generate AI summary").disabled, false);
    assert.doesNotMatch(node.textContent, /Preparing your workspace/);
    await click("Generate AI summary");
    assert.equal(preparations, 2);
    assert.match(node.textContent, /Second preparation reached/);
    await act(async () => releasePreparation());
    assert.equal(posts, 0);
    assert.doesNotMatch(node.textContent, /Preparing your workspace/);
  } finally { await unmount(); }
});

test("experimental mode explains the restriction and makes no AI requests", async () => {
  let requests = 0;
  let opens = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ eligible: true, enabled: true, mode: "synthetic" });
  };
  try {
    await mount(props({ experimental: true, onOpenAssistant: () => { opens += 1; } }));
    assert.equal(requests, 0);
    assert.match(node.textContent, /unavailable in experimental mode/);
    assert.equal([...node.querySelectorAll("button")].find((button) => button.textContent.trim() === "Generate AI summary").disabled, true);
    await click("Open assistant");
    assert.equal(opens, 1);
    assert.equal(requests, 0);
  } finally { await unmount(); }
});
