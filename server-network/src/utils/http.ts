import { z } from 'zod';

export const idParam = z.object({ id: z.string().min(1).max(64) });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export function pageArgs(q: { page: number; page_size: number }) {
  return { skip: (q.page - 1) * q.page_size, take: q.page_size };
}

export function pageBody<T>(items: T[], total: number, q: { page: number; page_size: number }) {
  return { items, page: q.page, page_size: q.page_size, total };
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const ORG_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
export const POLICY_CODE_RE = ORG_CODE_RE;
