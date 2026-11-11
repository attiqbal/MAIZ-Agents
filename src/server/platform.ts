import type { Sink } from "../core/persistence.js";
import { EventBus } from "../core/events.js";
import { AuditLog } from "../modules/audit/index.js";
import { ChannelRouter, SlackChannel } from "../modules/channels/index.js";
import { EnergyMeter } from "../modules/energy/index.js";
import { IdentityService, PermissionError } from "../modules/identity/index.js";
import { Ledger } from "../modules/ledger/index.js";
import { AnthropicAdapter } from "../modules/model-gateway/adapters/anthropic.js";
import { MockAdapter } from "../modules/model-gateway/adapters/mock.js";
import { ModelGateway } from "../modules/model-gateway/gateway.js";
import { RunPodAdapter } from "../modules/model-gateway/adapters/runpod.js";
import { RoutingGateway } from "../modules/model-gateway/routing/router.js";
import { SpendLedger } from "../modules/model-gateway/routing/ledger.js";
import { RoutingSettingsStore, defaultSettings } from "../modules/model-gateway/routing/settings.js";
import type { Completer } from "../modules/model-gateway/types.js";
import { AdminManager } from "../modules/admin-manager/index.js";
import { InMemoryModelProvisioner, InMemoryStorageProvisioner } from "../modules/admin-manager/provisioning.js";
import { OnboardingService } from "../modules/onboarding/index.js";
import { BatchService } from "../modules/batch/service.js";
import { WorkforceService } from "../modules/workforce/index.js";
import { IntegrationService, defaultRegistry, type OAuthApp } from "../modules/integrations/index.js";
import { QualityReviewService } from "../modules/review/index.js";
import { PriceBook } from "../modules/pricing/index.js";
import { SpecialistReviewService, type SpecialistRequest } from "../modules/review/specialists.js";
import { templateFromRole } from "../modules/workforce/templates.js";
import { MockPaymentProvider, PaymentService, type PaymentProvider } from "../modules/payments/index.js";
import { quote } from "../modules/store/cart.js";
import { ReconciliationService } from "../modules/reconciliation/index.js";
import { localParts } from "../modules/batch/schedule.js";
import { RotaService } from "../modules/rota/index.js";

import { ConsoleEmailSender, type EmailSender } from "./email.js";
import { userIdFor } from "./identity.js";
import { ExpiringSet, SendLog } from "./expiring.js";

export interface PlatformConfig {
  anthropicApiKey?: string;
  anthropicModel?: string;
  /** RunPod Serverless endpoint (vLLM worker) that does the heavy lifting. Both come from environment variables. */
  runpod?: { apiKey: string; endpointId: string };
  sessionSecret: string;
  /** Where sign-in emails come from. Defaults to printing them (development). */
  email?: EmailSender;
  /** Public address of the website, used in sign-in links. */
  appUrl?: string;
  /** Dev-only sign-in by email, no verification. Must stay off in production. */
  allowDevAuth: boolean;
  slack?: { clientId: string; clientSecret: string; signingSecret: string; redirectUri: string };
  /** Our OAuth app for each connector that has one (for example square), from environment variables. */
  integrationApps?: Record<string, OAuthApp>;
  /**
   * Emails of the MAIZ platform owner(s), from PLATFORM_OWNER_EMAILS. Only they see the quality review
   * queue and sign off specialised tasks. Clients can never approve their own.
   */
  platformOwners?: readonly string[];
  /**
   * Takes payments. Leave out for no charging: checkout is then refused. Development (allowDevAuth) defaults to a
   * mock provider that charges nobody. A real provider (Stripe) is a class implementing PaymentProvider.
   */
  payments?: PaymentProvider;
  now?: () => Date;
  http?: typeof fetch;
}

/** Wires every module together. One place, so the server and tests build the same system. */
export function createPlatform(cfg: PlatformConfig) {
  const now = cfg.now ?? (() => new Date());
  const audit = new AuditLog();
  const bus = new EventBus();
  const identity = new IdentityService(audit, bus);
  const energy = new EnergyMeter(identity, audit, now);
  /**
   * Open models on RunPod do the work and Claude supervises (see model-gateway/routing). Everything about it,
   * models, thresholds and caps included, is editable by the platform owner. Without any key the answers are mocks.
   */
  const aiSettings = new RoutingSettingsStore(defaultSettings(cfg.anthropicModel ?? "claude-haiku-5-5"));
  const spend = new SpendLedger(now);
  const runpod = cfg.runpod ? new RunPodAdapter(cfg.runpod.apiKey, cfg.runpod.endpointId, aiSettings.get().runpod.model, cfg.http) : undefined;
  const claude = cfg.anthropicApiKey ? new AnthropicAdapter(cfg.anthropicApiKey, cfg.anthropicModel ?? "claude-haiku-5-5", cfg.http) : undefined;
  const routing = runpod || claude ? new RoutingGateway({ settings: aiSettings, ledger: spend, runpod, claude, now: () => now().getTime() }) : undefined;
  const gateway: Completer = routing ?? new ModelGateway([new MockAdapter()]);
  const workforce = new WorkforceService(identity, audit, bus, gateway, energy);
  const ledger = new Ledger(identity, audit);
  const ownerEmailsEarly = (cfg.platformOwners ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const ownerIdSet = new Set(ownerEmailsEarly.map(userIdFor));
  /** Prices, trial terms and per-agent energy, set by the platform owner on the Prices page. */
  const prices = new PriceBook((userId) => ownerIdSet.has(userId), now);
  energy.setQuotaResolver((_ws, employeeId) => {
    const key = workforce.templateOf(employeeId);
    return key ? prices.agentAllowance(key) : undefined;
  });
  // Add-on employees and specialists add their weekly energy to a paid team pool.
  energy.setPoolBonusResolver((ws) => workforce.templatesIn(ws).reduce((sum, key) => sum + prices.weeklyEnergyFor(key), 0));
  const onboarding = new OnboardingService(identity, workforce, ledger, energy, audit, now, () => {
    const g = prices.general();
    return { days: g.trialDays, teamEnergy: g.trialTeamEnergy, dailyTeamCeiling: g.dailyTeamCeiling };
  });
  const router = new ChannelRouter(identity, workforce, audit);
  /** Business apps (tills, payroll). Employees get only the app data the owner granted them. */
  const integrations = new IntegrationService(identity, audit, ledger, defaultRegistry(), { http: cfg.http, now, oauthApps: cfg.integrationApps });
  workforce.addContext((ws, templateKey) => integrations.contextFor(ws, templateKey));
  /** Welcomes new owners and runs setup. Storage and models are stand-ins until real RunPod/bucket provisioning is wired in. */
  const admin = new AdminManager(identity, workforce, audit, bus, new InMemoryStorageProvisioner(), new InMemoryModelProvisioner(), router, { now });
  /** Batch work: compiled during the day, sent to the pod at each client's closing time or when enough has gathered. */
  const batch = new BatchService({ identity, audit, workforce, settings: aiSettings, ledger: spend, isPlatformOwner: (id) => ownerIdSet.has(id), notify: (ws, text, link) => admin.tell(ws, text, link), now });
  workforce.setIntake(batch);
  workforce.addContext((ws, templateKey, taskType) => batch.contextFor(ws, templateKey, taskType));
  const email = cfg.email ?? new ConsoleEmailSender();
  const base = (cfg.appUrl ?? "").replace(/\/$/, "");
  /** Signed-in user ids of the platform owners (the same id the session carries). */
  const ownerEmails = ownerEmailsEarly;
  const isPlatformOwner = (userId: string) => ownerIdSet.has(userId);
  /** MAIZ quality review: every client's specialised tasks wait here for the platform owner's sign-off. */
  const reviews = new QualityReviewService(identity, audit, isPlatformOwner, {
    now,
    notifyOwner: async (item, clientName) => {
      for (const to of ownerEmails) {
        await email.send({
          to,
          subject: `Quality review: ${item.proposal.title} for ${clientName}`,
          text: `${clientName}'s ${item.proposal.employee} has compiled a brief for "${item.proposal.title}" and it is waiting for your sign-off.\n\nApprove a direction or ask for more information:\n${base}/review.html#${item.id}\n\nThe client sees "In quality review" until you decide.`,
        });
      }
    },
    notifyClient: async (item) => {
      const chosen = item.proposal.directions?.find((d) => d.key === item.proposal.chosenDirection);
      await admin.tell(item.workspaceId, `"${item.proposal.title}" passed quality review${chosen ? ` (direction: ${chosen.name})` : ""}. Your ${item.proposal.employee} has started the work.${item.noteToClient ? ` Note from MAIZ: ${item.noteToClient}` : ""}`, "/app.html#work");
    },
  });
  /** New custom specialists: drafted for the client, checked and priced by the platform owner before training. */
  /** A custom specialist's template: its approved role and job description, usable only by the client that asked for it. */
  const customTemplateOf = (r: SpecialistRequest) => ({ ...templateFromRole(r.role, `custom-${r.id}`), jobDescription: r.jobDescription });
  const specialists = new SpecialistReviewService(identity, audit, isPlatformOwner, (tier) => {
    const g = prices.general();
    return tier === "premium" ? g.specialistPremiumMonthlyGbp : g.specialistStandardMonthlyGbp;
  }, {
    now,
    hire: async (userId, r) => {
      const t = customTemplateOf(r);
      workforce.registerCustomTemplate(r.workspaceId, t);
      return workforce.hire(userId, r.workspaceId, t.key);
    },
    notifyOwner: async (r, clientName) => {
      for (const to of ownerEmails) {
        await email.send({ to, subject: `New specialist to review: ${r.role.title} for ${clientName}`, text: `${clientName} asked for a new custom specialist, "${r.role.title}". The Admin manager drafted the job description; nothing is trained until you approve it.\n\nReview it:\n${base}/owner-specialists.html#${r.id}` });
      }
    },
    notifyClient: async (r) => {
      const text = r.status === "approved"
        ? `MAIZ approved your new specialist "${r.role.title}" at £${r.priceGbp} a month. It is ready to hire.`
        : r.status === "changes_requested"
          ? `MAIZ reviewed your new specialist "${r.role.title}" and asked for changes: ${r.messageToClient}`
          : `MAIZ will not offer the specialist "${r.role.title}": ${r.messageToClient}`;
      await admin.tell(r.workspaceId, text, "/app.html#team");
    },
  });

  let alertOwnersLate: (subject: string, text: string) => Promise<void> = async () => undefined;
  /** Staff and shifts, so rota questions are answered from real records. */
  const rota = new RotaService(identity, audit);
  workforce.addContext((ws, templateKey) => rota.contextFor(ws, templateKey, now().toISOString().slice(0, 10)));
  /** Checkout and orders. What a paid order buys is hired here, from the same templates the store sells. */
  const payments = new PaymentService(identity, audit, {
    provider: cfg.payments ?? (cfg.allowDevAuth ? new MockPaymentProvider() : undefined),
    quote: (lines) => quote(lines, prices.catalogue()),
    appUrl: base,
    customerEmail: (userId) => identity.workspacesFor(userId).map((w) => w.ownerEmail).find(Boolean),
    now,
    alert: (subject, text) => alertOwnersLate(subject, text),
    fulfil: async (order) => {
      const ids: string[] = [];
      for (const line of order.lines) {
        // A consultant line is "consultant:pass"; the employee template is the part before the colon.
        const templateKey = line.key.split(":")[0]!;
        for (let i = 0; i < line.qty; i++) ids.push((await workforce.hire(order.userId, order.workspaceId, templateKey)).id);
      }
      return ids;
    },
  });

  /** Nightly check of every client's books, run once after each client's own midnight (their batch time zone). */
  const reconciliation = new ReconciliationService({
    workspaceIds: () => identity.allWorkspaces().map((w) => w.id),
    localDate: (ws) => {
      const l = localParts(now(), batch.scheduleOf(ws).timezone);
      return `${l.y}-${String(l.m).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
    },
    books: (ws) => ledger.rawBooks(ws),
    records: (ws) => integrations.recordsOf(ws),
    orders: (ws) => payments.all().filter((o) => o.workspaceId === ws),
    now,
    alert: async (ws, report) => {
      const name = identity.workspaceById(ws)?.name ?? ws;
      const errors = report.findings.filter((f) => f.severity === "error");
      await alertOwnersLate(`Books need a look: ${name}`, `Tonight's check of ${name}'s books found ${errors.length} problem(s):\n\n${errors.map((f) => `- ${f.message}`).join("\n")}\n\nNothing was changed. Details: ${base}/owner-clients.html`);
    },
  });

  /**
   * The client's control center, from real records: each employee's energy, the task board and the week's totals.
   * Everything is read through the services, so permissions and workspace walls apply.
   */
  const dashboard = (userId: string, workspaceId: string) => {
    const nowDate = now();
    const weekAgo = new Date(nowDate.getTime() - 7 * 86_400_000).toISOString();
    const team = workforce.team(userId, workspaceId);
    const energyDays = energy.recentDays(userId, workspaceId, 7);
    const done = workforce.tasksSince(userId, workspaceId, weekAgo).filter((t) => t.status === "ready_for_review");
    const open = batch.openJobsOf(workspaceId);
    const label = (id: string) => team.find((e) => e.id === id)?.name ?? "Employee";
    const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    const people = team.map((e) => {
      const allowance = energy.quotaOf(userId, workspaceId, e.id);
      const week = energyDays.byEmployee.get(e.id) ?? new Array(7).fill(0);
      const mine = open.filter((j) => j.employeeId === e.id);
      const running = mine.find((j) => j.status === "running") ?? mine[0];
      return {
        id: e.id, name: e.name, templateKey: e.templateKey, allowance, usedToday: week[6] as number, week,
        doneWeek: done.filter((t) => t.employeeId === e.id).length,
        status: running ? "working" : "idle",
        doing: running ? clip(running.brief, 100) : null,
      };
    });
    const reviewsNeedingYou = reviews.forClient(userId, workspaceId).filter((r) => r.status === "gathering_info" || r.status === "more_info_requested");
    const inReview = reviews.forClient(userId, workspaceId).filter((r) => r.status === "in_review").length;
    const tasks = [
      ...open.filter((j) => j.status === "queued").map((j) => ({ id: j.id, employeeId: j.employeeId, title: clip(j.brief, 80), column: "planned" as const, runsAt: j.runsAt })),
      ...open.filter((j) => j.status === "running").map((j) => ({ id: j.id, employeeId: j.employeeId, title: clip(j.brief, 80), column: "in_progress" as const })),
      ...reviewsNeedingYou.map((r) => ({ id: r.id, employeeId: null, title: r.title, column: "waiting" as const, note: "Needs your answers" })),
      ...done.slice(0, 40).map((t) => ({ id: t.id, employeeId: t.employeeId, title: clip(t.brief, 80), column: "done" as const, energy: t.energyUsed ?? 0, at: t.at })),
    ];
    const use = energy.usageOf(workspaceId);
    const sched = batch.forClient(userId, workspaceId);
    // The team's shared pool (null on older per-employee plans): what the dashboard shows as the allowance.
    const teamEnergy = energy.teamEnergy(userId, workspaceId) ?? null;
    return {
      asOf: nowDate.toISOString(),
      team: people,
      teamEnergy,
      tasks: tasks.map((t) => ({ ...t, employeeName: t.employeeId ? label(t.employeeId) : null })),
      totals: {
        energyToday: use.energyToday,
        allowanceToday: teamEnergy ? teamEnergy.leftToday + use.energyToday : people.reduce((n, e) => n + e.allowance, 0),
        energyWeek: people.reduce((n, e) => n + e.week.reduce((a: number, b: number) => a + b, 0), 0), energyMonth: use.energyMonth,
        queued: sched.queued, waitingOnYou: reviewsNeedingYou.length, inReview, doneWeek: done.length,
        nextRunLabel: sched.nextRunLabel,
      },
    };
  };

  /** The platform owner's AI spend and routing controls. Nothing here is visible to clients. */
  const ai = {
    overview: (userId: string) => {
      if (!ownerIdSet.has(userId)) throw new PermissionError("only the platform owner sees AI spend");
      return { configured: { runpod: !!runpod, claude: !!claude }, status: routing?.status() ?? null, settings: aiSettings.get(), ...spend.summary(30), cacheable: aiSettings.get().cache.enabled };
    },
    health: async (userId: string) => {
      if (!ownerIdSet.has(userId)) throw new PermissionError("only the platform owner sees AI spend");
      return runpod ? runpod.health() : { reachable: false, error: "RunPod is not configured (RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID)" };
    },
    update: (userId: string, patch: unknown) => {
      if (!ownerIdSet.has(userId)) throw new PermissionError("only the platform owner changes AI settings");
      return aiSettings.update(patch);
    },
  };

  /** The platform owner's clients screen: every client at a glance. */
  const clients = (userId: string) => {
    if (!isPlatformOwner(userId)) throw new PermissionError("only the platform owner sees all clients");
    const nowIso = now().toISOString();
    const openReviews = new Map<string, number>();
    for (const r of reviews.queue(userId)) if (r.status !== "approved") openReviews.set(r.workspaceId, (openReviews.get(r.workspaceId) ?? 0) + 1);
    const openSpecialists = new Map<string, number>();
    for (const r of specialists.queue(userId)) if (r.status === "in_review") openSpecialists.set(r.workspaceId, (openSpecialists.get(r.workspaceId) ?? 0) + 1);
    return identity.allWorkspaces().map((w) => {
      const plan = energy.planOf(w.id);
      const use = energy.usageOf(w.id);
      return {
        id: w.id,
        name: w.name,
        ownerEmail: w.ownerEmail ?? null,
        createdAt: w.createdAt ?? null,
        trialEndsAt: plan.expiresAt ?? null,
        status: plan.expiresAt && plan.expiresAt < nowIso ? "trial_ended" : plan.expiresAt ? "trial" : "active",
        setup: admin.setupStateOf(w.id) ?? "not_started",
        employees: workforce.countIn(w.id),
        energyToday: use.energyToday,
        energyMonth: use.energyMonth,
        /** What MAIZ paid model providers this month, in US dollars. */
        aiCostUsdMonth: Math.round(use.costMicroMonth / 10_000) / 100,
        /** Last nightly check of this client's books: ok, problems found, or not run yet. */
        books: (() => { const r = reconciliation.latestFor(w.id); return r ? { ok: r.ok, date: r.date, problems: r.findings.filter((f) => f.severity === "error").length, warnings: r.findings.filter((f) => f.severity === "warn").length } : null; })(),
        openReviews: openReviews.get(w.id) ?? 0,
        specialistsToReview: openSpecialists.get(w.id) ?? 0,
      };
    }).sort((a, b) => Number(b.setup === "needs_attention") - Number(a.setup === "needs_attention") || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  };
  /**
   * A setup that could not undo itself needs a person. The Admin manager tells the client that MAIZ
   * has been alerted, so this is where the platform owner actually is.
   */
  const alertOwners = alertOwnersLate = async (subject: string, text: string) => {
    for (const to of ownerEmails) await email.send({ to, subject, text }).catch((e) => console.error("owner alert failed:", e));
    if (!ownerEmails.length) console.error(`platform alert (no PLATFORM_OWNER_EMAILS set): ${subject}`);
  };
  for (const type of ["setup.failed", "setup.rolled_back"]) {
    bus.on(type, async (e) => {
      const status = (e.payload as { status?: string }).status;
      if (status !== "rollback_failed") return;
      const client = identity.workspaceById(e.workspaceId)?.name ?? e.workspaceId;
      await alertOwners(`Setup needs you: ${client}`, `${client}'s setup stopped and could not undo every step (${type}). The client was told MAIZ has been alerted and does not need to do anything.\n\nWorkspace: ${e.workspaceId}\nThe audit log has each step's result.`);
    });
  }
  /** Bot tokens by Slack team. Held in memory for now; encrypted storage comes with Postgres wiring. */
  const slackTokens = new Map<string, string>();
  router.register(new SlackChannel((team) => slackTokens.get(team) ?? "", cfg.http));
  /** Remember a Slack bot token (and store it encrypted when storage is on). */
  let sink: (Sink & { flush(): Promise<void> }) | undefined;
  const saveSlackToken = (workspaceId: string, team: string, token: string) => {
    slackTokens.set(team, token);
    sink?.slackToken(workspaceId, team, token);
  };

  /**
   * Turn on durable storage: load everything saved, put it back into the services,
   * then start writing every new change behind them. Call once, before serving.
   */
  async function attachStore(store: Sink & { flush(): Promise<void>; load(): Promise<import("../core/persistence.js").Snapshot> }): Promise<void> {
    const s = await store.load();
    for (const w of s.workspaces) identity.restoreWorkspace(w);
    for (const m of s.memberships) identity.restoreMember(m.workspaceId, m.userId, m.role);
    for (const e of s.employees) workforce.restoreEmployee(e);
    for (const x of s.profiles) workforce.restoreProfile(x.workspaceId, x.profile);
    for (const t of s.training) workforce.restoreTraining(t.employeeId, t.notes);
    for (const r of s.adminOrgs) admin.restoreOrg(r);
    for (const m of s.adminMessages) admin.restoreMessage(m);
    for (const x of s.accounts) ledger.restoreAccount(x.workspaceId, x.account);
    for (const e of s.entries) ledger.restoreEntry(e);
    for (const u of s.usage) energy.restoreUsage(u);
    for (const x of s.plans) energy.restorePlan(x.workspaceId, x.plan);
    for (const a of s.audit) audit.restore(a);
    for (const c of s.connections) router.restoreConnection(c);
    for (const l of s.links) router.restoreLink(l.key, l.userId);
    for (const t of s.slackTokens) slackTokens.set(t.team, t.token);
    for (const c of s.integrations ?? []) integrations.restoreConnection(c);
    for (const x of s.integrationSecrets ?? []) integrations.restoreSecret(x.connectionId, x.secret);
    for (const r of s.integrationRecords ?? []) integrations.restoreRecord(r);
    for (const r of s.reviews ?? []) reviews.restore(r);
    for (const c of s.priceChanges ?? []) prices.restore(c);
    for (const r of s.specialistRequests ?? []) specialists.restore(r);
    for (const x of s.records ?? []) {
      if (x.kind === "order") payments.restore(x.data);
      else if (x.kind === "recon") reconciliation.restore(x.data);
      else if (x.kind === "task") workforce.restoreTask(x.data);
      else if (x.kind === "rota_staff") rota.restoreStaff(x.data);
      else if (x.kind === "rota_shift" && !x.data.removed) rota.restoreShift(x.data);
    }
    for (const r of specialists.approved()) workforce.registerCustomTemplate(r.workspaceId, customTemplateOf(r));
    if (s.aiSettings) aiSettings.restore(s.aiSettings);
    for (const d of s.aiDays ?? []) spend.restore(d);
    for (const x of s.batchSchedules ?? []) batch.restoreSchedule(x.workspaceId, x.schedule);
    for (const j of s.batchJobs ?? []) batch.restoreJob(j);
    for (const r of s.batchRuns ?? []) batch.restoreRun(r);
    sink = store;
    for (const part of [audit, identity, energy, workforce, ledger, router, admin, integrations, reviews, prices, specialists, aiSettings, spend, batch, payments, rota, reconciliation]) part.useSink(store);
  }

  const healthy = () => (sink as { healthy?: boolean } | undefined)?.healthy !== false;

  /**
   * One-time links already used, kept only until the link itself expires. In memory: a restart inside the
   * 15-minute life of a link would allow one reuse.
   */
  const usedLinks = new ExpiringSet(() => now().getTime());
  /** Sign-in emails sent per address and hour, to stop the form being used to spam someone. */
  const sends = new SendLog();
  return { dashboard, reconciliation, rota, payments, batch, email, usedLinks, sends, admin, reviews, prices, specialists, ai, clients, isPlatformOwner, healthy, cfg, now, audit, bus, identity, energy, workforce, ledger, onboarding, router, integrations, slackTokens, saveSlackToken, attachStore };
}
export type Platform = ReturnType<typeof createPlatform>;
