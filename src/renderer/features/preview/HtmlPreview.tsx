import { useLayoutEffect, useRef } from "react";

type HtmlPreviewProps = {
  content: string;
  title: string;
  className?: string;
};

const NATURAL_WIDTH = 1280;
const NATURAL_HEIGHT = 720;

export function HtmlPreview({ content, title, className }: HtmlPreviewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const update = (): void => {
      const available = wrapper.clientWidth;
      if (available <= 0) return;
      const scale = available / NATURAL_WIDTH;
      wrapper.style.setProperty("--html-preview-width", `${available}px`);
      wrapper.style.setProperty("--html-preview-height", `${NATURAL_HEIGHT * scale}px`);
      wrapper.style.setProperty("--html-preview-scale", String(scale));
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapper);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const classes = ["html-preview-frame-wrapper"];
  if (className) classes.push(className);

  return (
    <div ref={wrapperRef} className={classes.join(" ")}>
      <iframe
        className="html-preview-frame"
        referrerPolicy="no-referrer"
        sandbox=""
        srcDoc={content}
        title={title}
      />
    </div>
  );
}
