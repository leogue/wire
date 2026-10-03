// Writes the JSON Schema of each file kind to schemas/, for editors and for the agent.
// Run after changing a zod schema: `npm run schema`. A test fails when the files are out of date.
import { writeFileSync } from 'node:fs';
import { jsonSchemas } from '../src/json-schema.ts';

for (const [name, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), schema);
}
