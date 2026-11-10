import { describe, expect, test } from "vitest";
import { answerBrief, requestMoreInfo, mayStart, missingInfo, planEnergy, proposalStage, signOff, type TaskProposal } from "../src/modules/workforce/signoff.js";

const base: TaskProposal = {
  title: "Brand kit",
  employee: "Brand and content creator",
  brief: [{ label: "Who you sell to", value: "Home coffee drinkers" }, { label: "Colours you like" }, { label: "Competitors", optional: true }],
  design: "Warm, plain and playful.",
  plan: [{ title: "Three logo directions", energy: 300 }, { title: "Colour and type", energy: 200 }],
  days: 5,
};

describe("sign-off gate for specialised tasks", () => {
  test("lists required information that is missing and ignores optional items", () => {
    expect(missingInfo(base).map((i) => i.label)).toEqual(["Colours you like"]);
  });

  test("refuses sign-off while required information is missing", () => {
    const r = signOff(base, new Date("2026-11-10T10:00:00Z"));
    expect(r).toEqual({ ok: false, reason: "Some information is still missing.", missing: ["Colours you like"] });
    expect(proposalStage(base)).toBe("needs_info");
    expect(mayStart(base)).toBe(false);
  });

  test("treats a blank answer as missing", () => {
    expect(proposalStage(answerBrief(base, "Colours you like", "   "))).toBe("needs_info");
  });

  test("is ready for sign-off once everything required is answered, and still may not start", () => {
    const ready = answerBrief(base, "Colours you like", "Deep green");
    expect(proposalStage(ready)).toBe("ready_for_sign_off");
    expect(mayStart(ready)).toBe(false);
    expect(base.brief[1]!.value).toBeUndefined();
  });

  test("starts only after the owner signs off", () => {
    const r = signOff(answerBrief(base, "Colours you like", "Deep green"), new Date("2026-11-10T10:00:00Z"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.signedOffAt).toBe("2026-11-10T10:00:00.000Z");
    expect(mayStart(r.proposal)).toBe(true);
    expect(signOff(r.proposal, new Date()).ok).toBe(false);
  });

  test("refuses sign-off without a design or a plan", () => {
    const full = answerBrief(base, "Colours you like", "Deep green");
    expect(signOff({ ...full, plan: [] }, new Date()).ok).toBe(false);
    expect(signOff({ ...full, design: " " }, new Date()).ok).toBe(false);
  });

  test("adds up the plan's energy", () => {
    expect(planEnergy(base)).toBe(500);
  });

  test("needs the owner to choose a direction when the employee offers several", () => {
    const withDirections: TaskProposal = { ...answerBrief(base, "Colours you like", "Deep green"), directions: [{ key: "a", name: "Refresh", summary: "Keep the logo." }, { key: "b", name: "Rebrand", summary: "New logo." }] };
    expect(signOff(withDirections, new Date())).toMatchObject({ ok: false, reason: "Choose which direction to take first." });
    expect(signOff(withDirections, new Date(), "nope").ok).toBe(false);
    const r = signOff(withDirections, new Date(), "b");
    expect(r.ok && r.proposal.chosenDirection).toBe("b");
  });

  test("asking for more information sends the brief back and blocks sign-off until answered", () => {
    const ready = answerBrief(base, "Colours you like", "Deep green");
    const asked = requestMoreInfo(ready, "What do the two main competitors charge?");
    expect(proposalStage(asked)).toBe("needs_info");
    expect(missingInfo(asked)).toEqual([{ label: "What do the two main competitors charge?", from: "specialist" }]);
    expect(signOff(asked, new Date()).ok).toBe(false);
    expect(proposalStage(answerBrief(asked, "What do the two main competitors charge?", "£8 and £9.50 a bag"))).toBe("ready_for_sign_off");
    expect(requestMoreInfo(ready, "  ")).toBe(ready);
  });
});
