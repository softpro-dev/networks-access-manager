'use client';
// LAN devices handed over by the SoftProIt.network.admin desktop app, which opens the console as
// `/?connected_devices=<JSON>` after scanning its /24 (a browser cannot read MAC addresses).
// Captured once on load, validated, kept in localStorage (no secrets: IPs and MACs of this LAN),
// and the parameter is stripped from the address bar. Used by "Add My PC" and bulk add.
import { useSyncExternalStore } from 'react';
import { normalizeMac } from './mac';

export interface ConnectedDevice {
  ip: string;
  mac: string;
  /** This PC (the one running the desktop app). */
  self?: boolean;
  hostname?: string;
  username?: string;
}

export interface ConnectedDevicesSnapshot {
  captured_at: string;
  devices: ConnectedDevice[];
}

export const CONNECTED_DEVICES_PARAM = 'connected_devices';
const KEY = 'nam.connected_devices';
const MAX_DEVICES = 1024;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Keep only well-formed entries; one per MAC, this PC first. Never throws. */
export function parseConnectedDevices(raw: unknown): ConnectedDevice[] {
  if (!Array.isArray(raw)) return [];
  const byMac = new Map<string, ConnectedDevice>();
  for (const item of raw.slice(0, MAX_DEVICES)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const mac = typeof o.mac === 'string' ? normalizeMac(o.mac) : null;
    const ip = typeof o.ip === 'string' && IPV4.test(o.ip) ? o.ip : null;
    if (!mac || !ip || byMac.has(mac)) continue;
    byMac.set(mac, { ip, mac, ...(o.self === true ? { self: true } : {}), hostname: str(o.hostname, 255), username: str(o.username, 256) });
  }
  return [...byMac.values()].sort((a, b) => Number(!!b.self) - Number(!!a.self));
}

let cache: ConnectedDevicesSnapshot | null | undefined;
const listeners = new Set<() => void>();

function read(): ConnectedDevicesSnapshot | null {
  if (cache === undefined) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as ConnectedDevicesSnapshot | null;
      cache = parsed && typeof parsed.captured_at === 'string' ? { captured_at: parsed.captured_at, devices: parseConnectedDevices(parsed.devices) } : null;
    } catch {
      cache = null;
    }
  }
  return cache;
}

function write(snapshot: ConnectedDevicesSnapshot) {
  cache = snapshot;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    /* storage blocked: keep it in memory for this tab */
  }
  for (const l of listeners) l();
}

/**
 * Store `?connected_devices=` from the current URL, if present. Returns true when the parameter was
 * there, so the caller can strip it from the address bar. A malformed value is ignored (the
 * previously stored list is kept).
 */
export function captureConnectedDevicesFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const value = new URLSearchParams(window.location.search).get(CONNECTED_DEVICES_PARAM);
  if (value === null) return false;
  try {
    write({ captured_at: new Date().toISOString(), devices: parseConnectedDevices(JSON.parse(value)) });
  } catch {
    /* not JSON: ignore */
  }
  return true;
}

/** Remove the parameter from the address bar without a navigation (keeps Next's history state). */
export function stripConnectedDevicesParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(CONNECTED_DEVICES_PARAM)) return;
  url.searchParams.delete(CONNECTED_DEVICES_PARAM);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = undefined;
      fn();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** The stored scan (null when the console was not opened from the desktop app yet). */
export function useConnectedDevices(): ConnectedDevicesSnapshot | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
