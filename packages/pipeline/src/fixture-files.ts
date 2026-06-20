import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_FILE_NAMES, type FixtureBundle } from './fixture-run';

/** Load the checked-in sample documents from a fixtures directory. */
export const loadFixtureBundleSync = (fixturesDir: string): FixtureBundle => {
  const read = (name: string): string => {
    try {
      return readFileSync(join(fixturesDir, name), 'utf8');
    } catch (error) {
      throw new Error(`could not read fixture ${name} in ${fixturesDir}`, { cause: error });
    }
  };
  return Object.freeze({
    changelogV1: read(FIXTURE_FILE_NAMES.changelogV1),
    changelogV2: read(FIXTURE_FILE_NAMES.changelogV2),
    jobsV1: read(FIXTURE_FILE_NAMES.jobsV1),
    jobsV2: read(FIXTURE_FILE_NAMES.jobsV2),
    pricingV1: read(FIXTURE_FILE_NAMES.pricingV1),
    pricingV2: read(FIXTURE_FILE_NAMES.pricingV2),
  });
};
