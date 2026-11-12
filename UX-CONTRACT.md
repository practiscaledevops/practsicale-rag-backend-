# Back-office interaction contract

This records the existing product behavior and the corrected document-list contract. It does not change access or deletion policy.

| Capability | Canonical owner | Contract and authority |
|---|---|---|
| Permissions | `src/lib/auth/page-guard.ts`, `src/lib/auth/admin.ts` | Session resolves organization; every query remains scoped server-side. |
| Table selection | `src/components/ui/Bulk.tsx` | Select shown page only; changing visible identities prunes selection. Never imply all search results are selected. |
| Search | `src/components/ui/Input.tsx`, `src/lib/document-list.ts` | Committed query/type/page live in the URL; remote input debounces 300 ms, Enter submits, composition is respected, clear restores focus. |
| Pagination | Documents page and `document-list.ts` | 50 rows per database page, stable creation/id order, exact matching count, filter changes reset to page 1, removed last pages clamp to a valid page. |
| Select/listbox | `src/components/ui/Select.tsx` | Reuse the existing authored primitive; no new select is introduced by this change. |
| Dates | `src/lib/format.ts`, `src/lib/timezone.ts` | Use shared formatting; never substitute import date for occurrence or outcome date. |
| Feedback | `src/components/ui/Alert.tsx`, `LiveDocumentUpdates.tsx` | Inline persistent failure, explicit retry, loading status, separate empty result. Live refresh retains current URL filters. |
| Destructive actions | Existing document API, `ConfirmDialog.tsx` | Existing named-object permanent-delete confirmation and server permissions remain required. Pagination does not change what a confirmed deletion targets. |
| Scrollbar/theme | `src/app/globals.css` | Existing application tokens and overflow ownership remain canonical. |

The corrected server search covers titles, categories and owner metadata across all pages. Collection membership actions retain their existing behavior; collection-specific browsing remains in the Collections workspace. Search hints name the supported fields.

Verification evidence belongs in the workspace `verification` directory and in `test/document-list.test.ts`. Python-only external audit tooling may be unavailable; it is not a substitute for application tests and observed browser behavior.
