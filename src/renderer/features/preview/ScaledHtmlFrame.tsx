import { useEffect, useRef } from "react";

type ScaledHtmlFrameProps = {
  content: string;
  title: string;
  className?: string;
};

const NATURAL_WIDTH = 1920;
const NATURAL_HEIGHT = 1080;


// Force a clean white canvas and constrain content to 100% width so the
// scaled iframe preview always looks like a normal slide deck, regardless
// of what the LLM put in the body (it may set a dark background, fixed
// pixel widths, or absolute positioning that would otherwise leak out).
const PREVIEW_BASE_STYLE = `
<style data-agenthub-scaled-html>
html, body { background: #ffffff !important; color: #1f2933 !important; }
html, body { width: 100% !important; max-width: 100% !important; box-sizing: border-box; }
* { max-width: 100% !important; box-sizing: border-box; }
img, video, iframe, svg, table, pre { max-width: 100% !important; height: auto; }
</style>
`;

function injectPreviewBase(html: string): string {
  if (html.includes("data-agenthub-scaled-html")) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${PREVIEW_BASE_STYLE}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}<head>${PREVIEW_BASE_STYLE}</head>`);
  }
  return `<head>${PREVIEW_BASE_STYLE}</head>${html}`;
}

export function ScaledHtmlFrame({ content, title, className }: ScaledHtmlFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const update = (): void => {
      const available = wrapper.clientWidth;
      if (available <= 0) return;
      const scale = available / NATURAL_WIDTH;
      wrapper.style.setProperty("--scaled-html-scale", String(scale));
      wrapper.style.setProperty(
        "--scaled-html-height",
        `${NATURAL_HEIGHT * scale}px`
      );
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapper);
    const parent = wrapper.parentElement;
    if (parent) ro.observe(parent);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const classes = ["scaled-html-frame"];
  if (className) classes.push(className);

  return (
    <div ref={wrapperRef} className={classes.join(" ")}>
      <iframe
        className="scaled-html-frame-iframe"
        referrerPolicy="no-referrer"
        sandbox=""
        srcDoc={injectPreviewBase(content)}
        title={title}
      />
    </div>
  );
}
