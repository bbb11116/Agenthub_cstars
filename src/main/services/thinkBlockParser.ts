/**
 * Streaming 文本中的 `<think>...</think>` 块解析器。
 *
 * 一些模型（DeepSeek R1、Qwen3 等）会把推理过程包在 `<think>` XML 标签里，
 * 作为普通文本塞进 SSE 的 `delta.content` 字段，而不是走 Anthropic 那样的
 * 独立 `thinking_delta` content block。这个解析器在流式增量的边界上识别
 * 标签，把块内文字归到 thinking 通道、块外归到 visible 通道。
 *
 * 跨增量边界的关键处理：当 buffer 中含有尚未拼完的 `<` 序列时，从最后一个
 * `<` 起保留至多 7 / 8 个字符（开 / 闭标签长度），其余全部吐出；只要
 * `indexOf` 没有命中完整标签，那段被保留的字符最多耗到一个完整标签长度，
 * 之后 `<` 一定不是标签起点，于是整体吐出。
 */
const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

type Mode = "beforeOpen" | "inside" | "afterClose";

export type ThinkFeedResult = {
  /** 应当作为正文渲染 / 持久化的纯文本片段（已剥离 think 块）。 */
  visible: string;
  /** 应当作为思考过程持久化的纯文本片段。 */
  thinking: string;
};

export class ThinkBlockParser {
  private mode: Mode = "beforeOpen";
  private buffer = "";

  feed(delta: string): ThinkFeedResult {
    if (delta.length === 0) {
      return { visible: "", thinking: "" };
    }

    this.buffer += delta;
    return this.drain();
  }

  private drain(): ThinkFeedResult {
    let visible = "";
    let thinking = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.mode === "afterClose") {
        visible += this.buffer;
        this.buffer = "";
        return { visible, thinking };
      }

      if (this.mode === "beforeOpen") {
        const openIdx = this.buffer.indexOf(OPEN_TAG);
        if (openIdx >= 0) {
          visible += this.buffer.slice(0, openIdx);
          this.buffer = this.buffer.slice(openIdx + OPEN_TAG.length);
          this.mode = "inside";
          continue;
        }
        return this.flushBeforeOpen(visible);
      }

      // mode === "inside"
      const closeIdx = this.buffer.indexOf(CLOSE_TAG);
      if (closeIdx >= 0) {
        thinking += this.buffer.slice(0, closeIdx);
        this.buffer = this.buffer.slice(closeIdx + CLOSE_TAG.length);
        this.mode = "afterClose";
        continue;
      }
      return this.flushInside(thinking);
    }
  }

  private flushBeforeOpen(prefixVisible: string): ThinkFeedResult {
    // 找最后一个 `<`：它可能还在拼 `<think>`，所以从它起保留最多 7 个字符；
    // 一旦保留段已经达到 7 字符且没命中标签，那个 `<` 必然是字面量。
    const lastLt = this.buffer.lastIndexOf("<");
    if (lastLt === -1 || this.buffer.length - lastLt >= OPEN_TAG.length) {
      const flushed = this.buffer;
      this.buffer = "";
      return { visible: prefixVisible + flushed, thinking: "" };
    }
    const visible = this.buffer.slice(0, lastLt);
    this.buffer = this.buffer.slice(lastLt);
    return { visible: prefixVisible + visible, thinking: "" };
  }

  private flushInside(prefixThinking: string): ThinkFeedResult {
    const lastLt = this.buffer.lastIndexOf("<");
    if (lastLt === -1 || this.buffer.length - lastLt >= CLOSE_TAG.length) {
      const flushed = this.buffer;
      this.buffer = "";
      return { visible: "", thinking: prefixThinking + flushed };
    }
    const thinking = this.buffer.slice(0, lastLt);
    this.buffer = this.buffer.slice(lastLt);
    return { visible: "", thinking: prefixThinking + thinking };
  }
}
