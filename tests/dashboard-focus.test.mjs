import assert from "node:assert/strict";
import test from "node:test";
import { clientModule } from "./helpers/client-modules.mjs";
const { dashboardFocus } = await import(await clientModule("lib/dashboard-focus.ts"));
test("dashboard prioritizes incomplete work by deadline with undated work last", () => {
  const assignments = [
    { id: "undated", title: "Reading", dateKey: "", status: "later" },
    { id: "late", title: "Essay", dateKey: "2026-10-09", status: "overdue" },
    { id: "done", title: "Finished", dateKey: "2026-10-08", status: "done" },
    { id: "today", title: "Lab", dateKey: "2026-10-11", dueTime: "09:00", status: "today" },
    { id: "end-of-day", title: "Quiz", dateKey: "2026-10-11", status: "today" },
  ];
  assert.deepEqual(dashboardFocus(assignments).map((item) => item.id), ["late", "today", "end-of-day", "undated"]);
  assert.equal(assignments[0].id, "undated");
  assert.deepEqual(dashboardFocus([{ ...assignments[2] }]), []);
});
