/**
 * A small JSON Schema subset, enough to hold model answers to a contract:
 * type, properties, required, enum, items, maxItems, maxLength, minimum,
 * maximum. Unknown properties are allowed and ignored by callers.
 */
export type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; description?: string }
  | { type: 'array'; items: Schema; maxItems?: number; description?: string }
  | { type: 'string'; enum?: readonly string[]; maxLength?: number; description?: string }
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string }

export function validate(value: unknown, schema: Schema, at = '$'): string[] {
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at} must be an object`]
      const record = value as Record<string, unknown>
      const errors: string[] = []
      for (const key of schema.required ?? []) if (record[key] === undefined) errors.push(`${at}.${key} is required`)
      for (const [key, child] of Object.entries(schema.properties)) {
        if (record[key] !== undefined) errors.push(...validate(record[key], child, `${at}.${key}`))
      }
      return errors
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${at} must be an array`]
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return [`${at} has more than ${schema.maxItems} items`]
      return value.flatMap((item, i) => validate(item, schema.items, `${at}[${i}]`))
    }
    case 'string': {
      if (typeof value !== 'string') return [`${at} must be a string`]
      if (schema.enum && !schema.enum.includes(value)) return [`${at} must be one of ${schema.enum.join(', ')}`]
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${at} is longer than ${schema.maxLength}`]
      return []
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return [`${at} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`]
      if (schema.minimum !== undefined && value < schema.minimum) return [`${at} must be ≥ ${schema.minimum}`]
      if (schema.maximum !== undefined && value > schema.maximum) return [`${at} must be ≤ ${schema.maximum}`]
      return []
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at} must be a boolean`]
  }
}
