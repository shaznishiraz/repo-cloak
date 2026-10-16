const device = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const encoder = new TextEncoder();

/** A single filename valid on macOS, Windows, and Linux. */
export function isPortableName(name: string): boolean {
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*]/.test(name) || /[. ]$/.test(name))
    return false;
  if (name.length > 255 || encoder.encode(name).length > 255) return false;
  if (device.test((name.split('.')[0] ?? '').trimEnd())) return false;
  return ![...name].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || (code >= 0xd800 && code <= 0xdfff);
  });
}
