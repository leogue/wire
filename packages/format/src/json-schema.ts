import { z } from 'zod';
import { PartSchema } from './part.ts';
import { ProjectSchema, SheetSchema } from './project.ts';

const FILE_SCHEMAS = { part: PartSchema, sheet: SheetSchema, project: ProjectSchema };

/** JSON Schema text of each file kind (`part`, `sheet`, `project`). Refinements are not expressed. */
export function jsonSchemas(): Record<keyof typeof FILE_SCHEMAS, string> {
  const entries = Object.entries(FILE_SCHEMAS).map(([name, schema]) => {
    const json = { ...z.toJSONSchema(schema, { io: 'input' }), $id: `${name}.schema.json` };
    return [name, `${JSON.stringify(json, null, 2)}\n`];
  });
  return Object.fromEntries(entries);
}
