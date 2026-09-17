import type { AdminUser, DecorLayer, MapSlotSummary, UploadedImage, WorldMapData } from "@bug-game/shared";

const SERVER_URL = "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export function getCurrentUser(): Promise<{ user: AdminUser | null }> {
  return request("/auth/me");
}

export function logout(): Promise<{ ok: true }> {
  return request("/auth/logout", { method: "POST" });
}

export function googleLoginUrl(): string {
  return `${SERVER_URL}/auth/google`;
}

export function listMapSlots(): Promise<MapSlotSummary[]> {
  return request("/admin/maps");
}

export function getMap(slot: string): Promise<WorldMapData> {
  return request(`/admin/map/${encodeURIComponent(slot)}`);
}

export function saveMap(slot: string, data: WorldMapData, thumbnail: string | null): Promise<{ ok: true }> {
  return request(`/admin/map/${encodeURIComponent(slot)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, thumbnail }),
  });
}

export function deleteMapSlot(slot: string): Promise<{ ok: true }> {
  return request(`/admin/map/${encodeURIComponent(slot)}`, { method: "DELETE" });
}

export async function uploadImage(
  file: File,
  options?: { name?: string; category?: string; defaultLayer?: DecorLayer }
): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("image", file);
  if (options?.name) formData.append("name", options.name);
  if (options?.category) formData.append("category", options.category);
  if (options?.defaultLayer) formData.append("defaultLayer", options.defaultLayer);
  return request("/admin/upload", { method: "POST", body: formData });
}

export function listUploads(): Promise<UploadedImage[]> {
  return request("/admin/uploads");
}

export function resolveImageUrl(url: string): string {
  return url.startsWith("http") ? url : `${SERVER_URL}${url}`;
}
