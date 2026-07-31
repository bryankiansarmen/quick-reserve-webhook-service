export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Structured JSON logging:
 * `{level, timestamp, service, event, meta}`.
 */
export function log(level: LogLevel, event: string, meta: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    level,
    timestamp: new Date().toISOString(),
    service: 'webhook-service',
    event,
    meta,
  });
  if (level === 'error') {
    console.error(entry);
  } else if (level === 'warn') {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}
