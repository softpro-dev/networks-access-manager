'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { captureConnectedDevicesFromUrl, stripConnectedDevicesParam } from '@/lib/connectedDevices';
import { ToastProvider } from '@/components/toast';

export function Providers({ children }: { children: ReactNode }) {
  // Capture ?connected_devices= during the first client render, before any child effect (e.g. the
  // auth redirect to /login) can navigate away and drop the query string; strip it after mount.
  const [hadDevicesParam] = useState(captureConnectedDevicesFromUrl);
  useEffect(() => {
    if (hadDevicesParam) stripConnectedDevicesParam();
  }, [hadDevicesParam]);
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: true,
            // Never retry client errors (401/403/404/409...); retry transient failures once.
            retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
