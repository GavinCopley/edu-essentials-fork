import { createElement } from "react";
import { createRoot } from "react-dom/client";
import Workspace from "../../app/workspace-client";
import { validateProfile } from "../../lib/profile";

type RequestRecord = { url: string; method: string; profileId: string; headers: Record<string, string> };

const PROFILE_ID = "b1000000-0000-4000-8000-000000000001";
const COURSE_ID = "b2000000-0000-4000-8000-000000000001";
const COURSE_FOLDER_ID = "b3000000-0000-4000-8000-000000000001";
const LAB_FOLDER_ID = "b3000000-0000-4000-8000-000000000002";
const MATERIALS_FOLDER_ID = "b3000000-0000-4000-8000-000000000003";
const REFERENCES_FOLDER_ID = "b3000000-0000-4000-8000-000000000004";
const NOTES_ID = "b4000000-0000-4000-8000-000000000001";
const STUDY_PLAN_ID = "b4000000-0000-4000-8000-000000000002";
const BUILD_LOG_ID = "b4000000-0000-4000-8000-000000000003";
const REVIEW_PDF_ID = "b4000000-0000-4000-8000-000000000004";
const DIAGRAM_ID = "b4000000-0000-4000-8000-000000000005";
const CHECKLIST_ID = "b4000000-0000-4000-8000-000000000006";
const STAMP = "2026-10-09T12:00:00.000Z";
const NOTE_CONTENT = [
  "Computer Engineering — Digital Systems",
  "",
  "Week 4: finite state machines",
  "• Separate state, next-state logic, and outputs.",
  "• Verify reset behavior before testing transitions.",
  "Reference: FPGA lab review, section 3.2.",
].join("\n");
const STUDY_PLAN_CONTENT = [
  "CPE 281 study plan",
  "Monday: review sequential logic",
  "Wednesday: finish the FPGA test bench",
  "Friday: prepare for the design review",
].join("\n");
const BUILD_LOG_CONTENT = [
  "FPGA lab build log",
  "Target: Arty A7 development board",
  "Synthesis: 0 errors, 2 timing warnings",
  "Next: verify reset and enable paths in hardware.",
].join("\n");
const REVIEW_PDF_CONTENT = "Logic design review: finite-state-machine timing, reset behavior, and next-state coverage.";
const DIAGRAM_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" rx="18" fill="#10233d"/>
  <g fill="#18385d" stroke="#87aef0" stroke-width="3">
    <circle cx="170" cy="180" r="64"/><circle cx="470" cy="180" r="64"/>
  </g>
  <g fill="#e6efff" font-family="Arial,sans-serif" font-size="22" text-anchor="middle">
    <text x="170" y="176">IDLE</text><text x="170" y="204">S0</text>
    <text x="470" y="176">RUN</text><text x="470" y="204">S1</text>
  </g>
  <path d="M238 160h142m-13-14 14 14-14 14" fill="none" stroke="#9ad8ff" stroke-width="4"/>
  <text x="310" y="142" fill="#c3d5f4" font-family="Arial,sans-serif" font-size="17" text-anchor="middle">start</text>
  <path d="M402 236H240m13 14-14-14 14-14" fill="none" stroke="#f0ca83" stroke-width="4"/>
  <text x="320" y="274" fill="#d9c89e" font-family="Arial,sans-serif" font-size="17" text-anchor="middle">reset</text>
</svg>`;

function makePdf(text: string): Uint8Array {
  const safeText = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 14 Tf 50 700 Td (${safeText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

function appendUint16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function appendUint32(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeMinimalDocx(): Uint8Array {
  const encoder = new TextEncoder();
  const entries = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>FPGA lab verification checklist</w:t></w:r></w:p><w:p><w:r><w:t>Confirm reset, enable, and state-transition behavior on the board.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`],
  ].map(([name, contents]) => ({ name: String(name), nameBytes: encoder.encode(String(name)), data: encoder.encode(String(contents)) }));
  const local: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const crc = crc32(entry.data);
    const offset = local.length;
    local.push(0x50, 0x4b, 0x03, 0x04);
    appendUint16(local, 20); appendUint16(local, 0x0800); appendUint16(local, 0);
    appendUint16(local, 0); appendUint16(local, 0); appendUint32(local, crc);
    appendUint32(local, entry.data.length); appendUint32(local, entry.data.length);
    appendUint16(local, entry.nameBytes.length); appendUint16(local, 0);
    local.push(...entry.nameBytes, ...entry.data);

    central.push(0x50, 0x4b, 0x01, 0x02);
    appendUint16(central, 20); appendUint16(central, 20); appendUint16(central, 0x0800);
    appendUint16(central, 0); appendUint16(central, 0); appendUint16(central, 0);
    appendUint32(central, crc); appendUint32(central, entry.data.length); appendUint32(central, entry.data.length);
    appendUint16(central, entry.nameBytes.length); appendUint16(central, 0); appendUint16(central, 0);
    appendUint16(central, 0); appendUint16(central, 0); appendUint32(central, 0); appendUint32(central, offset);
    central.push(...entry.nameBytes);
  }
  const end: number[] = [0x50, 0x4b, 0x05, 0x06];
  appendUint16(end, 0); appendUint16(end, 0);
  appendUint16(end, entries.length); appendUint16(end, entries.length);
  appendUint32(end, central.length); appendUint32(end, local.length); appendUint16(end, 0);
  return new Uint8Array([...local, ...central, ...end]);
}

const REVIEW_PDF = makePdf(REVIEW_PDF_CONTENT);
const OFFICE_DOCX = makeMinimalDocx();

const query = new URLSearchParams(window.location.search);
const scenarioValue = query.get("scenario");
const scenario = ["empty", "populated", "rich-grid", "legacy-list"].includes(scenarioValue ?? "") ? scenarioValue! : "populated";
const profile = {
  ...validateProfile({ display_name: "Johan", major: "comp eng", school_type: "college", university: "" }),
  id: PROFILE_ID,
  auth_user_id: "codex-reference-fixture-user",
  email: "johan@example.invalid",
  avatar_url: null,
  initialized: true,
  updated_at: STAMP,
  onboarding_completed_at: "2026-09-01T00:00:00.000Z",
};
const course = {
  id: COURSE_ID,
  code: "CPE 281",
  name: "Computer Engineering",
  credits: 4,
  instructor: "Dr. Example",
  room: "Engineering 210",
  color: "#38a6ed",
  soft: "#38a6ed25",
  initials: "CE",
};
const dashboardStorageKey = `files-reference-dashboard:${scenario}`;
const storedDashboard = window.sessionStorage.getItem(dashboardStorageKey);
let dashboard = storedDashboard ? JSON.parse(storedDashboard) : {
  v: 1,
  a: "my-day",
  w: [["my-day", "My Day", []]],
  n: "",
  d: {
    assignments: [],
    manualEvents: [],
    dashboardView: "cards",
    calendarView: "month",
    ...(scenario === "legacy-list" ? { filePreferences: { filter: "all", view: "list", sortBy: "name" } } : {}),
  },
};

function makeFolder(id: string, name: string, parentId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id,
    parent_id: parentId,
    name,
    kind: "custom",
    course_id: null,
    course_code: null,
    revision: 1,
    created_at: STAMP,
    updated_at: STAMP,
    archived_at: null,
    semester_label: null,
    course_name_snapshot: null,
    course_color_snapshot: null,
    trashed_at: null,
    trash_operation_id: null,
    original_parent_id: null,
    ...overrides,
  };
}

type FixtureFile = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  course_id: string | null;
  assignment_id: string | null;
  kind: string;
  state: string;
  created_at: string;
  updated_at: string;
  content_sha256: string | null;
  folder_id: string | null;
  content_backend: string;
  metadata_revision: number;
  content_revision: number;
  trashed_at: string | null;
  trash_operation_id: string | null;
  original_folder_id: string | null;
};

function makeFile(id: string, name: string, folderId: string | null, body: string | Uint8Array, mimeType = "text/plain"): FixtureFile {
  return {
    id,
    name,
    mime_type: mimeType,
    size_bytes: typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength,
    course_id: folderId === COURSE_FOLDER_ID || folderId === LAB_FOLDER_ID ? COURSE_ID : null,
    assignment_id: null,
    kind: "resource",
    state: "ready",
    created_at: STAMP,
    updated_at: STAMP,
    content_sha256: null,
    folder_id: folderId,
    content_backend: "object",
    metadata_revision: 1,
    content_revision: 1,
    trashed_at: null,
    trash_operation_id: null,
    original_folder_id: null,
  };
}

let folders = scenario === "populated" || scenario === "rich-grid"
  ? [
      makeFolder(COURSE_FOLDER_ID, course.code, null, { kind: "course", course_id: COURSE_ID, course_code: course.code }),
      makeFolder(LAB_FOLDER_ID, "FPGA lab", COURSE_FOLDER_ID),
      ...(scenario === "rich-grid" ? [
        makeFolder(MATERIALS_FOLDER_ID, "Study materials", null),
        makeFolder(REFERENCES_FOLDER_ID, "Lab references", null),
      ] : []),
    ]
  : [];
let files = scenario === "populated"
  ? [
      { ...makeFile(NOTES_ID, "Digital systems notes.txt", null, NOTE_CONTENT), course_id: COURSE_ID },
      makeFile(STUDY_PLAN_ID, "CPE 281 study plan.txt", null, STUDY_PLAN_CONTENT),
    ]
  : scenario === "rich-grid"
    ? [
        { ...makeFile(NOTES_ID, "Digital systems notes.txt", null, NOTE_CONTENT), course_id: COURSE_ID },
        makeFile(STUDY_PLAN_ID, "CPE 281 study plan.txt", null, STUDY_PLAN_CONTENT),
        { ...makeFile(BUILD_LOG_ID, "FPGA build log.txt", null, BUILD_LOG_CONTENT), course_id: COURSE_ID },
        { ...makeFile(REVIEW_PDF_ID, "Logic design review.pdf", null, REVIEW_PDF, "application/pdf"), course_id: COURSE_ID },
        { ...makeFile(DIAGRAM_ID, "FSM transition diagram.svg", null, DIAGRAM_CONTENT, "image/svg+xml"), course_id: COURSE_ID },
        { ...makeFile(CHECKLIST_ID, "Lab checklist.docx", null, OFFICE_DOCX, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), course_id: COURSE_ID },
      ]
    : scenario === "legacy-list"
      ? [makeFile(REVIEW_PDF_ID, "Logic design review.pdf", null, REVIEW_PDF, "application/pdf")]
      : [];
const fileBodies = new Map<string, string | Uint8Array>([
  [NOTES_ID, NOTE_CONTENT],
  [STUDY_PLAN_ID, STUDY_PLAN_CONTENT],
  [BUILD_LOG_ID, BUILD_LOG_CONTENT],
  [REVIEW_PDF_ID, REVIEW_PDF],
  [DIAGRAM_ID, DIAGRAM_CONTENT],
  [CHECKLIST_ID, OFFICE_DOCX],
]);
const nativeBodies = new Map<string, string>();
const lastOpened = new Map<string, string>();
const requests: RequestRecord[] = [];
let revision = STAMP;
let folderSequence = 10;
let workspaceWrites = 0;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function activityPayload() {
  return {
    files: [...lastOpened.entries()].map(([file_id, last_opened_at]) => ({ file_id, starred_at: null, last_opened_at })),
    folders: [],
  };
}

function documentResult(file: (typeof files)[number], body: string, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    file: { ...file },
    document: { file_id: file.id, body, content_revision: file.content_revision },
  };
}

globalThis.fetch = async (input, init = {}) => {
  const urlText = String(input);
  const url = new URL(urlText, window.location.origin);
  const method = init.method ?? "GET";
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const profileId = headers["x-profile-id"] ?? "";
  requests.push({ url: `${url.pathname}${url.search}`, method, profileId, headers });

  if (url.pathname === "/api/workspace") {
    if (method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}"));
      dashboard = body.dashboard;
      window.sessionStorage.setItem(dashboardStorageKey, JSON.stringify(dashboard));
      revision = new Date(Date.parse(revision) + 1000).toISOString();
      workspaceWrites += 1;
      return json({ ok: true, revision });
    }
    return json({ initialized: true, courses: [course], dashboard, revision, profile });
  }

  if (url.pathname === "/api/file-folders" && method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}")) as { id: string; name: string; parentId: string | null };
    const folder = makeFolder(body.id || `b3000000-0000-4000-8000-${String(folderSequence++).padStart(12, "0")}`, body.name, body.parentId);
    folders = [...folders, folder];
    return json({ folder }, 201);
  }

  if (url.pathname === "/api/file-folders") {
    const view = url.searchParams.get("view") ?? "active";
    const visible = view === "active" ? folders.filter((folder) => !folder.archived_at && !folder.trashed_at) : [];
    return json({ folders: visible, activities: { folders: [] } });
  }

  if (url.pathname === "/api/files/actions" && method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}")) as { items?: { id: string }[] };
    for (const item of body.items ?? []) lastOpened.set(item.id, STAMP);
    return json({ activities: activityPayload() });
  }

  if (url.pathname === "/api/files" && url.searchParams.has("id") && method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    const file = files.find((item) => item.id === id);
    const body = nativeBodies.get(id) ?? fileBodies.get(id);
    if (!file || body === undefined) return json({ error: "Fixture file content not found." }, 404);
    const responseBody: BodyInit = typeof body === "string" ? body : new Uint8Array(body).buffer;
    return new Response(responseBody, { headers: { "content-type": file.mime_type } });
  }

  if (url.pathname === "/api/file-documents" && method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}")) as { id: string; name: string; courseId: string; assignmentId: string; folderId: string | null; body: string };
    const file = {
      ...makeFile(body.id, body.name, body.folderId, body.body),
      course_id: body.courseId || null,
      assignment_id: body.assignmentId || null,
      content_backend: "native-text",
    };
    files = [file, ...files.filter((item) => item.id !== file.id)];
    nativeBodies.set(file.id, body.body);
    return json(documentResult(file, body.body));
  }

  if (url.pathname === "/api/file-documents" && url.searchParams.has("id")) {
    const id = url.searchParams.get("id") ?? "";
    const file = files.find((item) => item.id === id);
    const savedBody = nativeBodies.get(id);
    if (!file || savedBody === undefined) return json({ error: "Native document not found." }, 404);
    if (method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}")) as { body: string; name?: string; requestId: string };
      nativeBodies.set(id, body.body);
      const renamed = body.name !== undefined && body.name !== file.name;
      file.name = body.name ?? file.name;
      file.size_bytes = new TextEncoder().encode(body.body).byteLength;
      if (renamed) file.metadata_revision += 1;
      file.content_revision += 1;
      file.updated_at = new Date(Date.parse(file.updated_at) + 1000).toISOString();
      return json(documentResult(file, body.body, { requestId: body.requestId, acknowledgedContentRevision: file.content_revision }));
    }
    return json(documentResult(file, savedBody));
  }

  if (url.pathname === "/api/files") {
    const view = url.searchParams.get("view") ?? "all";
    const rows = view === "trash" ? [] : files.filter((file) => !file.trashed_at);
    return json({ files: rows, activities: { files: activityPayload().files, folders: [] } });
  }

  return json({ error: `Unexpected browser fixture request: ${method} ${url.pathname}${url.search}` }, 404);
};

declare global {
  interface Window {
    __filesReferenceFixture: {
      scenario: string;
      profile: typeof profile;
      get dashboard(): typeof dashboard;
      requests: RequestRecord[];
      get folders(): typeof folders;
      get files(): typeof files;
      get workspaceWrites(): number;
    };
  }
}

window.__filesReferenceFixture = {
  scenario,
  profile,
  get dashboard() { return structuredClone(dashboard); },
  requests,
  get folders() { return structuredClone(folders); },
  get files() { return structuredClone(files); },
  get workspaceWrites() { return workspaceWrites; },
};

const root = document.getElementById("root");
if (!root) throw new Error("The Files reference fixture requires #root.");
createRoot(root).render(createElement(Workspace, { initialProfile: profile, filesBrowserEnabled: true }));
