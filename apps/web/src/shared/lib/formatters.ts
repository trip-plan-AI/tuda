export function getEmailPrefix(email: string): string {
  return email.split('@')[0] ?? email;
}

export function formatBudget(amount: number): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(amount);
}

export function calcNights(startDate?: string | null, endDate?: string | null): number | null {
  if (!startDate || !endDate) return null;
  const diff = safeParseDateString(endDate).getTime() - safeParseDateString(startDate).getTime();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

/**
 * Safely parse ISO date strings that might lack timezone info.
 *
 * JavaScript's new Date() interprets ISO strings without 'Z' as UTC, which causes
 * +3 hour offsets for users in UTC+3. This function extracts just the date part
 * and creates a local date to avoid timezone confusion.
 *
 * Examples:
 * - "2026-03-19" → local date 2026-03-19 00:00:00
 * - "2026-03-19T21:23:00" → local date 2026-03-19 00:00:00 (time discarded)
 * - "2026-03-19T21:23:00Z" → local date equivalent of UTC
 */
export function safeParseDateString(dateString: string | null | undefined): Date {
  if (!dateString) return new Date();

  // Extract just the date part (YYYY-MM-DD)
  const datePart = dateString.split('T')[0];
  if (!datePart) return new Date();

  // Parse as local date: "2026-03-19" → 2026-03-19 00:00:00 local
  const parts = datePart.split('-').map((p) => parseInt(p, 10) || 0);
  const [year, month, day] = [parts[0] || 2000, parts[1] || 1, parts[2] || 1];
  const date = new Date();
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
}
