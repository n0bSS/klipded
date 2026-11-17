import { api } from './api.js';
import { loadJSON, saveJSON } from './util.js';

const K_DEVICE = 'kd.device';
const K_KEY = 'kd.key';
const K_LIC = 'kd.license';

export function deviceId() {
  let id = localStorage.getItem(K_DEVICE);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '').slice(0, 24);
    try { localStorage.setItem(K_DEVICE, id); } catch {}
  }
  return id;
}

export const savedKey = () => localStorage.getItem(K_KEY) || '';
export const cachedLicense = () => loadJSON(K_LIC, null);

export function forgetKey() {
  localStorage.removeItem(K_KEY);
  localStorage.removeItem(K_LIC);
}

export async function activate(key) {
  const clean = String(key || '').toUpperCase().replace(/\s+/g, '');
  const res = await api.activate(clean, deviceId());
  try { localStorage.setItem(K_KEY, clean); } catch {}
  saveJSON(K_LIC, { ...res.license, checkedAt: Date.now() });
  return res.license;
}

export function updateUsage(usage) {
  const lic = cachedLicense();
  if (!lic || !usage) return lic;
  lic.usedSeconds = usage.usedSeconds;
  lic.quotaSeconds = usage.quotaSeconds;
  lic.remainingSeconds = Math.max(0, usage.quotaSeconds - usage.usedSeconds);
  saveJSON(K_LIC, lic);
  return lic;
}

export function daysLeft(lic) {
  if (!lic) return 0;
  if (!lic.expiresAt) return lic.durationDays;
  return Math.max(0, Math.ceil((new Date(lic.expiresAt) - Date.now()) / 86400000));
}
