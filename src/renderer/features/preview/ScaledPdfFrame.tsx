import { useLayoutEffect, useRef } from "react";

type ScaledPdfFrameProps = {
  src: string;
  title: string;
  className?: string;
  naturalWidth?: number;
  naturalHeight?: number;
};

const NATURAL_WIDTH = 1920;
const NATURAL_HEIGHT = 1080;

export function ScaledPdfFrame({
  src,
  title,
  className
}: ScaledPdfFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const update = (): void => {
      const available = wrapper.clientWidth;
      if (available <= 0) return;
      const scale = available / NATURAL_WIDTH;
      wrapper.style.setProperty("--scaled-pdf-width", `${available}px`);
      wrapper.style.setProperty("--scaled-pdf-height", `${NATURAL_HEIGHT * scale}px`);
      wrapper.style.setProperty("--scaled-pdf-scale", String(scale));
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

  const classes = ["scaled-pdf-frame"];
  if (className) classes.push(className);

  return (
    <div ref={wrapperRef} className={classes.join(" ")}>
      <iframe
        src={src}
        title={title}
        className="scaled-pdf-frame-iframe"
      />
    </div>
  );
}
