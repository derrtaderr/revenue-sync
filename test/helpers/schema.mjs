// A small JSON-schema subset validator for the account model contract test (test code only; the tool
// itself has no dependencies and does not use this). Supports $ref (local #/...), type,
// required, properties, additionalProperties (a schema, true or false), items, enum and format
// date-time (other format values are annotations, as in JSON Schema). Any other keyword that is
// not a pure annotation throws, so a spec that starts using oneOf, anyOf, allOf, not or
// anything else fails loudly instead of passing unchecked. Returns a list of readable errors;
// an empty list means the value matches.

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function resolveRef(ref, spec) {
  if (!ref.startsWith('#/')) throw new Error(`only local $ref is supported: ${ref}`);
  const target = ref.slice(2).split('/').reduce((node, key) => node?.[key], spec);
  if (!target) throw new Error(`unresolved $ref ${ref}`);
  return target;
}

const SUPPORTED = new Set(['$ref', 'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'format']);
const ANNOTATIONS = new Set(['$schema', '$id', '$defs', '$comment', 'description', 'example', 'examples', 'title', 'default', 'readOnly', 'writeOnly', 'deprecated', 'externalDocs', 'xml']);

function assertSupported(schema, path) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key) && !ANNOTATIONS.has(key) && !key.startsWith('x-')) {
      throw new Error(`unsupported schema keyword "${key}" at ${path}; implement it in test/helpers/schema.mjs before trusting this result`);
    }
  }
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function matchesType(type, value) {
  if (Array.isArray(type)) return type.some((t) => matchesType(t, value));
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  return typeOf(value) === type;
}

export function validate(schema, value, spec, { allowNull = () => false } = {}, path = '$') {
  while (schema?.$ref) schema = resolveRef(schema.$ref, spec);
  if (!schema) return [];
  assertSupported(schema, path);
  const opts = { allowNull };
  if (value === null) {
    return allowNull(path) || !schema.type || [].concat(schema.type).includes('null') ? [] : [`${path} should be ${schema.type}, got null`];
  }
  if (schema.type && !matchesType(schema.type, value)) return [`${path} should be ${schema.type}, got ${typeOf(value)}`];
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} should be one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}`);
  if (schema.format === 'date-time' && typeof value === 'string' && !DATE_TIME.test(value)) errors.push(`${path} should be a date-time, got ${JSON.stringify(value)}`);
  if (typeOf(value) === 'array' && schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, spec, opts, `${path}[${i}]`)));
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      if (sub) errors.push(...validate(sub, v, spec, opts, `${path}.${key}`));
      else if (schema.additionalProperties === false && !(key in (schema.properties ?? {}))) errors.push(`${path}.${key} is not allowed (additionalProperties is false)`);
    }
  }
  return errors;
}
