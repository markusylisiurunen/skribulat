export interface ReadFlagResult {
  rest: string[];
  value?: string;
}

export function readFlag(args: readonly string[], flag: string): ReadFlagResult {
  const rest = [...args];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === flag) {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error(`Expected a value after ${flag}.`);
      }
      rest.splice(i, 2);
      return { rest, value };
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      rest.splice(i, 1);
      return { rest, value };
    }
  }
  return { rest, value: undefined };
}

export function readPositiveIntegerFlag(args: readonly string[], flag: string) {
  const { rest, value } = readFlag(args, flag);
  if (value === undefined) {
    return { rest, value: undefined as number | undefined };
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`Value for ${flag} must be a positive integer.`);
  }
  return { rest, value: numberValue };
}
