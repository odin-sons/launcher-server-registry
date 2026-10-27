'use strict';

const IGNORED = new Set(['$schema', '$id', 'title', 'description', '$defs', 'default', 'examples']);
const KNOWN = new Set([
  'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'required', 'properties', 'additionalProperties', 'propertyNames', 'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems', '$ref'
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) node = node[part];
  if (node === undefined) throw new Error(`Unresolved $ref ${ref}`);
  return node;
}

function assertSupported(schema, where) {
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key) && !IGNORED.has(key)) throw new Error(`Unsupported schema keyword '${key}' at ${where}`);
  }
}

// Fails closed: a keyword this validator does not implement throws instead of passing silently.
function validate(schema, value, root = schema, pointer = '') {
  const errors = [];
  walk(schema, value, root, pointer, errors);
  return errors;
}

function walk(schema, value, root, pointer, errors) {
  assertSupported(schema, pointer || '/');
  const fail = (message) => errors.push({ path: pointer || '/', message });

  if (schema.$ref) walk(resolveRef(root, schema.$ref), value, root, pointer, errors);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      fail(`must be ${types.join(' or ')}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((item) => item === value)) {
    fail(`must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  if (schema.const !== undefined && schema.const !== value) fail(`must be ${JSON.stringify(schema.const)}`);

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`must have at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) fail(`does not match ${schema.pattern}`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => walk(schema.items, item, root, `${pointer}/${index}`, errors));
  }

  if (typeOf(value) === 'object') {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail(`must have at least ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail(`must have at most ${schema.maxProperties} properties`);
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) fail(`is missing '${name}'`);
    }
    const properties = schema.properties || {};
    for (const key of keys) {
      const child = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (schema.propertyNames) {
        for (const error of validate(schema.propertyNames, key, root, child)) errors.push({ path: child, message: `name ${error.message}` });
      }
      if (Object.hasOwn(properties, key)) walk(properties[key], value[key], root, child, errors);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        walk(schema.additionalProperties, value[key], root, child, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: child, message: 'is not allowed' });
      }
    }
  }
}

module.exports = { validate };
