import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Outbox lag for the metrics: how many events wait to be published and for
 * how long the oldest has waited. Counted over the partial index of pending
 * rows, so it stays cheap however large the published history grows.
 */
export async function outboxBacklog(orm: MikroORM): Promise<{ pending: number; oldestAgeSeconds: number }> {
  const [row] = await orm.em.fork().execute<{ pending: number; age: string | null }[]>(
    `select count(*)::int as pending, extract(epoch from now() - min(occurred_at)) as age
       from outbox_messages
      where published_at is null`,
  );
  return { pending: row?.pending ?? 0, oldestAgeSeconds: Number(row?.age ?? 0) };
}
