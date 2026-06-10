export function estimateTokens(text: string): number {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;

  for (const character of text) {
    if (character.charCodeAt(0) <= 0x7f) {
      asciiCharacters += 1;
    } else {
      nonAsciiCharacters += 1;
    }
  }

  return Math.max(1, nonAsciiCharacters + Math.ceil(asciiCharacters / 4));
}
