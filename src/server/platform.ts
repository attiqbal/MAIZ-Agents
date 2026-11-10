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
import { AdminManager } from "../modules/admin-manager/index.js";
import { InMemoryModelProvisioner, InMemoryStorageProvisioner } from "../modules/admin-manager/provisioning.js";
import { OnboardingService } from "../modules/onboarding/index.js";
import { WorkforceService } from "../modules/workforce/index.js";
import { IntegrationService, defaultRegistry, type OAuthApp } from "../modules/integrations/index.js";
import { QualityReviewService } from "../modules/review/index.js";
import { PriceBook } from "../modules/pricing/index.js";
import { SpecialistReviewService } from "../modules/review/specialists.js";

import { ConsoleEmailSender, type EmailSender } from "./email.js";
import { userIdFor } from "./identity.js";

export interface PlatformConfig {
  anthropicApiKey?: string;
  anthropicModel?: string;
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
  const gateway = new ModelGateway([
    cfg.anthropicApiKey ? new AnthropicAdapter(cfg.anthropicApiKey, cfg.anthropicModel ?? "claude-haiku-5-5") : new MockAdapter(),
  ]);
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
  const onboarding = new OnboardingService(identity, workforce, ledger, energy, audit, now, () => {
    const g = prices.general();
    return { days: g.trialDays, dailyEnergy: g.defaultDailyEnergyPerEmployee };
  });
  const router = new ChannelRouter(identity, workforce, audit);
  /** Business apps (tills, payroll). Employees get only the app data the owner granted them. */
  const integrations = new IntegrationService(identity, audit, ledger, defaultRegistry(), { http: cfg.http, now, oauthApps: cfg.integrationApps });
  workforce.addContext((ws, templateKey) => integrations.contextFor(ws, templateKey));
  /** Welcomes new owners and runs setup. Storage and models are stand-ins until real RunPod/bucket provisioning is wired in. */
  const admin = new AdminManager(identity, workforce, audit, bus, new InMemoryStorageProvisioner(), new InMemoryModelProvisioner(), router, { now });
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
  const specialists = new SpecialistReviewService(identity, audit, isPlatformOwner, (tier) => {
    const g = prices.general();
    return tier === "premium" ? g.specialistPremiumMonthlyGbp : g.specialistStandardMonthlyGbp;
  }, {
    now,
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
        openReviews: openReviews.get(w.id) ?? 0,
        specialistsToReview: openSpecialists.get(w.id) ?? 0,
      };
    }).sort((a, b) => Number(b.setup === "needs_attention") - Number(a.setup === "needs_attention") || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  };
  /**
   * A setup that could not undo itself needs a person. The Admin manager tells the client that MAIZ
   * has been alerted, so this is where the platform owner actually is.
   */
  const alertOwners = async (subject: string, text: string) => {
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
    sink = store;
    for (const part of [audit, identity, energy, workforce, ledger, router, admin, integrations, reviews, prices, specialists]) part.useSink(store);
  }

  const healthy = () => (sink as { healthy?: boolean } | undefined)?.healthy !== false;

  /** Sign-in links already used. In memory: a restart inside the 15-minute life of a link would allow one reuse. */
  const usedLinks = new Set<string>();
  /** Sign-in emails sent per address and hour, to stop the form being used to spam someone. */
  const sends = new Map<string, number[]>();
  return { email, usedLinks, sends, admin, reviews, prices, specialists, clients, isPlatformOwner, healthy, cfg, now, audit, bus, identity, energy, workforce, ledger, onboarding, router, integrations, slackTokens, saveSlackToken, attachStore };
}
export type Platform = ReturnType<typeof createPlatform>;
