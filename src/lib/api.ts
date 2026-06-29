import { invoke } from "@tauri-apps/api/core";

// Estados de licenca: 5+1 do contrato isipanel + condicoes locais.
export type LicenseStatus =
  | "valid"
  | "invalid"
  | "hwid_mismatch"
  | "expired"
  | "blocked"
  | "rate_limited"
  | "no_key"
  | "network_error"
  | "server_error"
  | "clock_error"
  | "loading";

export interface LicenseState {
  status: LicenseStatus;
  has_key: boolean;
  edition?: string; // "free" | "pro"
  product_slug?: string | null;
  expires_at?: string | null;
  grace_until?: string | null;
  subscription_url?: string | null;
  support_url?: string | null;
  retry_after_s?: number | null;
  hwid_bound?: boolean | null;
  message?: string | null;
  checked_at_unix?: number | null;
}

export interface SidecarInfo {
  port: number;
  token: string;
}

export interface SidecarHealth {
  ok: boolean;
  service: string;
  version: string;
  migrations_applied: number;
  uptime_s: number;
}

// --- Comandos do core Rust ---

export const getLicenseState = () => invoke<LicenseState>("get_license_state");

export const submitLicenseKey = (key: string) =>
  invoke<LicenseState>("submit_license_key", { key });

export const revalidateLicense = () =>
  invoke<LicenseState>("revalidate_license");

export const clearLicense = () => invoke<LicenseState>("clear_license");

export const getHwidMasked = () => invoke<string>("get_hwid_masked");

export const getSidecarInfo = () => invoke<SidecarInfo>("get_sidecar_info");

// --- Atualizações (GitHub Releases) ---
const UPDATE_OWNER = "progestaodigital";
const UPDATE_REPO = "isiGroup";

export const getAppVersion = () => invoke<string>("get_app_version");

export interface ReleaseInfo {
  version: string; // tag sem 'v'
  name: string;
  body: string; // changelog
  htmlUrl: string;
  downloadUrl: string | null; // asset .exe/.msi
  publishedAt: string;
}

interface GhAsset { name: string; browser_download_url: string }
interface GhRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  assets?: GhAsset[];
}

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return null; // sem releases ainda / repo privado / rate limit
    const r = (await res.json()) as GhRelease;
    const tag = r.tag_name ?? "";
    const asset = (r.assets ?? []).find((a) => /\.(exe|msi)$/i.test(a.name));
    return {
      version: tag.replace(/^v/i, ""),
      name: r.name ?? tag,
      body: r.body ?? "",
      htmlUrl: r.html_url ?? `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`,
      downloadUrl: asset?.browser_download_url ?? null,
      publishedAt: r.published_at ?? "",
    };
  } catch {
    return null;
  }
}

// Compara versões no estilo semver (a > b?).
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// --- API local do sidecar (127.0.0.1 + token de sessao) ---

let cachedInfo: SidecarInfo | null = null;

async function sidecar<T>(path: string, init?: RequestInit): Promise<T> {
  if (!cachedInfo) cachedInfo = await getSidecarInfo();
  const res = await fetch(`http://127.0.0.1:${cachedInfo.port}${path}`, {
    ...init,
    headers: { "x-isi-token": cachedInfo.token, ...(init?.headers ?? {}) },
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`sidecar ${path} HTTP ${res.status}`);
  }
  return res.json();
}

export const fetchSidecarHealth = () => sidecar<SidecarHealth>("/health");

// Informa ao sidecar a edição da licença (gate de recursos Pro no motor de automação).
export const setSidecarEdition = (edition: string) =>
  sidecar<{ edition: string }>("/edition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edition }),
  });

// Conexao WhatsApp
export type ConnStatus = "disconnected" | "connecting" | "qr" | "connected";
export interface ConnectionState {
  status: ConnStatus;
  qr: string | null; // data URL
  me: { jid: string; name: string | null } | null;
  last_error: string | null;
}

export const startConnection = () =>
  sidecar<ConnectionState>("/connection/start", { method: "POST" });
export const getConnectionStatus = () =>
  sidecar<ConnectionState>("/connection/status");
export const logoutConnection = () =>
  sidecar<ConnectionState>("/connection/logout", { method: "POST" });

// --- Contas / chips (multi-chip, Milestone 2) ---
export interface Account {
  id: number;
  label: string;
  jid: string | null;
  proxy_url: string | null;
  proxy_enabled: boolean;
  status: ConnStatus;
  qr: string | null;
  me: { jid: string; lid?: string | null; name: string | null } | null;
  groups: number;
  admin_groups: number;
}

export const listAccounts = () =>
  sidecar<{ accounts: Account[]; edition: string }>("/accounts");
export const addAccount = (label: string) =>
  sidecar<{ id?: number; error?: string; message?: string }>("/accounts", {
    method: "POST",
    ...jbody({ label }),
  });
export const deleteAccount = (id: number) =>
  sidecar<{ ok?: boolean; error?: string; message?: string }>(`/accounts/${id}`, {
    method: "DELETE",
  });
export const connectAccount = (id: number) =>
  sidecar<{ status: ConnStatus }>(`/accounts/${id}/connect`, { method: "POST" });
export const logoutAccount = (id: number) =>
  sidecar<{ status: ConnStatus }>(`/accounts/${id}/logout`, { method: "POST" });
export const syncAccount = (id: number) =>
  sidecar<SyncResult>(`/accounts/${id}/sync`, { method: "POST" });
export const setAccountProxy = (
  id: number,
  proxy_url: string | null,
  proxy_enabled: boolean
) =>
  sidecar<{ ok?: boolean; error?: string; message?: string }>(`/accounts/${id}/proxy`, {
    method: "POST",
    ...jbody({ proxy_url, proxy_enabled }),
  });

export const testProxy = (proxy_url: string) =>
  sidecar<{ ok: boolean; ip?: string; error?: string }>("/proxy/test", {
    method: "POST",
    ...jbody({ proxy_url }),
  });

// Cobertura group-first: quais chips cobrem cada grupo selecionado.
export interface Coverage {
  total_groups: number;
  by_account: { account_id: number; label: string; covers: number; jids: string[] }[];
  uncovered: { jid: string; name: string | null }[];
}
export const getCoverage = (group_jids: string[], account_ids: number[]) =>
  sidecar<Coverage>("/coverage", { method: "POST", ...jbody({ group_jids, account_ids }) });

// Alvos
export interface Target {
  id: number;
  account_id?: number;
  jid: string;
  name: string;
  type: "group" | "community_announce" | "community_subgroup";
  is_admin: number;
  last_synced_at: string | null;
}
export interface SyncResult {
  synced?: number;
  admin?: number;
  communities?: number;
  error?: string;
  message?: string;
}

export const syncTargets = () =>
  sidecar<SyncResult>("/targets/sync", { method: "POST" });
export const listTargets = () =>
  sidecar<{ targets: Target[] }>("/targets");

// Agendamentos
export type ScheduleStatus =
  | "pending"
  | "sending"
  | "sent"
  | "partial"
  | "failed"
  | "canceled";

export type ScheduleKind = "once" | "recurring";

export interface ScheduleRow {
  id: number;
  name: string | null;
  scheduled_at: string | null;
  payload_type: string;
  content_mode: "broadcast" | "per_target";
  status: ScheduleStatus | "active";
  created_at: string;
  kind: ScheduleKind;
  recur_dow: number | null;
  recur_time: string | null;
  last_run_at: string | null;
  total: number;
  sent: number | null;
  failed: number | null;
  skipped: number | null;
  chips: string | null; // labels dos chips usados (GROUP_CONCAT), multi-chip
}

export type PayloadType = "text" | "image" | "audio" | "video" | "poll" | "sequence";
export type StepType = "text" | "image" | "audio" | "video" | "poll";

export interface ApiStep {
  type: StepType;
  text?: string; // corpo do texto OU legenda (imagem/vídeo)
  media?: MediaInfo;
  poll?: PollSpec;
}

export interface MediaInfo {
  stored_path: string;
  mimetype: string;
  kind: string;
  duration_seconds: number | null;
  waveform_json: string | null;
}

export interface PollSpec {
  name: string;
  values: string[];
  selectableCount: number;
}

export interface NewSchedule {
  name?: string;
  kind: ScheduleKind;
  scheduled_at?: string; // ISO (once)
  recur_dow?: number; // 0-6 (recurring)
  recur_time?: string; // HH:MM (recurring)
  content_mode: "broadcast" | "per_target";
  payload_type: PayloadType;
  default_text?: string;
  steps?: ApiStep[]; // sequência multi-formato (broadcast)
  step_min_s?: number;
  step_max_s?: number;
  media?: MediaInfo;
  poll?: PollSpec;
  account_ids?: number[]; // pool de chips (multi-chip) — scheduler rotaciona por execução
  targets: Array<{ target_id: number; account_id?: number | null; skipped?: boolean; message?: string }>;
}

export const deleteSchedule = (id: number) =>
  sidecar<{ ok?: boolean }>(`/schedules/${id}`, { method: "DELETE" });

export const rescheduleSchedule = (
  id: number,
  body: { scheduled_at?: string; recur_dow?: number; recur_time?: string }
) =>
  sidecar<{ ok?: boolean; error?: string }>(`/schedules/${id}/reschedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// --- Automações & Gatilhos ---
export type TriggerType = "message" | "message_link" | "join" | "leave";
export type MatchType = "starts_with" | "contains" | "ends_with" | "exact";
export type ActionType = "group_message" | "dm" | "remove" | "webhook";

export interface StoredStep {
  payload_type?: string;
  body_json?: string;
  media?: MediaInfo | null;
}
export interface RuleAction {
  action_type: ActionType;
  order_index: number;
  config: {
    text?: string;
    url?: string;
    secret?: string;
    steps?: StoredStep[];
    step_min_s?: number;
    step_max_s?: number;
    delay_min_s?: number;
    delay_max_s?: number;
  };
}
export interface Rule {
  id: number;
  name: string;
  enabled: number;
  trigger_type: TriggerType;
  match_type: MatchType | null;
  pattern: string | null;
  case_sensitive: number;
  scope: string[];
  account_ids: number[]; // chips permitidos (vazio = qualquer membro)
  actions: RuleAction[];
}
export interface NewRuleAction {
  type: ActionType;
  text?: string; // legado (texto simples)
  steps?: ApiStep[]; // sequência rica (group_message / dm)
  step_min_s?: number;
  step_max_s?: number;
  url?: string;
  secret?: string;
  delay_min_s?: number; // intervalo irregular antes da próxima ação
  delay_max_s?: number;
}
export interface NewRule {
  name: string;
  trigger_type: TriggerType;
  match_type?: MatchType;
  pattern?: string;
  case_sensitive: boolean;
  scope: string[]; // jids dos grupos; vazio = todos
  account_ids?: number[]; // chips permitidos (multi-chip); vazio = qualquer membro
  actions: NewRuleAction[];
}
export interface AutoLog {
  id: number;
  rule_name: string | null;
  chip_label?: string | null;
  target_jid: string;
  sender_e164: string | null;
  matched_text: string;
  actions_taken: string;
  created_at: string;
}

const jbody = (b: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

export const listRules = () => sidecar<{ rules: Rule[] }>("/automation/rules");
export const createRule = (r: NewRule) =>
  sidecar<{ id: number }>("/automation/rules", { method: "POST", ...jbody(r) });
export const updateRule = (id: number, r: NewRule) =>
  sidecar<{ ok?: boolean }>(`/automation/rules/${id}`, { method: "PUT", ...jbody(r) });
export const toggleRule = (id: number) =>
  sidecar<{ enabled: number }>(`/automation/rules/${id}/toggle`, { method: "POST" });
export const deleteRule = (id: number) =>
  sidecar<{ ok?: boolean }>(`/automation/rules/${id}`, { method: "DELETE" });
export const listAutoLogs = () => sidecar<{ logs: AutoLog[] }>("/automation/logs");

export async function uploadMedia(file: File): Promise<MediaInfo> {
  if (!cachedInfo) cachedInfo = await getSidecarInfo();
  const buf = await file.arrayBuffer();
  const res = await fetch(`http://127.0.0.1:${cachedInfo.port}/media/upload`, {
    method: "POST",
    headers: {
      "x-isi-token": cachedInfo.token,
      "content-type": file.type || "application/octet-stream",
      "x-filename": encodeURIComponent(file.name),
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
  const { media } = await res.json();
  return media as MediaInfo;
}

export const createSchedule = (s: NewSchedule) =>
  sidecar<{ id: number }>("/schedules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });

export const listSchedules = () =>
  sidecar<{ schedules: ScheduleRow[] }>("/schedules");

export const cancelSchedule = (id: number) =>
  sidecar<{ ok?: boolean; error?: string }>(`/schedules/${id}/cancel`, {
    method: "POST",
  });
