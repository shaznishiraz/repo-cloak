import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';

export async function readJson(
  file: string,
  input: Readable & { isTTY?: boolean } = process.stdin,
): Promise<unknown> {
  let text: string;
  if (file === '-') {
    if (input.isTTY) throw new Error('Pipe a JSON profile to stdin or pass a file path');
    input.setEncoding('utf8');
    text = '';
    for await (const chunk of input) text += String(chunk);
  } else {
    text = await readFile(file, 'utf8');
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (cause) {
    throw new Error(`${file}: invalid JSON`, { cause });
  }
}
