import { useEffect, useEffectEvent } from "react";

export function useLoadOnConnect(
  connected: boolean,
  load: () => Promise<unknown> | void,
) {
  const runLoad = useEffectEvent(() => {
    void load();
  });

  useEffect(() => {
    if (!connected) return;
    runLoad();
  }, [connected]);
}
