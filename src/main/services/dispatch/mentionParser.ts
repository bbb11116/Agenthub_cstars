import { MAX_DISPATCH_STEPS } from "../../../shared/groupChat";

export function parseMentionNames(content: string): string[] {
  const mentionRegex = /@([\w一-鿿][\w一-鿿\s-]*?)(?=[\s,，]|$|@)/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(content)) !== null) {
    const name = match[1].trim();

    if (name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }

  return names.slice(0, MAX_DISPATCH_STEPS);
}
