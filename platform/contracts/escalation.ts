import { z } from "zod";

export const EscalationReasonKindSchema = z.enum([
  "ambiguous_intent",
  "missing_context",
  "policy_uncertain",
  "destructive_action_unverified",
  "out_of_scope",
  "stuck_after_retries",
  "policy_ask",
  "other",
]);

export type EscalationReasonKind = z.infer<typeof EscalationReasonKindSchema>;
