import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

const JournalSchema = z.object({
  entries: z.array(z.object({ tag: z.string() })),
});
const drizzleDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

describe('Drizzle migration metadata', () => {
  it('journals every SQL migration in filename order', () => {
    // Arrange
    const migrationTags = readdirSync(drizzleDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => name.slice(0, -'.sql'.length));
    const journalText = readFileSync(`${drizzleDir}/meta/_journal.json`, 'utf8');
    const journal = JournalSchema.parse(JSON.parse(journalText));

    // Act
    const journalTags = journal.entries.map(({ tag }) => tag);

    // Assert
    expect(journalTags).toEqual(migrationTags);
  });

  it('guards OKF delivery history against updates and deletes', () => {
    // Arrange & Act
    const migration = readFileSync(`${drizzleDir}/0007_okf_deliveries.sql`, 'utf8');

    // Assert
    expect(migration).toContain(
      'CREATE TRIGGER okf_delivery_append_only BEFORE UPDATE OR DELETE ON "okf_delivery"',
    );
  });
});
