# Payroll and GoHighLevel integration

Payroll owns recognized sales totals and ticket categories. GHL owns current CRM state. Call Scoring owns scorecards and transcripts.

Production access requires BOTH the configured Brain organization/key and an authenticated chatbot user token. Brain validates that token against CHATBOT_AUTH_URL, checks the active chatbot profile, then checks the matching active Payroll admin account and current role permissions on every source request. Only dashboard.view (monthly totals) or pipeline.view (CRM lookup), or the source administrator wildcard, grants access. Missing accounts, disabled users, failed lookups and malformed roles deny access. No client-supplied email or role is trusted.

An optional SOURCE_ACCOUNT_ALIASES JSON map binds verified chatbot user UUIDs to explicitly approved Payroll emails. Unmapped users must have matching verified emails. Employee/team-specific datasets are not enabled by this company-wide reporting path.

Brain production configuration: PAYROLL_BRAIN_ORG_ID, PAYROLL_BRAIN_KEY_ID, PAYROLL_REPORTS_SERVER_KEY, CHATBOT_AUTH_URL, CHATBOT_AUTH_PUBLISHABLE_KEY, BRAIN_GHL_READ_TOKEN and BRAIN_GHL_LOCATION_ID. Chatbot production: SOURCE_REPORTS_ENABLED=true. The configured Brain key alone never grants source access. Secrets stay server-side.

Implemented: model-free monthly company sales totals (and HT/LT headline filters), plus explicit "GHL opportunity <id>" lookups. Payroll reports use source UTC rules, require a single month beginning on day 1, and reject unsupported consultant/practice/outcome filters. CRM records must match the configured subaccount. Neither route sends source data to a model.

Still pending: client-level Payroll lists, team/consultant breakdowns, appointments, show-ups, attendance, QA and separately scoped employee reports; generalized GHL lookup by name and pipeline aggregates; permission-aware source context for coaching/writing. Bank and biometric fields remain outside generic retrieval.
