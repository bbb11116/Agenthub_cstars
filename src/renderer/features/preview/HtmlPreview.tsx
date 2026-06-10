type HtmlPreviewProps = {
  content: string;
  title: string;
};

export function HtmlPreview({ content, title }: HtmlPreviewProps) {
  return (
    <iframe
      className="html-preview-frame"
      referrerPolicy="no-referrer"
      sandbox=""
      srcDoc={content}
      title={title}
    />
  );
}
