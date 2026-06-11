/** Raised when fetched content cannot be parsed/normalized. Fetch failures are first-class data. */
export class AdapterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AdapterError';
  }
}
