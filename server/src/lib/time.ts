/**
 * Format a Date into Beijing time (+08:00) RFC3339 string required by WeChat APIs.
 */
export function formatBeijingRfc3339(date: Date, includeMillis = false): string {
  const beijingMs = date.getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(beijingMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  if (!includeMillis) {
    return `${y}-${m}-${day}T${h}:${min}:${s}+08:00`;
  }
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${day}T${h}:${min}:${s}.${ms}+08:00`;
}
