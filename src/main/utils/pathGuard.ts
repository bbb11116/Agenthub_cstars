import fs from "node:fs";
import path from "node:path";
import type { ToolPermissionError } from "../../shared/domain";

type PathGuardErrorOptions = ErrorOptions &
  Partial<Pick<ToolPermissionError, "code" | "path">>;

const PATH_OUTSIDE_WORKSPACE_MESSAGE =
  "File access outside workspace is not allowed.";

export class PathGuardError extends Error {
  readonly code?: ToolPermissionError["code"];
  readonly path?: string;

  constructor(message: string, options: PathGuardErrorOptions = {}) {
    super(message, options);
    this.name = "PathGuardError";
    this.code = options.code;
    this.path = options.path;
  }
}

export type AssertPathInsideWorkspaceInput = {
  rootPath: string;
  relativePath: string;
};

export type SafeWorkspacePath = {
  absolutePath: string;
  relativePath: string;
};

export type WorkspacePathGuard = {
  rootPath: string;
  resolve: (relativePath?: string) => SafeWorkspacePath;
  assertInside: (absolutePath: string) => string;
  toRelative: (absolutePath: string) => string;
};

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function normalizeRelativePath(relativePath = ""): string {
  if (relativePath.includes("\0")) {
    throw new PathGuardError("Path is invalid.");
  }

  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new PathGuardError(PATH_OUTSIDE_WORKSPACE_MESSAGE, {
      code: "PATH_OUTSIDE_WORKSPACE",
      path: relativePath
    });
  }

  const segments = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    throw new PathGuardError(PATH_OUTSIDE_WORKSPACE_MESSAGE, {
      code: "PATH_OUTSIDE_WORKSPACE",
      path: relativePath
    });
  }

  return segments.join("/");
}

function isInsideRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);

  return (
    relativePath === "" ||
    (!!relativePath &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

function assertInsideRoot(rootPath: string, targetPath: string): void {
  if (!isInsideRoot(rootPath, targetPath)) {
    throw new PathGuardError(PATH_OUTSIDE_WORKSPACE_MESSAGE, {
      code: "PATH_OUTSIDE_WORKSPACE",
      path: targetPath
    });
  }
}

export function createWorkspacePathGuard(rootPath: string): WorkspacePathGuard {
  let realRootPath: string;

  try {
    realRootPath = fs.realpathSync.native(path.resolve(rootPath));
  } catch (error) {
    const code = getErrorCode(error);

    if (code === "ENOENT") {
      throw new PathGuardError("Workspace does not exist.", { cause: error });
    }

    if (code === "EACCES" || code === "EPERM") {
      throw new PathGuardError("Permission denied.", { cause: error });
    }

    throw new PathGuardError("Unable to resolve workspace path.", { cause: error });
  }

  function resolve(relativePath = ""): SafeWorkspacePath {
    const normalizedRelativePath = normalizeRelativePath(relativePath);
    const absolutePath = normalizedRelativePath
      ? path.resolve(realRootPath, ...normalizedRelativePath.split("/"))
      : realRootPath;

    assertInsideRoot(realRootPath, absolutePath);

    return {
      absolutePath,
      relativePath: normalizedRelativePath
    };
  }

  function assertInside(absolutePath: string): string {
    const resolvedPath = path.resolve(absolutePath);

    assertInsideRoot(realRootPath, resolvedPath);

    try {
      const realPath = fs.realpathSync.native(resolvedPath);

      assertInsideRoot(realRootPath, realPath);
      return realPath;
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return resolvedPath;
      }

      throw error;
    }
  }

  function toRelative(absolutePath: string): string {
    const safePath = assertInside(absolutePath);
    const relativePath = path.relative(realRootPath, safePath).split(path.sep).join("/");

    return normalizeRelativePath(relativePath);
  }

  return {
    rootPath: realRootPath,
    resolve,
    assertInside,
    toRelative
  };
}

export function assertPathInsideWorkspace({
  rootPath,
  relativePath
}: AssertPathInsideWorkspaceInput): string {
  const guard = createWorkspacePathGuard(rootPath);
  const { absolutePath } = guard.resolve(relativePath);

  return guard.assertInside(absolutePath);
}
