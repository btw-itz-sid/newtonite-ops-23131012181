"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/client/api";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // No websockets: data is refreshed by polling and when the tab regains focus.
            refetchInterval: 15_000,
            refetchOnWindowFocus: true,
            // Retrying a 4xx can't help (no access, not found, bad input), only network/5xx errors.
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
