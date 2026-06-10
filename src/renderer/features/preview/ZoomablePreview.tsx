import type { ReactNode } from "react";

type PreviewFrameProps = {
  children: ReactNode;
  className?: string;
};

export function ZoomablePreview({ children, className }: PreviewFrameProps) {
  const classes = ["zoomable-preview"];
  if (className) classes.push(className);
  return <div className={classes.join(" ")}>{children}</div>;
}
