# Payroll and GoHighLevel integration

Source precedence

- Sales Payroll owns recognized closings, closed dollars, ticket classifications, attribution, appointments, show-ups and internal payroll and QA rules.
- GoHighLevel owns current CRM records and pipeline state. Validate live opportunity data against the configured sub-account and keep CRM pipeline amounts separate from Payroll's reported dollars closed.
- Call Scoring owns scored-call analysis, scorecards and transcripts. Scored-call counts describe that subset.

Initial connector

Payroll's aggregate RPC is installed on the Payroll database. The Brain code reads monthly USD sales totals on demand with a six-second deadline, outside the model prompt. Only a dedicated, explicitly configured Brain organization and key may invoke it. The shared chatbot Brain key must not be allowlisted. A trusted chatbot server must authenticate the caller and enforce the corresponding cross-app Payroll permission before choosing the dedicated key. Keep compensation, bank, face and credential records outside generic retrieval. Enable further datasets by enforcing the source permission for each request.

Provision PAYROLL_BRAIN_ORG_ID, PAYROLL_BRAIN_KEY_ID and PAYROLL_REPORTS_SERVER_KEY in Brain's server environment after the dedicated access path is ready. Use a fresh server credential through the deployment secret store. The GHL adapter accepts BRAIN_GHL_READ_TOKEN with opportunities.readonly and BRAIN_GHL_LOCATION_ID. It currently exposes only an internal, single-opportunity read. The supplied CRM and Payroll secrets were not saved by this change.

Coverage still to implement

- Map authenticated users and source permissions, with request-scope rules for departments, teams and employee records.
- Route appointment, show-up, no-show, rebooking, pipeline, contacts, performance and team questions to source-specific queries. Reuse Payroll's existing dashboard calculations instead of recalculating payout rules in the assistant.
- Add separately authorized payroll, bonus/fine, attendance and QA report tools. Handle account and biometric fields only in the owning application.
- Reconcile Payroll's November reporting output with the chatbot after deployment and test allowed and denied users, freshness and model-free reporting.
