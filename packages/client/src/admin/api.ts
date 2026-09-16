import type { AdminUser, WorldMapData } from "@bug-game/shared";

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

export function getMap(): Promise<WorldMapData> {
  return request("/admin/map");
}

export function saveMap(data: WorldMapData): Promise<{ ok: true }> {
  return request("/admin/map", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function uploadImage(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("image", file);
  return request("/admin/upload", { method: "POST", body: formData });
}

export function resolveImageUrl(url: string): string {
  return url.startsWith("http") ? url : `${SERVER_URL}${url}`;
}
