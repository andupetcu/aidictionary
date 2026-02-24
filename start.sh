#!/bin/sh
# Run seed (idempotent - uses ON CONFLICT DO UPDATE)
echo "Seeding database..."
node scripts/seed.mjs 2>&1 || echo "Seed warning (may already be seeded)"
echo "Starting server..."
exec node dist/server/entry.mjs
