export type StorageFailure = "storage" | "daily_reads" | "daily_writes";

/** Match provider categories, never arbitrary SQL errors or provider bodies. */
export function storageFailure(cause: unknown): StorageFailure | null {
  if (!(cause instanceof Error)) return null;
  const text = `${cause.message} ${cause.cause instanceof Error ? cause.cause.message : ""}`;
  if (/Exceeded maximum DB size|maximum account storage limit|SQLITE_FULL|database or disk is full/i.test(text)) return "storage";
  if (/D1.{0,60}(?:daily row read limit|daily read limit)/i.test(text)) return "daily_reads";
  if (/D1.{0,60}(?:daily row write limit|daily write limit)/i.test(text)) return "daily_writes";
  return null;
}

export function storageMessage(kind: StorageFailure): string {
  return kind === "storage" ? "Storage is full. Background discovery is paused while space is recovered. Please try again later."
    : "The daily database allowance has been reached. Please try again after midnight UTC.";
}
