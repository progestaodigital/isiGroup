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
  last_error: string | null;
  // true = desconectado, mas o app continua tentando religar sozinho (1x/min).
  retrying?: boolean;
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

// Seleções de grupos salvas (picker do agendador)
export interface GroupSelection {
  id: number;
  name: string;
  jids: string[];
  created_at: string;
  updated_at: string;
}

export const listSelections = () =>
  sidecar<{ selections: GroupSelection[] }>("/selections");
export const saveSelection = (name: string, jids: string[]) =>
  sidecar<{ id?: number; error?: string; message?: string }>("/selections", {
    method: "POST",
    ...jbody({ name, jids }),
  });
export const deleteSelection = (id: number) =>
  sidecar<{ ok?: boolean }>(`/selections/${id}`, { method: "DELETE" });

// Agendamentos
export type ScheduleStatus =
  | "pending"
  | "sending"
  | "sent"
  | "partial"
  | "failed"
  | "canceled";

export type ScheduleKind = "once" | "recurring";

// Filtro opcional de paridade da semana ISO (recorrentes). null = toda semana.
export type WeekParity = "odd" | "even";

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
  recur_week_mod: number | null; // 2 = filtro de paridade ativo; null = toda semana
  recur_week_rem: number | null; // 1 = semanas ímpares, 0 = pares
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
  recur_week_parity?: WeekParity; // ausente = toda semana
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
  body: {
    scheduled_at?: string;
    recur_dow?: number;
    recur_time?: string;
    recur_week_parity?: WeekParity;
  }
) =>
  sidecar<{ ok?: boolean; error?: string }>(`/schedules/${id}/reschedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// --- Automações & Gatilhos ---
export type TriggerType = "message" | "message_link" | "join" | "leave";
export type MatchType = "starts_with" | "contains" | "ends_with" | "exact";
export type ActionType = "group_message" | "dm" | "remove" | "webhook" | "delete_message";

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

// Detalhe completo de um agendamento (para reidratar o editor).
export interface ScheduleDetail {
  schedule: {
    id: number;
    name: string | null;
    kind: ScheduleKind;
    scheduled_at: string | null;
    recur_dow: number | null;
    recur_time: string | null;
    recur_week_parity: WeekParity | null;
    content_mode: "broadcast" | "per_target";
    payload_type: string;
    step_min_s: number | null;
    step_max_s: number | null;
    account_ids: number[];
  };
  steps: StoredStep[];
  targets: Array<{
    target_id: number;
    jid: string;
    name: string;
    message_json: string | null;
    account_id: number | null;
    status: string;
  }>;
}

export const getScheduleDetail = (id: number) =>
  sidecar<ScheduleDetail>(`/schedules/${id}`);

export const updateSchedule = (id: number, s: NewSchedule) =>
  sidecar<{ ok?: boolean; error?: string }>(`/schedules/${id}`, {
    method: "PUT",
    ...jbody(s),
  });

export const listSchedules = () =>
  sidecar<{ schedules: ScheduleRow[] }>("/schedules");

export const cancelSchedule = (id: number) =>
  sidecar<{ ok?: boolean; error?: string }>(`/schedules/${id}/cancel`, {
    method: "POST",
  });

// --- Ações em massa (bulk) ---
export type BulkOp =
  | "add_members"
  | "remove_members"
  | "promote"
  | "demote"
  | "set_name"
  | "set_description"
  | "set_picture"
  | "set_settings"
  | "set_group" // ação combinada (nome/descrição/imagem/config numa só)
  | "create_groups"; // cria grupos novos em sequência ({x} no nome = numeração)

export type BulkPace = "slow" | "normal" | "fast";

export interface BulkSettings {
  announce?: "all" | "admins"; // quem envia mensagens
  edit?: "all" | "admins"; // quem edita dados do grupo
  add?: "all" | "admins"; // quem adiciona membros
  approval?: "on" | "off"; // aprovar novos membros
}

export interface BulkParams {
  pace?: BulkPace;
  name?: string;
  description?: string;
  media_path?: string;
  settings?: BulkSettings;
  // create_groups: chip criador + numeração sequencial + participantes iniciais.
  account_id?: number;
  quantity?: number; // quantos grupos criar
  start?: number; // primeiro número da sequência ({x} no nome)
  admins?: string[]; // telefones a promover a admin
  members?: string[]; // telefones dos membros iniciais
}

export interface NewBulkJob {
  op: BulkOp;
  groups: Array<{ jid: string; name?: string }>;
  contacts?: string[]; // só ações de membro
  params?: BulkParams;
  run_at?: string; // ISO — agenda a execução; ausente/passado = agora
}

export interface BulkJobRow {
  id: number;
  op: BulkOp;
  status: "running" | "done" | "canceled" | "scheduled";
  params: BulkParams;
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  run_at: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface BulkJobItem {
  group_jid: string;
  group_name: string | null;
  contact: string | null;
  status: "pending" | "ok" | "failed" | "skipped";
  detail: string | null;
  account_id: number | null;
}

export interface BulkJobDetail {
  job: BulkJobRow;
  items: BulkJobItem[];
}

export const createBulkJob = (b: NewBulkJob) =>
  sidecar<{ id?: number; scheduled?: boolean; run_at?: string | null; error?: string; message?: string }>("/bulk", {
    method: "POST",
    ...jbody(b),
  });
export const listBulkJobs = () => sidecar<{ jobs: BulkJobRow[] }>("/bulk");
export const getBulkJob = (id: number) => sidecar<BulkJobDetail>(`/bulk/${id}`);
// Edita um disparo AGENDADO que ainda não começou (o motor recusa os demais).
export const updateBulkJob = (id: number, b: NewBulkJob) =>
  sidecar<{ ok?: boolean; run_at?: string; error?: string; message?: string }>(`/bulk/${id}`, {
    method: "PUT",
    ...jbody(b),
  });
export const cancelBulkJob = (id: number) =>
  sidecar<{ ok?: boolean }>(`/bulk/${id}/cancel`, { method: "POST" });

// --- Edição de grupos recorrente (modelo semanal + paridade de semana) ---
// Só operações de EDIÇÃO de grupo podem ser recorrentes — o motor recusa
// ações de membro e criação em série.
export type BulkRecurringStatus = "active" | "paused" | "canceled";

export interface NewBulkRecurring {
  name?: string;
  op: BulkOp; // set_group | set_name | set_description | set_picture | set_settings
  groups: Array<{ jid: string; name?: string }>;
  params: BulkParams;
  recur_dow: number; // 0-6
  recur_time: string; // HH:MM
  recur_week_parity?: WeekParity; // ausente = todas as semanas
}

export interface BulkRecurringRow {
  id: number;
  name: string | null;
  op: BulkOp;
  groups: Array<{ jid: string; name: string | null }>;
  params: BulkParams;
  recur_dow: number;
  recur_time: string;
  recur_week_parity: WeekParity | null;
  last_run_at: string | null;
  status: BulkRecurringStatus;
  created_at: string;
  // Resumo da execução mais recente gerada por este modelo (null = nunca rodou).
  last_job: {
    id: number;
    status: BulkJobRow["status"];
    ok: number;
    failed: number;
    skipped: number;
    total: number;
    finished_at: string | null;
  } | null;
}

export const createBulkRecurring = (b: NewBulkRecurring) =>
  sidecar<{ id?: number; error?: string; message?: string }>("/bulk/recurring", {
    method: "POST",
    ...jbody(b),
  });
export const listBulkRecurring = () =>
  sidecar<{ recurring: BulkRecurringRow[] }>("/bulk/recurring");
export const updateBulkRecurring = (id: number, b: NewBulkRecurring) =>
  sidecar<{ ok?: boolean; error?: string; message?: string }>(`/bulk/recurring/${id}`, {
    method: "PUT",
    ...jbody(b),
  });
export const setBulkRecurringStatus = (id: number, status: BulkRecurringStatus) =>
  sidecar<{ ok?: boolean }>(`/bulk/recurring/${id}/status`, { method: "POST", ...jbody({ status }) });
export const deleteBulkRecurring = (id: number) =>
  sidecar<{ ok?: boolean }>(`/bulk/recurring/${id}`, { method: "DELETE" });
// Dispara fora da agenda; não mexe na trava do dia (a semanal segue valendo).
export const runBulkRecurringNow = (id: number) =>
  sidecar<{ id?: number; error?: string; message?: string }>(`/bulk/recurring/${id}/run`, { method: "POST" });

// --- Planos de ação (isiplan) ---

export interface PlanPreviewItem {
  order_index: number;
  id: string | null;
  type: string;
  summary: string;
  resolution: { count: number; notes: string[] } | null;
}

export interface PlanPreview {
  items: PlanPreviewItem[];
  totals: Record<string, number>;
  webhooks: string[];
}

export interface PlanApplied {
  run_id: number;
  name: string | null;
  status: string;
  at: string;
}

export interface PlanValidation {
  staged_id?: string;
  name?: string;
  preview?: PlanPreview;
  warnings?: string[];
  already_applied?: PlanApplied | null;
  error?: string;
  message?: string;
}

// Upload binário do plano (.isiplan/.zip/.json) → validação + prévia.
export async function validatePlan(file: File): Promise<PlanValidation> {
  if (!cachedInfo) cachedInfo = await getSidecarInfo();
  const buf = await file.arrayBuffer();
  const res = await fetch(`http://127.0.0.1:${cachedInfo.port}/plans/validate`, {
    method: "POST",
    headers: {
      "x-isi-token": cachedInfo.token,
      "content-type": "application/octet-stream",
      "x-filename": encodeURIComponent(file.name),
    },
    body: buf,
  });
  return (await res.json()) as PlanValidation;
}

export const applyPlan = (staged_id: string, confirm_reapply: boolean) =>
  sidecar<{ run_id?: number; error?: string; message?: string; already_applied?: PlanApplied }>("/plans/apply", {
    method: "POST",
    ...jbody({ staged_id, confirm_reapply }),
  });

export type PlanRunStatus = "running" | "done" | "failed" | "canceled";
export type PlanStepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

export interface PlanRunRow {
  id: number;
  plan_id: string | null;
  name: string | null;
  status: PlanRunStatus;
  source: "import" | "mcp";
  total_steps: number;
  created_at: string;
  finished_at: string | null;
  report: { counts?: { done: number; failed: number; skipped: number } };
}

export interface PlanRunStep {
  order_index: number;
  action_id: string | null;
  action_type: string;
  status: PlanStepStatus;
  detail: string | null;
  summary: string;
  result: Record<string, unknown>;
}

export interface PlanRunDetail {
  run: PlanRunRow & { plan_hash: string };
  steps: PlanRunStep[];
}

export const listPlanRuns = () => sidecar<{ runs: PlanRunRow[] }>("/plans/runs");
export const getPlanRun = (id: number) => sidecar<PlanRunDetail>(`/plans/runs/${id}`);
export const cancelPlanRun = (id: number) =>
  sidecar<{ ok?: boolean }>(`/plans/runs/${id}/cancel`, { method: "POST" });
export const getPlanSchema = () => sidecar<Record<string, unknown>>("/plans/schema");

// --- Integração com IA (ponte MCP) ---

export interface IntegrationStatus {
  enabled: boolean;
  file_path: string;
  mcp_script_path: string;
  pending_approvals: number;
}

export const getIntegration = () => sidecar<IntegrationStatus>("/integration");
export const setIntegration = (enabled: boolean) =>
  sidecar<IntegrationStatus>("/integration", { method: "POST", ...jbody({ enabled }) });

export interface Approval {
  id: number;
  source: string;
  tool: string;
  summary: string;
  status: "pending" | "approved" | "denied" | "expired";
  created_at: string;
  decided_at: string | null;
}

export const listApprovals = (status?: string) =>
  sidecar<{ approvals: Approval[] }>(`/integration/approvals${status ? `?status=${status}` : ""}`);
export const decideApproval = (id: number, approve: boolean) =>
  sidecar<{ ok?: boolean; status?: string; error?: string }>(`/integration/approvals/${id}/decide`, {
    method: "POST",
    ...jbody({ approve }),
  });

export interface IntegrationLogRow {
  id: number;
  source: string;
  tool: string;
  summary: string | null;
  approval_id: number | null;
  result: string | null;
  created_at: string;
}

export const getIntegrationLog = () => sidecar<{ log: IntegrationLogRow[] }>("/integration/log");

// --- Agentes de IA (RAG + triagem) ---
// A chave da OpenAI vive no keyring do SO (comandos Tauri abaixo). O front a
// lê e injeta no sidecar a cada arranque; ela nunca é gravada em banco.

export const setOpenAiKey = (key: string) => invoke<string>("set_openai_key", { key });
export const getOpenAiKey = () => invoke<string | null>("get_openai_key");
export const getOpenAiKeyMasked = () => invoke<string | null>("get_openai_key_masked");
export const clearOpenAiKey = () => invoke<void>("clear_openai_key");

export interface AiAgent {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  keywords: string[];
  min_similarity: number;
  use_in_triage: boolean;
  enabled: boolean;
  doc_count?: number;
  chunk_count?: number;
  created_at: string;
  updated_at: string | null;
}

export interface NewAiAgent {
  name: string;
  description?: string;
  system_prompt?: string;
  model?: string;
  keywords?: string[];
  min_similarity?: number;
  use_in_triage?: boolean;
  enabled?: boolean;
}

export type AiDocStatus = "pending" | "indexing" | "ready" | "error";

export interface AiDocument {
  id: number;
  agent_id: number;
  title: string;
  source: "text" | "file" | "url";
  source_ref: string | null;
  status: AiDocStatus;
  error_msg: string | null;
  chunk_count: number;
  content_len: number;
  created_at: string;
  updated_at: string | null;
}

export type AiTriggerMode = "mention" | "match" | "always";

export interface AiBinding {
  id: number;
  target_jid: string;
  group_name: string | null;
  mode: "agent" | "triage";
  agent_id: number | null;
  agent_name: string | null;
  trigger_mode: AiTriggerMode;
  match_type: MatchType | null;
  pattern: string | null;
  case_sensitive: boolean;
  max_hops: number;
  enabled: boolean;
  created_at: string;
}

export interface NewAiBinding {
  target_jid: string;
  mode: "agent" | "triage";
  agent_id?: number;
  trigger_mode: AiTriggerMode;
  match_type?: MatchType;
  pattern?: string;
  case_sensitive?: boolean;
  max_hops?: number;
  enabled?: boolean;
}

export interface AiEvent {
  id: number;
  target_jid: string | null;
  chosen_agent_id: number | null;
  question: string | null;
  route: string | null;
  tried: Array<{ agent_id: number; name: string; reason: string | null; score: number }>;
  hops: number;
  answered: boolean;
  top_similarity: number | null;
  error: string | null;
  created_at: string;
}

export interface AiStatus {
  has_key: boolean;
  masked: string | null;
  agents: number;
  documents: number;
  chunks: number;
  indexing: number;
}

// Injeta a chave no sidecar (memória). Chamado no arranque e ao salvar.
export const pushOpenAiKey = (key: string) =>
  sidecar<{ ok: boolean; masked: string | null }>("/ai/key", { method: "POST", ...jbody({ key }) });
export const validateOpenAiKey = () =>
  sidecar<{ ok: boolean; message?: string }>("/ai/key/validate", { method: "POST" });
export const getAiStatus = () => sidecar<AiStatus>("/ai/status");

export const listAiAgents = () => sidecar<{ agents: AiAgent[] }>("/ai/agents");
export const getAiAgent = (id: number) => sidecar<{ agent: AiAgent }>(`/ai/agents/${id}`);
export const createAiAgent = (b: NewAiAgent) =>
  sidecar<{ id?: number; error?: string; message?: string }>("/ai/agents", { method: "POST", ...jbody(b) });
export const updateAiAgent = (id: number, b: NewAiAgent) =>
  sidecar<{ ok?: boolean; error?: string; message?: string }>(`/ai/agents/${id}`, { method: "PUT", ...jbody(b) });
export const deleteAiAgent = (id: number) =>
  sidecar<{ ok?: boolean }>(`/ai/agents/${id}`, { method: "DELETE" });

export const listAiDocuments = (agentId: number) =>
  sidecar<{ documents: AiDocument[] }>(`/ai/agents/${agentId}/documents`);
export const addAiDocument = (
  agentId: number,
  b: { source: "text" | "file" | "url"; title?: string; content?: string; source_ref?: string }
) =>
  sidecar<{ id?: number; chars?: number; error?: string; message?: string }>(
    `/ai/agents/${agentId}/documents`,
    { method: "POST", ...jbody(b) }
  );
export const deleteAiDocument = (id: number) =>
  sidecar<{ ok?: boolean }>(`/ai/documents/${id}`, { method: "DELETE" });
export const reindexAiDocument = (id: number) =>
  sidecar<{ ok?: boolean; error?: string; message?: string }>(`/ai/documents/${id}/reindex`, { method: "POST" });

// Sobe o ARQUIVO (bytes) para a pasta-sandbox e devolve o caminho aceito pela
// ingestão. O front nunca manda caminho do disco — ver net-guard.mjs.
export const uploadAiFile = (file: File) =>
  file.arrayBuffer().then((buf) =>
    sidecar<{ stored_path: string; name: string; bytes: number }>("/ai/upload", {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
      },
      body: buf,
    })
  );

export const testAiSearch = (agentId: number, question: string) =>
  sidecar<{
    min_similarity: number;
    hits: Array<{ document_id: number; score: number; passa: boolean; trecho: string }>;
    error?: string;
    message?: string;
  }>(`/ai/agents/${agentId}/search`, { method: "POST", ...jbody({ question }) });

export const listAiBindings = () => sidecar<{ bindings: AiBinding[] }>("/ai/bindings");
export const createAiBinding = (b: NewAiBinding) =>
  sidecar<{ id?: number; error?: string; message?: string }>("/ai/bindings", { method: "POST", ...jbody(b) });
export const updateAiBinding = (id: number, b: NewAiBinding) =>
  sidecar<{ ok?: boolean; error?: string; message?: string }>(`/ai/bindings/${id}`, { method: "PUT", ...jbody(b) });
export const deleteAiBinding = (id: number) =>
  sidecar<{ ok?: boolean }>(`/ai/bindings/${id}`, { method: "DELETE" });

export const listAiEvents = (limit = 50) => sidecar<{ events: AiEvent[] }>(`/ai/events?limit=${limit}`);

// --- Exportação da configuração (gera um isiplan importável) ---

export type ExportSection = "schedules" | "automations" | "agents" | "bulk" | "selections" | "accounts";

export interface ExportSummary {
  sections: Record<string, number>;
  available: ExportSection[];
}

export interface ExportResult {
  path: string;
  dir: string;
  filename: string;
  bytes: number;
  warnings: string[];
  counts: Record<string, number>;
  actions: number;
  media_files: number;
  error?: string;
  message?: string;
}

export const getExportSummary = () => sidecar<ExportSummary>("/export/summary");
export const runExport = (b: { sections: ExportSection[]; include_secrets: boolean; name?: string }) =>
  sidecar<ExportResult>("/export", { method: "POST", ...jbody(b) });
