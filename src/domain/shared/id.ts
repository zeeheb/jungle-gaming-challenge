// UUIDv7 starts with a timestamp, so new primary keys land at the end of the
// B-tree index instead of on random pages like v4 would.
export const newId = (): string => Bun.randomUUIDv7();
