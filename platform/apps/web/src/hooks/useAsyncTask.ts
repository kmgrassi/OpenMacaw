import { useCallback, useState } from "react";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAsyncTask<T>(task: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<T | null> => {
    setLoading(true);
    setError(null);

    try {
      const result = await task();
      setData(result);
      return result;
    } catch (error) {
      setError(toErrorMessage(error));
      return null;
    } finally {
      setLoading(false);
    }
  }, [task]);

  return {
    data,
    loading,
    error,
    run,
    setData,
    setError,
  };
}
