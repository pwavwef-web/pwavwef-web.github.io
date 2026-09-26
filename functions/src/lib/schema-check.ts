/**
 * Checks a model's structured reply against the JSON Schema subset our structured-output schemas use
 * (object/array/string/number/integer/boolean, `required`, `enum`, `items`), so a reply with a missing or
 * mistyped field is refused instead of being read with default values that could let a faulty take pass.
 * With `enums: false` only the structure is checked: values outside an enum are left to the normalisers,
 * which map them to the nearest known value conservatively (a reported fault is never dropped).
 */
type Schema = Record<string, unknown>;

export function schemaErrors(value: unknown, schema: Schema, opts: { enums?: boolean; limit?: number } = {}, at = '$', out: string[] = []): string[] {
  const limit = opts.limit ?? 20;
  if (out.length >= limit) return out;
  const err = (msg: string) => {
    if (out.length < limit) out.push(`${at}: ${msg}`);
  };
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        err('expected an object');
        return out;
      }
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in (value as object))) err(`missing “${k}”`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (props[k]) schemaErrors(v, props[k], opts, `${at}.${k}`, out);
      break;
    }
    case 'array':
      if (!Array.isArray(value)) {
        err('expected an array');
        return out;
      }
      if (schema.items) value.forEach((v, i) => schemaErrors(v, schema.items as Schema, opts, `${at}[${i}]`, out));
      break;
    case 'string':
      if (typeof value !== 'string') err('expected a string');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) err('expected a number');
      break;
    case 'integer':
      if (!Number.isInteger(value)) err('expected an integer');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') err('expected true or false');
      break;
    default:
      break;
  }
  if (opts.enums !== false && Array.isArray(schema.enum) && !schema.enum.includes(value as never)) err(`“${String(value)}” is not one of ${schema.enum.join(', ')}`);
  return out;
}
