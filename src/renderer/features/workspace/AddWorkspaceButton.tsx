import { useWorkspaceStore } from "../../state/workspaceStore";

type AddWorkspaceButtonProps = {
  className?: string;
  label?: string;
};

export function AddWorkspaceButton({
  className,
  label = "Open Local Code Folder"
}: AddWorkspaceButtonProps) {
  const { isCreatingWorkspace, isOpening, openLocalFolder } = useWorkspaceStore();
  const disabled = isOpening || isCreatingWorkspace;

  return (
    <button
      className={className ? `add-workspace-button ${className}` : "add-workspace-button"}
      type="button"
      disabled={disabled}
      onClick={() => {
        void openLocalFolder();
      }}
    >
      <span aria-hidden="true">+</span>
      {isOpening ? "Opening..." : label}
    </button>
  );
}
