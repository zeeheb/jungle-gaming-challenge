// Preloaded by bunfig.toml. Integration tests drop and recreate the schema, so
// the application under test must never see the development DATABASE_URL.
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';
