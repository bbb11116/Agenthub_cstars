import type { GitFileStatus, GitFileStatusLabel } from "../../../shared/git";

type GitStatusListProps = {
  files: GitFileStatus[];
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
};

const STATUS_GROUPS: Array<{
  label: GitFileStatusLabel;
  title: string;
}> = [
  { label: "modified", title: "Modified" },
  { label: "added", title: "Added" },
  { label: "deleted", title: "Deleted" },
  { label: "untracked", title: "Untracked" },
  { label: "renamed", title: "Renamed" },
  { label: "unknown", title: "Other" }
];

function getStatusCode(file: GitFileStatus): string {
  if (file.indexStatus === "?" && file.worktreeStatus === "?") {
    return "??";
  }

  return `${file.indexStatus || " "}${file.worktreeStatus || " "}`.trim();
}

export function GitStatusList({
  files,
  onSelectFile,
  selectedFilePath
}: GitStatusListProps) {
  if (files.length === 0) {
    return (
      <div className="git-status-empty">
        <span className="placeholder-title">No Changes</span>
        <span className="placeholder-muted">Working tree is clean.</span>
      </div>
    );
  }

  return (
    <div className="git-status-list" aria-label="Git file status">
      {STATUS_GROUPS.map((group) => {
        const groupFiles = files.filter((file) => file.label === group.label);

        if (groupFiles.length === 0) {
          return null;
        }

        return (
          <section className="git-status-group" key={group.label}>
            <h3>{group.title}</h3>
            <div className="git-status-files">
              {groupFiles.map((file) => (
                <button
                  className={
                    file.path === selectedFilePath
                      ? "git-status-file active"
                      : "git-status-file"
                  }
                  key={`${file.label}:${file.path}`}
                  type="button"
                  onClick={() => onSelectFile(file.path)}
                >
                  <code>{getStatusCode(file)}</code>
                  <span>{file.path}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
