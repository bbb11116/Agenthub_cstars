type ThinkingIndicatorProps = {
  label?: string;
};

export function ThinkingIndicator({ label = "思考中" }: ThinkingIndicatorProps) {
  return (
    <div
      aria-label={label}
      className="message-row message-row-agent thinking-indicator"
      role="status"
    >
      <div className="message-meta">
        <span className="agent-badge" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="thinking-bubble" aria-hidden="true">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </div>
    </div>
  );
}
