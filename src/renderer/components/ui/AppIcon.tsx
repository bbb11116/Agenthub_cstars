import type { SVGProps } from "react";

export type AppIconName =
  | "artifacts"
  | "chat"
  | "check"
  | "chevron-down"
  | "close"
  | "diff"
  | "files"
  | "git"
  | "pin"
  | "plus"
  | "preview"
  | "runtime"
  | "search"
  | "send"
  | "settings"
  | "sparkle"
  | "trash"
  | "users";

type AppIconProps = SVGProps<SVGSVGElement> & {
  name: AppIconName;
};

const iconPaths: Record<AppIconName, JSX.Element> = {
  artifacts: (
    <>
      <path d="M7 8.5 12 5l5 3.5-5 3.5-5-3.5Z" />
      <path d="M7 13.5 12 17l5-3.5" />
      <path d="M7 11 12 14.5 17 11" />
    </>
  ),
  chat: (
    <>
      <path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v4A3.5 3.5 0 0 1 15.5 14H11l-4 4v-4.2A3.5 3.5 0 0 1 5 10.5v-4Z" />
      <path d="M9 8h6" />
      <path d="M9 11h3.5" />
    </>
  ),
  check: (
    <>
      <path d="m5.5 12.5 4 4 9-9" />
    </>
  ),
  "chevron-down": (
    <>
      <path d="m6 9.5 6 6 6-6" />
    </>
  ),
  close: (
    <>
      <path d="m7 7 10 10" />
      <path d="M17 7 7 17" />
    </>
  ),
  diff: (
    <>
      <path d="M6 5h12" />
      <path d="M6 19h12" />
      <path d="M8 9h5" />
      <path d="M8 13h8" />
      <path d="M8 16h4" />
    </>
  ),
  files: (
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v6A2.5 2.5 0 0 1 17.5 18h-11A2.5 2.5 0 0 1 4 15.5v-8Z" />
      <path d="M4.5 9h15" />
    </>
  ),
  git: (
    <>
      <path d="M12 3v11" />
      <path d="M8 7a4 4 0 0 0 4 4" />
      <path d="M16 7a4 4 0 0 1-4 4" />
      <circle cx="12" cy="4.5" r="1.5" />
      <circle cx="7" cy="7.5" r="1.5" />
      <circle cx="17" cy="7.5" r="1.5" />
      <circle cx="12" cy="17.5" r="1.5" />
    </>
  ),
  pin: (
    <>
      <path d="M12 3v9" />
      <path d="M8 7h8" />
      <path d="M9 12 7 21l5-3 5 3-2-9" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  preview: (
    <>
      <path d="M3.5 12s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  runtime: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <path d="M9 9h6v6H9z" />
      <path d="M9 2.5v2.5" />
      <path d="M15 2.5v2.5" />
      <path d="M9 19v2.5" />
      <path d="M15 19v2.5" />
      <path d="M2.5 9h2.5" />
      <path d="M2.5 15h2.5" />
      <path d="M19 9h2.5" />
      <path d="M19 15h2.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m15 15 4 4" />
    </>
  ),
  send: (
    <>
      <path d="M12 19V5" />
      <path d="m6.5 10.5 5.5-5.5 5.5 5.5" />
    </>
  ),
  settings: (
    <>
      <path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5Z" />
      <path d="M19 12a7.2 7.2 0 0 0-.1-1.1l2-1.5-2-3.5-2.4 1a7.9 7.9 0 0 0-1.9-1.1L14.3 3h-4.6l-.3 2.8a7.9 7.9 0 0 0-1.9 1.1l-2.4-1-2 3.5 2 1.5A7.2 7.2 0 0 0 5 12c0 .4 0 .8.1 1.1l-2 1.5 2 3.5 2.4-1c.6.5 1.2.8 1.9 1.1l.3 2.8h4.6l.3-2.8c.7-.3 1.3-.6 1.9-1.1l2.4 1 2-3.5-2-1.5c.1-.3.1-.7.1-1.1Z" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.5 13.6 9 19 10.5 13.6 12 12 17.5 10.4 12 5 10.5 10.4 9 12 3.5Z" />
      <path d="M18.5 4.5 19.2 6.3 21 7l-1.8.7L18.5 9.5l-.7-1.8L16 7l1.8-.7.7-1.8Z" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14" />
      <path d="M10 5h4l1 2h-6Z" />
      <path d="M6.5 7 8 19a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1.5-12" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>
  ),
  users: (
    <>
      <path d="M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M3.5 20a6 6 0 0 1 12 0" />
      <path d="M16.5 11.5a3 3 0 1 0 0-6" />
      <path d="M17.5 14.5a5 5 0 0 1 3 4.5" />
    </>
  )
};

export function AppIcon({ name, ...props }: AppIconProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      {...props}
    >
      {iconPaths[name]}
    </svg>
  );
}
