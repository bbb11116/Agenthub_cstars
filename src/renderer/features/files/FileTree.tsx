import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { FileTreeNode } from "../../../shared/file";

type FileTreeProps = {
  nodes: FileTreeNode[];
  selectedFilePath: string | null;
  onSelectFile: (relativePath: string) => void;
};

type FileTreeItemProps = {
  node: FileTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  onSelectFile: (relativePath: string) => void;
  onToggleDirectory: (relativePath: string) => void;
};

function getAncestorPaths(relativePath: string | null): string[] {
  if (!relativePath) {
    return [];
  }

  const segments = relativePath.split("/");
  const ancestors: string[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }

  return ancestors;
}

function FileTreeItem({
  depth,
  expandedPaths,
  node,
  onSelectFile,
  onToggleDirectory,
  selectedFilePath
}: FileTreeItemProps) {
  const isDirectory = node.type === "directory";
  const isExpanded = isDirectory && expandedPaths.has(node.relativePath);
  const isSelected = !isDirectory && node.relativePath === selectedFilePath;
  const rowStyle = {
    "--file-tree-depth": depth
  } as CSSProperties;

  return (
    <div className="file-tree-item" role="none">
      <button
        className={[
          "file-tree-row",
          isDirectory ? "file-tree-directory" : "file-tree-file",
          isSelected ? "active" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        type="button"
        role="treeitem"
        aria-expanded={isDirectory ? isExpanded : undefined}
        aria-selected={isSelected}
        style={rowStyle}
        onClick={() =>
          isDirectory ? onToggleDirectory(node.relativePath) : onSelectFile(node.relativePath)
        }
      >
        <span className={isExpanded ? "file-tree-caret expanded" : "file-tree-caret"}>
          {isDirectory ? "›" : ""}
        </span>
        <span className="file-tree-name">{node.name}</span>
      </button>

      {isDirectory && isExpanded && node.children ? (
        <div role="group">
          {node.children.map((childNode) => (
            <FileTreeItem
              depth={depth + 1}
              expandedPaths={expandedPaths}
              key={childNode.relativePath}
              node={childNode}
              onSelectFile={onSelectFile}
              onToggleDirectory={onToggleDirectory}
              selectedFilePath={selectedFilePath}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FileTree({ nodes, onSelectFile, selectedFilePath }: FileTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedPaths((currentPaths) => {
      const nextPaths = new Set(currentPaths);

      getAncestorPaths(selectedFilePath).forEach((ancestorPath) => {
        nextPaths.add(ancestorPath);
      });

      return nextPaths;
    });
  }, [selectedFilePath]);

  function toggleDirectory(relativePath: string): void {
    setExpandedPaths((currentPaths) => {
      const nextPaths = new Set(currentPaths);

      if (nextPaths.has(relativePath)) {
        nextPaths.delete(relativePath);
      } else {
        nextPaths.add(relativePath);
      }

      return nextPaths;
    });
  }

  if (nodes.length === 0) {
    return (
      <div className="tree-status" role="status">
        No files found.
      </div>
    );
  }

  return (
    <div className="file-tree" role="tree" aria-label="Workspace files">
      {nodes.map((node) => (
        <FileTreeItem
          depth={0}
          expandedPaths={expandedPaths}
          key={node.relativePath}
          node={node}
          onSelectFile={onSelectFile}
          onToggleDirectory={toggleDirectory}
          selectedFilePath={selectedFilePath}
        />
      ))}
    </div>
  );
}
