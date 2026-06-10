type AgentAvatarProps = {
  name: string;
  avatar?: string;
  size?: number;
  alt?: string;
};

const PALETTE = [
  "#1d4ed8",
  "#2563eb",
  "#0f766e",
  "#0369a1",
  "#4338ca",
  "#0284c7",
  "#155e75",
  "#1e40af",
  "#0891b2",
  "#334155"
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function isAvatarUrl(value: string): boolean {
  return /^(https?:\/\/|data:)/i.test(value);
}

function pickColor(name: string): string {
  return PALETTE[hashString(name) % PALETTE.length];
}

function firstChar(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "?";
  }
  const chars = [...trimmed];
  return chars[0]?.toUpperCase() ?? "?";
}

export function AgentAvatar({ name, avatar, size = 32, alt }: AgentAvatarProps) {
  const dim = `${size}px`;
  const fontSize = Math.max(12, Math.round(size * 0.45));
  const safeAlt = alt ?? name;
  const fallbackChar = firstChar(name);

  if (avatar && avatar.trim().length > 0) {
    if (isAvatarUrl(avatar)) {
      return (
        <span
          className="agent-avatar"
          style={{ width: dim, height: dim }}
          aria-label={safeAlt}
        >
          <img alt={safeAlt} src={avatar} />
        </span>
      );
    }

    const trimmed = avatar.trim();
    if (trimmed.length <= 2) {
      return (
        <span
          aria-label={safeAlt}
          className="agent-avatar"
          style={{
            width: dim,
            height: dim,
            fontSize: `${fontSize}px`,
            background: pickColor(name)
          }}
        >
          {trimmed}
        </span>
      );
    }
  }

  return (
    <span
      aria-label={safeAlt}
      className="agent-avatar"
      style={{
        width: dim,
        height: dim,
        fontSize: `${fontSize}px`,
        background: pickColor(name)
      }}
    >
      {fallbackChar}
    </span>
  );
}
