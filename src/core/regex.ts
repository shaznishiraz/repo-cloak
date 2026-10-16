/** JS capture substitutions, without prefix/suffix copying or re-running a regex. */
export function expandReplacement(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token: string, capture: string) => {
    if (capture === '$') return '$';
    if (capture === '&') return match[0];
    if (capture === '`' || capture === "'")
      throw new Error('Regex replacements cannot copy the entire input prefix or suffix');
    if (capture.startsWith('<'))
      return match.groups ? (match.groups[capture.slice(1, -1)] ?? '') : token;
    const index = Number(capture);
    if (index > 0 && index < match.length) return match[index] ?? '';
    if (capture.length === 2) {
      const first = Number(capture[0]);
      if (first > 0 && first < match.length) return (match[first] ?? '') + capture.slice(1);
    }
    return token;
  });
}
