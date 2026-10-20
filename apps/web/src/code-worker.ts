import { highlightCode, languageForPath } from "./code.js";

self.onmessage = async (
  event: MessageEvent<{ id: number; text: string; language: string }>,
) => {
  const { id, text, language } = event.data;
  try {
    const resolved = await languageForPath(`file.${language}`);
    const lines = resolved ? await highlightCode(text, resolved) : undefined;
    self.postMessage({ id, lines });
  } catch {
    self.postMessage({ id });
  }
};
