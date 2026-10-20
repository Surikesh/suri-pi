const MAX_TITLE_LENGTH = 58;
const MAX_WORDS = 8;

export function sessionTitle(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[#>*+-]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "New session";
  const words = plain.split(" ").slice(0, MAX_WORDS);
  let title = words.join(" ").replace(/[\s.,:;!?—–-]+$/u, "");
  if (title.length > MAX_TITLE_LENGTH)
    title = title
      .slice(0, MAX_TITLE_LENGTH)
      .replace(/\s+\S*$/, "")
      .trim();
  return title || "New session";
}
