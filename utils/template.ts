type Replacements = Record<string, string>;

type RenderOptions = {
  report?: boolean;
  strict?: boolean;
};

type RenderReport = {
  missingKeys: string[];
  perKey: Record<string, number>;
  totalSubstitutions: number;
};

type RenderResult = {
  output: string;
  report?: RenderReport;
};

export function renderTemplate(
  template: string,
  replacements: Replacements,
  options: RenderOptions = {},
): RenderResult {
  const { report = false, strict = false } = options;
  if (typeof template !== "string") {
    throw new TypeError("renderTemplate: template must be a string");
  }
  const entries = Object.entries(replacements);
  const perKey: Record<string, number> = {};
  const missingKeys: string[] = [];
  let output = template;
  for (const [key, value] of entries) {
    if (!key) {
      throw new TypeError("renderTemplate: replacement keys must be non-empty strings");
    }
    const parts = output.split(key);
    if (parts.length === 1) {
      perKey[key] = 0;
      if (strict) missingKeys.push(key);
      continue;
    }
    perKey[key] = parts.length - 1;
    output = parts.join(value ?? "");
  }
  if (strict && missingKeys.length > 0) {
    throw new Error(
      `renderTemplate: missing placeholder(s) in template: ${missingKeys.join(", ")}`,
    );
  }
  if (report) {
    const totalSubstitutions = Object.values(perKey).reduce((acc, count) => acc + count, 0);
    return { output, report: { missingKeys, perKey, totalSubstitutions } };
  }
  return { output };
}
