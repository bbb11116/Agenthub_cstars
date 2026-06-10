import { createHash } from "node:crypto";

export function createContentHash(content: string | Buffer): string {
  const hash = createHash("sha256");

  if (typeof content === "string") {
    hash.update(content, "utf8");
  } else {
    hash.update(content);
  }

  return hash.digest("hex");
}
