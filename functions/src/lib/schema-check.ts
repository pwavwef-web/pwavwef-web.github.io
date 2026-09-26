/**
 * Checks a model's structured reply against the JSON Schema subset our structured-output schemas use
 * (object/array/string/number/integer/boolean, `required`, `enum`, `items`). The API enforces the schema
 * when it accepts it; this is the second line of defence, so a reply with a missing or mistyped field is
 * refused instead of being read with default values that could let a faulty take pass.
 */
type Schema = Record<string, unknown>;

export function schemaErrors(value: unknown, schema: Schema, at = '$', out: string[] = [], limit = 20): string[] {
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
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (props[k]) schemaErrors(v, props[k], `${at}.${k}`, out, limit);
      break;
    }
    case 'array':
      if (!Array.isArray(value)) {
        err('expected an array');
        return out;
      }
      if (schema.items) value.forEach((v, i) => schemaErrors(v, schema.items as Schema, `${at}[${i}]`, out, limit));
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
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) err(`“${String(value)}” is not one of ${schema.enum.join(', ')}`);
  return out;
}
