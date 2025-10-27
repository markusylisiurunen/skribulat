export function fitInConsoleWidth(text: string, extraPadding = 0) {
  const { columns } = Deno.consoleSize();
  if (text.length <= columns - extraPadding) return text;
  const available = Math.max(columns - extraPadding - 3, 1);
  return text.slice(0, available) + "...";
}
