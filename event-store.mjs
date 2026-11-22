export function createEventStore({ db, vault }) {
  if (!db?.query || !vault?.seal) throw new Error('Missing event storage dependencies');
  return async function saveEvents(accountId, events) {
    if (!Array.isArray(events) || events.length > 100) throw new Error('Invalid event count');
    const unique = new Map();
    for (const event of events) {
      if (!event || typeof event.webhookEventId !== 'string' || event.webhookEventId.length < 1 || event.webhookEventId.length > 100) throw new Error('Invalid event identifier');
      unique.set(event.webhookEventId, { event_id: event.webhookEventId, payload: vault.seal(accountId, JSON.stringify(event)) });
    }
    if (!unique.size) return;
    await db.query('select linebot_private.store_events($1,$2::jsonb)', [accountId, JSON.stringify([...unique.values()])]);
  };
}
