export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
  }
}

function isAggregateError(error: unknown): error is AggregateError {
  return typeof AggregateError !== "undefined" && error instanceof AggregateError;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return value.message.trim().length > 0 ? value.message : value.name;
  }
  if (value === null || value === undefined) return "Unknown error";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatCliError(error: unknown): string {
  if (isAggregateError(error)) {
    const parts = error.errors
      .map((nested) => formatCliError(nested))
      .filter((part) => part.trim().length > 0);
    const uniqueParts = Array.from(new Set(parts));
    const message = error.message && error.message !== "AggregateError" ? error.message : "";
    return [message, ...uniqueParts].filter((part) => part.trim().length > 0).join(": ");
  }
  return stringifyUnknown(error).trim() || "Unknown error";
}

export function printCliError(error: unknown) {
  const message = formatCliError(error);
  const normalized = message.toLowerCase().startsWith("error:") ? message : `Error: ${message}`;
  console.error(normalized);
}
