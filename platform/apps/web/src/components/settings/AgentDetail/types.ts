import type { useResolvedCredentialQuery } from "../../../hooks/useServerStateQueries";

export type RuntimeCredentialState = ReturnType<
  typeof useResolvedCredentialQuery
>["data"];
