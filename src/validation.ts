export type Args = Record<string, unknown>;

export function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Argument "${key}" must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Argument "${key}" must be a non-empty string`);
  }
  return value.trim();
}

export function requireDate(args: Args, key: string): string {
  const value = requireString(args, key);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    throw new Error(
      `Argument "${key}" must be a valid date in YYYY-MM-DD format`,
    );
  }
  return value;
}

export function optionalDate(args: Args, key: string): string | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  return requireDate(args, key);
}

export function requireTime(args: Args, key: string): string {
  const value = requireString(args, key);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`Argument "${key}" must use 24-hour HH:MM format`);
  }
  return value;
}

export function requirePositiveInteger(args: Args, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Argument "${key}" must be a positive integer`);
  }
  return value as number;
}

export function optionalPositiveInteger(
  args: Args,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  return requirePositiveInteger(args, key);
}

export function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Argument "${key}" must be a boolean`);
  }
  return value;
}

export function requireConfirmation(args: Args): void {
  if (args.confirm !== true) {
    throw new Error(
      'Argument "confirm" must be true for this destructive action',
    );
  }
}

export function optionalEnum<T extends string>(
  args: Args,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Argument "${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function optionalIntegerArray(
  args: Args,
  key: string,
  maxItems = 100,
): number[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(
      `Argument "${key}" must be an array of at most ${maxItems} integers`,
    );
  }
  return value.map((entry) => {
    if (!Number.isSafeInteger(entry) || entry < 1) {
      throw new Error(`Argument "${key}" must contain positive integers`);
    }
    return entry;
  });
}

export function optionalObjectArray(
  args: Args,
  key: string,
  maxItems = 100,
): Record<string, unknown>[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(
      `Argument "${key}" must be an array of at most ${maxItems} objects`,
    );
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Argument "${key}" must contain only objects`);
    }
    return entry as Record<string, unknown>;
  });
}

export function compactObject(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  );
}
