export interface KeyMeta {
  key: string;
  displayName: string;
  unit: string;
  decimals: number;
  min: number;
  max: number;
  /** Value type; inferred from the key and values when missing. */
  type?: 'number' | 'boolean' | 'string';
  /** Labels for boolean / coded values, e.g. { "1": "Running", "0": "Stopped" }. */
  states?: Record<string, string>;
}
