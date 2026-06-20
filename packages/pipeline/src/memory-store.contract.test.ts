import { MemoryFlankStore } from './memory-store';
import { runFlankStoreContract } from './store-contract';

// The in-memory store must satisfy the full FlankStore contract that the future DrizzleFlankStore
// will also be held to — same suite, swap the factory.
runFlankStoreContract('MemoryFlankStore', () => new MemoryFlankStore());
