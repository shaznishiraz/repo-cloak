export class ConflictError extends Error {
  readonly exitCode = 2;
}
/** A user regex ran out of time. Callers must stop, because its matches are unknown. */
export class RegexLimitError extends Error {}
