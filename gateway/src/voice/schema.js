// Gemini function declarations accept only an OpenAPI-3 subset of JSON schema; anything else closes the
// Live socket with 1007 ("Unknown name \"additionalProperties\""). Whitelist instead of blacklist.
const GEMINI_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minimum', 'maximum', 'minItems', 'maxItems']);

export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_KEYS.has(key)) continue;
    if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value).map(([name, spec]) => [name, toGeminiSchema(spec)]));
    else if (key === 'items') out.items = toGeminiSchema(value);
    else if (key === 'required' && !value.length) continue;
    else out[key] = value;
  }
  return out;
}

/** Gemini rejects an OBJECT schema without properties, so parameterless tools are declared without `parameters`. */
export function geminiDeclarations(defs) {
  return defs.map((d) => {
    const parameters = toGeminiSchema(d.parameters);
    const hasParams = parameters?.properties && Object.keys(parameters.properties).length > 0;
    return { name: d.name, description: d.description, ...(d.async ? { behavior: 'NON_BLOCKING' } : {}), ...(hasParams ? { parameters } : {}) };
  });
}
