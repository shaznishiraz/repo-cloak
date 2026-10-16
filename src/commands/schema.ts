import { jsonSchema } from '../core/schemas.js';
import type { DocumentKind } from '../core/schemas.js';

export function printSchema(kind: DocumentKind, write: (text: string) => void): void {
  write(`${JSON.stringify(jsonSchema(kind), null, 2)}\n`);
}
