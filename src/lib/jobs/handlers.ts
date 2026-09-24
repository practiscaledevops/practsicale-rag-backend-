// The job-type registry. Add a new background job (for a new data platform or a
// new kind of analysis) by writing a JobHandler and registering it here.

import type { JobHandler } from "@/lib/jobs/engine";
import { deepCallAuditHandler } from "@/lib/jobs/deep-call-audit";

export const JOB_HANDLERS: Record<string, JobHandler> = {
  deep_call_audit: deepCallAuditHandler,
};
