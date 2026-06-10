import { useState } from "react";
import { AppIcon } from "../../../components/ui/AppIcon";

type ThinkingBlockProps = {
  thinking: string;
};

export function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!thinking) {
    return null;
  }

  const preview = thinking.replace(/\s+/g, " ").trim().slice(0, 80);

  return (
    <details
      className="thinking-block"
      open={isOpen}
      onToggle={(event) => setIsOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className="thinking-block-summary">
        <AppIcon name="sparkle" className="thinking-block-icon" />
        <span className="thinking-block-label">思考过程</span>
        {!isOpen && preview ? <span className="thinking-block-preview">{preview}…</span> : null}
        <AppIcon name="chevron-down" className="thinking-block-chevron" />
      </summary>
      <div className="thinking-block-body">{thinking}</div>
    </details>
  );
}
