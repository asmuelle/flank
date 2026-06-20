import { DELTA_STATES, SOURCE_TYPES, TRIAGE_CLASSES } from '@flank/core';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  APPEND_ONLY_TABLES,
  alerts,
  battlecardSections,
  claims,
  competitors,
  coverageRuns,
  deltaStateEnum,
  deltas,
  dossierSections,
  snapshots,
  sourceTypeEnum,
  sources,
  triageClassEnum,
  workspaces,
} from './schema';

describe('drizzle schema (no live database required)', () => {
  it('defines every table from the DESIGN.md data model', () => {
    // Arrange
    const tables = [
      workspaces,
      competitors,
      sources,
      snapshots,
      deltas,
      claims,
      dossierSections,
      battlecardSections,
      alerts,
      coverageRuns,
    ];

    // Act
    const names = tables.map((table) => getTableName(table));

    // Assert
    expect(names).toEqual([
      'workspace',
      'competitor',
      'source',
      'snapshot',
      'delta',
      'claim',
      'dossier_section',
      'battlecard_section',
      'alert',
      'coverage_run',
    ]);
  });

  it('mirrors the canonical enums from @flank/core exactly', () => {
    expect(deltaStateEnum.enumValues).toEqual([...DELTA_STATES]);
    expect(triageClassEnum.enumValues).toEqual([...TRIAGE_CLASSES]);
    expect(sourceTypeEnum.enumValues).toEqual([...SOURCE_TYPES]);
  });

  it('keeps history tables append-only: no updated_at/deleted_at columns exist (Invariant 5)', () => {
    for (const table of APPEND_ONLY_TABLES) {
      const columnNames = Object.values(getTableColumns(table)).map((column) => column.name);
      expect(columnNames).not.toContain('updated_at');
      expect(columnNames).not.toContain('deleted_at');
    }
    expect(APPEND_ONLY_TABLES.map((table) => getTableName(table))).toEqual([
      'snapshot',
      'delta',
      'claim',
      'dossier_section',
      'battlecard_section',
    ]);
  });

  it('pins every claim with quote + offsets + URL + timestamps (Invariant 1)', () => {
    const columnNames = Object.values(getTableColumns(claims)).map((column) => column.name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        'quote_text',
        'char_start',
        'char_end',
        'source_url',
        'captured_at',
        'verified_at',
      ]),
    );
  });

  it('scopes tenant-facing tables by workspace_id (Invariant 8)', () => {
    for (const table of [competitors, alerts, coverageRuns]) {
      const columnNames = Object.values(getTableColumns(table)).map((column) => column.name);
      expect(columnNames).toContain('workspace_id');
    }
  });

  it('meters coverage and COGS per run (Invariants 6 & 7)', () => {
    const columnNames = Object.values(getTableColumns(coverageRuns)).map((column) => column.name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        'sources_checked',
        'fetch_failures',
        'deltas_found',
        'material_deltas',
        'llm_calls',
        'llm_cost_micros',
      ]),
    );
  });

  it('supports the pricing confirmation firewall on deltas (Invariant 3)', () => {
    const columnNames = Object.values(getTableColumns(deltas)).map((column) => column.name);
    expect(columnNames).toContain('confirmed_by_snapshot_id');
    expect(columnNames).toContain('state');
  });
});
