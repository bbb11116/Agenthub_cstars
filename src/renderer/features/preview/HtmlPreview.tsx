type HtmlPreviewProps = {
  content: string;
  title: string;
};

const RESPONSIVE_BASE_STYLE = `
<style data-agenthub-html-preview>
html, body { max-width: 100% !important; box-sizing: border-box; }
body { overflow-x: auto; }
* { max-width: 100% !important; box-sizing: border-box; }
img, video, iframe, svg, table, pre { max-width: 100% !important; height: auto; }
</style>
`;

function injectResponsiveBase(html: string): string {
  if (html.includes('data-agenthub-html-preview')) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${RESPONSIVE_BASE_STYLE}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}<head>${RESPONSIVE_BASE_STYLE}</head>`);
  }
  return `<head>${RESPONSIVE_BASE_STYLE}</head>${html}`;
}

export function HtmlPreview({ content, title }: HtmlPreviewProps) {
  return (
    <iframe
      className="html-preview-frame"
      referrerPolicy="no-referrer"
      sandbox=""
      srcDoc={injectResponsiveBase(content)}
      title={title}
    />
  );
}
