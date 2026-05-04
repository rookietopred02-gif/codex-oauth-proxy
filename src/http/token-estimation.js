export function estimateTokenCountFromText(text) {
  const source = typeof text === "string" ? text : String(text || "");
  if (!source) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(source, "utf8") / 4));
}
