import "./styles.css";
import { initNav } from "./common";
initNav();

// Pricing page: show today's prices as set by MAIZ (the HTML holds the launch prices as a fallback).
const priced = document.querySelectorAll<HTMLElement>("[data-price]");
if (priced.length) {
  void import("./api").then(({ api }) => api<{ prices?: Record<string, number> }>("/store")).then((r) => {
    if (!r.ok || !r.data?.prices) return;
    priced.forEach((el) => {
      const v = r.data!.prices![el.dataset.price!];
      if (typeof v === "number") el.textContent = `£${v.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
    });
  });
}

// Pricing page: compare a part-time hire with the team package. Plain arithmetic, nothing is sent anywhere.
const calc = document.getElementById("calc");
if (calc) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const role = el<HTMLSelectElement>("calc-role");
  const rate = el<HTMLInputElement>("calc-rate");
  const hours = el<HTMLInputElement>("calc-hours");
  const gbp0 = (v: number) => `£${Math.round(v).toLocaleString("en-GB")}`;
  const WEEKS_PER_MONTH = 52 / 12;
  const update = () => {
    const pkg = Number((calc.querySelector<HTMLElement>("[data-price]")?.textContent ?? "").replace(/[^\d.]/g, "")) || 150;
    const r = Math.max(0, Number(rate.value) || 0);
    const h = Math.min(60, Math.max(0, Number(hours.value) || 0));
    const hire = r * h * WEEKS_PER_MONTH;
    el("calc-hire").textContent = gbp0(hire);
    const diff = (hire - pkg) * 12;
    el("calc-save").textContent = diff >= 0 ? gbp0(diff) : `${gbp0(-diff)} more`;
  };
  role.addEventListener("change", () => { rate.value = role.value; update(); });
  rate.addEventListener("input", update);
  hours.addEventListener("input", update);
  update();
}
