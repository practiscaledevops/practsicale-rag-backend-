/** A short recovery message for operators. Keep raw provider payloads in logs. */
export function ingestionErrorSummary(error: string | null | undefined): string {
  const text = error?.trim() ?? "";
  if (!text) return "Processing failed. Open the run to review it and retry.";
  if (/timeout|timed out|statement cancellation|canceling statement/i.test(text)) {
    return "Processing took too long. Retry the source sync or file processing.";
  }
  if (/unauthorized|invalid.*(?:key|token)|\b401\b|\b403\b/i.test(text)) {
    return "The source rejected the connection. Check its credentials and access, then retry.";
  }
  if (/<(?:!doctype|html|head|body)\b|\b50[0234]\b|\b52[0-9]\b|bad gateway|service unavailable/i.test(text)) {
    return "A connected service was temporarily unavailable. Retry the source sync or file processing.";
  }
  if (/response.*too large|payload.*too large|\b413\b/i.test(text)) {
    return "The source returned too much data at once. Check the source batch size and retry.";
  }
  if (/invalid array length/i.test(text)) return "File processing failed. Open Processing to review the upload and retry.";
  if (/PGRST202|42883|migration.*required/i.test(text)) return "A required database update is missing. Ask an administrator to check the deployment.";
  // Do not expose unknown provider responses, URLs, credentials or source data.
  return "Processing failed. Open the source or Processing to review the run and retry.";
}
