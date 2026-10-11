import { isFileId } from "./files";
import { createCustomFolder, type CreateCustomFolderInput } from "./files-browser-operations";
import { safeFileItemName, type FileFolder } from "./file-organization";

export type FolderUploadContext = {
  profileId: string;
  sessionGeneration: number;
  folderId: string | null;
  courseId: string | null;
};

export type FolderUploadFile = {
  file: File;
  relativePath: string;
  targetPath: string | null;
};

export type FolderUploadDirectory = {
  id: string;
  path: string;
  name: string;
  parentPath: string | null;
  created: boolean;
};

export type FolderUploadPlan = FolderUploadContext & {
  id: string;
  files: FolderUploadFile[];
  directories: FolderUploadDirectory[];
};

export type FolderUploadCreateFolder = typeof createCustomFolder;

export type FolderUploadHierarchyOptions = {
  signal?: AbortSignal;
  isCurrent: (profileId: string, sessionGeneration: number) => boolean;
  onCreated: (directory: FolderUploadDirectory, folder: FileFolder) => void;
  createFolder?: FolderUploadCreateFolder;
};

function fail(message: string): never {
  throw new Error(message);
}

function defaultIdFactory(): string {
  if (!globalThis.crypto?.randomUUID) fail("Secure IDs are unavailable for folder upload.");
  return globalThis.crypto.randomUUID();
}

function validateContext(context: FolderUploadContext): void {
  if (!context || typeof context !== "object" || !isFileId(context.profileId)) {
    fail("The signed-in account is unavailable. Sign in again before uploading a folder.");
  }
  if (!Number.isSafeInteger(context.sessionGeneration) || context.sessionGeneration < 0) {
    fail("The folder upload session is invalid. Reselect the folder before continuing.");
  }
  if (context.folderId !== null && !isFileId(context.folderId)) {
    fail("Choose a valid destination folder before uploading.");
  }
  if (context.courseId !== null && typeof context.courseId !== "string") {
    fail("The folder upload course is invalid. Reselect the folder before continuing.");
  }
}

function validatedPathSegments(relativePath: unknown): string[] {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.startsWith("/") || relativePath.includes("\\")) {
    fail("A selected file is missing a safe folder path. Reselect the folder before uploading.");
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      fail("A selected file has an unsafe folder path. Reselect the folder before uploading.");
    }
    let safeName: string;
    try {
      safeName = safeFileItemName(segment);
    } catch (error) {
      fail(error instanceof Error ? error.message : "A selected file has an unsafe folder path.");
    }
    if (safeName !== segment) fail("A selected file has a folder path that cannot be saved safely.");
  }
  return segments;
}

function allocateId(idFactory: () => string, usedIds: Set<string>): string {
  const id = idFactory();
  if (!isFileId(id) || usedIds.has(id)) fail("A safe folder upload ID could not be created.");
  usedIds.add(id);
  return id;
}

export function buildFolderUploadPlan(
  files: ArrayLike<File>,
  context: FolderUploadContext,
  idFactory: () => string = defaultIdFactory,
): FolderUploadPlan {
  validateContext(context);
  if (!files || !Number.isSafeInteger(files.length) || files.length < 1) {
    fail("Choose at least one file from a folder to upload.");
  }
  if (typeof idFactory !== "function") fail("The folder upload ID generator is invalid.");

  const selectedFiles = Array.from(files);
  const usedIds = new Set<string>();
  const id = allocateId(idFactory, usedIds);
  const filesInPlan: FolderUploadFile[] = [];
  const directoryPaths = new Set<string>();
  const selectedPaths = new Set<string>();

  for (const file of selectedFiles) {
    if (!file || typeof file.name !== "string") fail("A selected file is invalid. Reselect the folder before uploading.");
    let safeFileName: string;
    try {
      safeFileName = safeFileItemName(file.name);
    } catch (error) {
      fail(error instanceof Error ? error.message : "A selected file name is invalid.");
    }
    if (safeFileName !== file.name) fail("A selected file name cannot be saved safely.");

    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const segments = validatedPathSegments(relativePath);
    if (segments.length < 2) fail("A selected file is missing its folder path. Reselect the folder before uploading.");
    if (segments.at(-1) !== file.name) fail("A selected file path does not match its file name. Reselect the folder before uploading.");
    if (selectedPaths.has(relativePath)) fail("The folder selection contains duplicate file paths.");
    selectedPaths.add(relativePath);

    const directorySegments = segments.slice(0, -1);
    for (let index = 1; index <= directorySegments.length; index += 1) {
      directoryPaths.add(directorySegments.slice(0, index).join("/"));
    }
    filesInPlan.push({
      file,
      relativePath,
      targetPath: directorySegments.length ? directorySegments.join("/") : null,
    });
  }

  if (filesInPlan.some(({ relativePath }) => directoryPaths.has(relativePath))) {
    fail("The folder selection uses the same path for a file and a folder. Reselect the folder before uploading.");
  }

  const directories: FolderUploadDirectory[] = [...directoryPaths]
    .sort((left, right) => {
      const depthDifference = left.split("/").length - right.split("/").length;
      return depthDifference || left.localeCompare(right);
    })
    .map((path) => {
      const segments = path.split("/");
      return {
        id: allocateId(idFactory, usedIds),
        path,
        name: segments.at(-1) as string,
        parentPath: segments.length > 1 ? segments.slice(0, -1).join("/") : null,
        created: false,
      };
    });

  return { id, ...context, files: filesInPlan, directories };
}

function assertCurrent(plan: FolderUploadPlan, options: FolderUploadHierarchyOptions): void {
  if (options.signal?.aborted) {
    fail("Folder upload was interrupted. Your selection is still here; retry the upload.");
  }
  if (!options.isCurrent(plan.profileId, plan.sessionGeneration)) {
    fail("The folder upload belongs to an earlier Files session. Reselect the folder before continuing.");
  }
}

function validatePlanDirectories(plan: FolderUploadPlan): void {
  if (!isFileId(plan.id) || !Array.isArray(plan.files) || plan.files.length === 0 || !Array.isArray(plan.directories)) {
    fail("The folder upload plan is invalid. Reselect the folder before continuing.");
  }
  const byPath = new Map<string, FolderUploadDirectory>();
  const usedIds = new Set<string>([plan.id]);
  for (const directory of plan.directories) {
    if (!directory || !isFileId(directory.id) || usedIds.has(directory.id) || typeof directory.created !== "boolean") {
      fail("The folder upload plan contains an invalid folder. Reselect the folder before continuing.");
    }
    usedIds.add(directory.id);
    const segments = validatedPathSegments(`${directory.path}/placeholder`);
    const name = segments.at(-2);
    const parentPath = segments.length > 2 ? segments.slice(0, -2).join("/") : null;
    if (directory.path !== segments.slice(0, -1).join("/") || directory.name !== name || directory.parentPath !== parentPath || byPath.has(directory.path)) {
      fail("The folder upload plan contains an invalid folder path. Reselect the folder before continuing.");
    }
    if (parentPath && !byPath.has(parentPath)) fail("The folder upload plan is missing a parent folder. Reselect the folder before continuing.");
    byPath.set(directory.path, directory);
  }
  const filePaths = new Set<string>();
  for (const item of plan.files) {
    if (!item || !item.file || typeof item.file.name !== "string") {
      fail("The folder upload plan contains an invalid file. Reselect the folder before continuing.");
    }
    const segments = validatedPathSegments(item.relativePath);
    if (segments.length < 2 || segments.at(-1) !== item.file.name) {
      fail("The folder upload plan contains an invalid file path. Reselect the folder before continuing.");
    }
    const expectedTargetPath = segments.slice(0, -1).join("/");
    if (item.targetPath !== expectedTargetPath || !byPath.has(expectedTargetPath)) {
      fail("The folder upload plan is missing a file destination. Reselect the folder before continuing.");
    }
    if (filePaths.has(item.relativePath) || byPath.has(item.relativePath)) {
      fail("The folder upload plan has duplicate or conflicting file paths. Reselect the folder before continuing.");
    }
    filePaths.add(item.relativePath);
  }
}

export async function ensureFolderUploadHierarchy(
  profileId: string,
  plan: FolderUploadPlan,
  options: FolderUploadHierarchyOptions,
): Promise<Map<string, string>> {
  if (!plan || typeof plan !== "object") fail("The folder upload plan is invalid. Reselect the folder before continuing.");
  validateContext(plan);
  if (profileId !== plan.profileId) {
    fail("The folder upload belongs to a different signed-in account. Reselect the folder before continuing.");
  }
  if (!options || typeof options.isCurrent !== "function" || typeof options.onCreated !== "function") {
    fail("The folder upload session is unavailable. Reselect the folder before continuing.");
  }
  validatePlanDirectories(plan);
  assertCurrent(plan, options);

  const createFolder = options.createFolder ?? createCustomFolder;
  if (typeof createFolder !== "function") fail("The folder creator is unavailable. Reselect the folder before continuing.");
  const foldersByPath = new Map<string, string>();
  for (const directory of plan.directories) {
    assertCurrent(plan, options);
    let parentId: string | null;
    if (directory.parentPath === null) {
      parentId = plan.folderId;
    } else {
      const resolvedParentId = foldersByPath.get(directory.parentPath);
      if (!resolvedParentId) fail("The parent folder could not be resolved. Reselect the folder before continuing.");
      parentId = resolvedParentId;
    }

    const input: CreateCustomFolderInput = { id: directory.id, name: directory.name, parentId };
    let folder: FileFolder;
    try {
      folder = await createFolder(profileId, input, { signal: options.signal });
    } catch (error) {
      assertCurrent(plan, options);
      throw error;
    }
    assertCurrent(plan, options);
    if (!folder || folder.id !== directory.id || folder.name !== directory.name || folder.parent_id !== parentId ||
        folder.kind !== "custom" || folder.course_id !== null || folder.revision !== 1 || folder.archived_at !== null ||
        folder.trashed_at !== null || folder.deleted_at != null || folder.purge_pending_at != null) {
      fail("The created folder did not match the folder upload plan. Reload Files before continuing.");
    }
    options.onCreated(directory, folder);
    assertCurrent(plan, options);
    foldersByPath.set(directory.path, directory.id);
  }
  assertCurrent(plan, options);
  return foldersByPath;
}
