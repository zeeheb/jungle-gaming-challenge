// Preloaded by bunfig.toml. Integration tests drop and recreate the schema, so
// the application under test must never see the development DATABASE_URL.
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';

// The app under test must not consume or publish on the shared queues on its
// own: messaging tests drive the consumer and the relay explicitly, against
// queues created just for them.
process.env['CONSUMER_ENABLED'] = 'false';
process.env['OUTBOX_RELAY_ENABLED'] = 'false';
